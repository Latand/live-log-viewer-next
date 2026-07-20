import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { latestAttempt } from "../pipelines/pipelineModel";
import type { TaskTone } from "./taskModel";

/*
 * Readiness read-model for the board's Kanban strip (issue #290).
 *
 * Every project task classifies into exactly one of five readiness sections.
 * The classification is a pure function of one /api/files snapshot — durable
 * task status, assignment states, linked pipeline/flow states and persisted
 * verdict evidence. No wall-clock, no scanner liveness: reload, restart,
 * alias remap and deleted worktrees all reproduce the same partition.
 * Liveness (live/gone/spawning) is a chip decoration, never a section.
 */

export type Readiness = "now" | "review" | "blocked" | "planned" | "done";

/** Fixed section order — DOM order equals visual order equals this. */
export const READINESS_ORDER: readonly Readiness[] = ["now", "review", "blocked", "planned", "done"];

export const READINESS_TONES: Record<Readiness, TaskTone> = {
  now: { color: "var(--color-accent)", soft: "var(--color-accent-soft)" },
  review: { color: "var(--color-info)", soft: "var(--color-info-soft)" },
  blocked: { color: "var(--color-danger)", soft: "var(--color-danger-soft)" },
  planned: { color: "var(--color-warning)", soft: "var(--color-warning-soft)" },
  done: { color: "var(--color-success)", soft: "var(--color-success-soft)" },
};

export interface ReadinessLinks {
  pipelines: Pipeline[];
  flows: Flow[];
}

/** Assignment → orchestration link index over one response snapshot. Keys are
    canonical conversation ids and transcript paths; the alias map is applied
    on BOTH sides (index build and lookup), so pre- and post-remap snapshots
    resolve identically. */
export interface ReadinessIndex {
  byConversationId: ReadonlyMap<string, ReadinessLinks>;
  byPath: ReadonlyMap<string, ReadinessLinks>;
  aliases: Readonly<Record<string, string>>;
}

const canonicalId = (id: string, aliases: Readonly<Record<string, string>>): string => aliases[id] ?? id;

export function buildReadinessIndex(
  pipelines: readonly Pipeline[],
  flows: readonly Flow[],
  aliases: Readonly<Record<string, string>> = {},
): ReadinessIndex {
  const byConversationId = new Map<string, ReadinessLinks>();
  const byPath = new Map<string, ReadinessLinks>();
  const linksAt = <K,>(map: Map<K, ReadinessLinks>, key: K): ReadinessLinks => {
    const existing = map.get(key);
    if (existing) return existing;
    const created: ReadinessLinks = { pipelines: [], flows: [] };
    map.set(key, created);
    return created;
  };
  const addId = (raw: string | null | undefined, add: (links: ReadinessLinks) => void) => {
    if (raw) add(linksAt(byConversationId, canonicalId(raw, aliases)));
  };
  const addPath = (raw: string | null | undefined, add: (links: ReadinessLinks) => void) => {
    if (raw) add(linksAt(byPath, raw));
  };
  for (const pipeline of pipelines) {
    const add = (links: ReadinessLinks) => {
      if (!links.pipelines.includes(pipeline)) links.pipelines.push(pipeline);
    };
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        addId(attempt.conversationId, add);
        addPath(attempt.agentPath, add);
      }
    }
  }
  for (const flow of flows) {
    const add = (links: ReadinessLinks) => {
      if (!links.flows.includes(flow)) links.flows.push(flow);
    };
    addId(flow.implementerConversationId, add);
    addPath(flow.implementerPath, add);
    for (const round of flow.rounds) {
      addId(round.reviewerConversationId, add);
      addPath(round.reviewerPath, add);
    }
  }
  return { byConversationId, byPath, aliases };
}

/** Same-project pipelines/flows any of the task's assignments link to. Paused
    containers are a deliberate operator state — they contribute no readiness
    signal, so the task falls through to its durable status rules. */
export function taskLinks(task: BoardTask, index: ReadinessIndex): ReadinessLinks {
  const pipelines = new Set<Pipeline>();
  const flows = new Set<Flow>();
  const collect = (links: ReadinessLinks | undefined) => {
    if (!links) return;
    for (const pipeline of links.pipelines) {
      if (pipeline.project === task.project && pipeline.state !== "paused") pipelines.add(pipeline);
    }
    for (const flow of links.flows) {
      if (flow.project === task.project && flow.state !== "paused") flows.add(flow);
    }
  };
  for (const assignment of task.assignments) {
    if (assignment.conversationId) collect(index.byConversationId.get(canonicalId(assignment.conversationId, index.aliases)));
    if (assignment.path) collect(index.byPath.get(assignment.path));
  }
  return { pipelines: [...pipelines], flows: [...flows] };
}

/** Latest operational attempt of the last stage that ran anything, in stage order. */
function lastAttemptedVerdictPass(pipeline: Pipeline): boolean {
  let last: PipelineStageAttempt | undefined;
  for (const stage of pipeline.stages) {
    const attempt = latestAttempt(pipeline, stage.id);
    if (attempt) last = attempt;
  }
  return last?.verdict?.status === "pass";
}

function pipelineInReview(pipeline: Pipeline): boolean {
  return pipeline.cursor?.state === "reviewing" || pipeline.state === "completed" || lastAttemptedVerdictPass(pipeline);
}

const FLOW_REVIEW_STATES: ReadonlySet<Flow["state"]> = new Set([
  "reviewing",
  "relay_pending",
  "relaying",
  "fixing",
  "approved",
  "done_comment",
]);

function flowInReview(flow: Flow): boolean {
  return FLOW_REVIEW_STATES.has(flow.state) || flow.rounds.at(-1)?.verdict === "APPROVE";
}

/** First match wins: done > blocked > review > now > planned. */
export function taskReadiness(task: BoardTask, index: ReadinessIndex): Readiness {
  if (task.status === "done") return "done";
  const links = taskLinks(task, index);
  if (
    task.status === "blocked" ||
    task.assignments.some((assignment) => assignment.state === "failed") ||
    links.pipelines.some((pipeline) => pipeline.state === "needs_decision") ||
    links.flows.some((flow) => flow.state === "needs_decision")
  ) {
    return "blocked";
  }
  if (links.pipelines.some(pipelineInReview) || links.flows.some(flowInReview)) return "review";
  if (task.status === "assigned") return "now";
  return "planned";
}

export interface ReadinessSection {
  readiness: Readiness;
  /** Section members, freshest first (updatedAt desc, tie id asc). */
  items: BoardTask[];
}

/** Always all five sections, zero counts included, in READINESS_ORDER. */
export function partitionReadiness(tasks: readonly BoardTask[], index: ReadinessIndex): ReadinessSection[] {
  const byReadiness = new Map<Readiness, BoardTask[]>(READINESS_ORDER.map((readiness) => [readiness, []]));
  for (const task of tasks) byReadiness.get(taskReadiness(task, index))!.push(task);
  return READINESS_ORDER.map((readiness) => {
    const items = byReadiness.get(readiness)!;
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
    return { readiness, items };
  });
}

/** GitHub issue references in the task text: `#290` counts, `PR#165` and
    `path/#1` do not. Deduped, ascending. */
export function issueRefs(text: string): number[] {
  const refs = new Set<number>();
  for (const match of text.matchAll(/(?<![\w/])#(\d{1,6})\b/g)) refs.add(Number(match[1]));
  return [...refs].sort((a, b) => a - b);
}
