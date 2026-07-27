import { monitorRefIn } from "./cards";
import { redactBounded } from "./redact";
import type { EvidenceItem, EvidenceState } from "./types";
import type { FlowSummary, PipelineSummary, TaskSummary } from "./viewerApi";

/**
 * Projecting tracked work into correlation evidence (issue #741).
 *
 * Each source knows its own lifecycle vocabulary; the classifier knows only
 * terminal / active / inert. Mapping happens here so a new state added to
 * pipelines or flows lands in one place rather than inside the matcher.
 */

const TITLE_LIMIT = 200;

function firstLine(text: string, limit = TITLE_LIMIT): string {
  const line = text.split("\n").find((candidate) => candidate.trim()) ?? "";
  return redactBounded(line, limit);
}

function referencesIn(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?<![\w#])#(\d{1,6})\b/g)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > 0) found.add(value);
  }
  return [...found];
}

function taskState(status: string): EvidenceState {
  if (status === "done") return "terminal";
  if (status === "blocked") return "inert";
  return "active";
}

function taskOwner(task: TaskSummary): string | null {
  const pipelineId = task.pipelineIds?.[0];
  if (pipelineId) return `pipeline ${pipelineId}`;
  const assignment = task.assignments?.find((entry) => entry.state === "delivered" || entry.state === "spawning" || entry.state === "handoff");
  return assignment ? "an assigned agent" : null;
}

export function evidenceFromTasks(tasks: readonly TaskSummary[]): EvidenceItem[] {
  return tasks.map((task) => ({
    kind: "task" as const,
    id: task.id,
    title: firstLine(task.text),
    state: taskState(task.status),
    owner: taskOwner(task),
    updatedAt: task.updatedAt || null,
    references: referencesIn(task.text),
    monitorRef: monitorRefIn(task.text),
  }));
}

function pipelineState(state: string): EvidenceState {
  if (state === "completed" || state === "closed") return "terminal";
  if (state === "needs_decision" || state === "paused" || state === "draft") return "inert";
  return "active";
}

export function evidenceFromPipelines(pipelines: readonly PipelineSummary[]): EvidenceItem[] {
  return pipelines.map((pipeline) => ({
    kind: "pipeline" as const,
    id: pipeline.id,
    title: firstLine(`${pipeline.task}\n${pipeline.spec ?? ""}`),
    state: pipelineState(pipeline.state),
    owner: `pipeline ${pipeline.id}`,
    updatedAt: pipeline.closedAt ?? pipeline.createdAt ?? null,
    references: referencesIn(`${pipeline.task} ${pipeline.spec ?? ""}`),
    monitorRef: null,
  }));
}

function flowState(state: string): EvidenceState {
  if (state === "approved" || state === "done_comment" || state === "closed") return "terminal";
  if (state === "needs_decision" || state === "paused" || state === "waiting_ready") return "inert";
  return "active";
}

export function evidenceFromFlows(flows: readonly FlowSummary[]): EvidenceItem[] {
  return flows.map((flow) => ({
    kind: "flow" as const,
    id: flow.id,
    title: firstLine(flow.spec ?? ""),
    state: flowState(flow.state),
    owner: `flow ${flow.id}`,
    updatedAt: flow.closedAt ?? flow.createdAt ?? null,
    references: referencesIn(flow.spec ?? ""),
    monitorRef: null,
  }));
}

/** A pull request or issue, as reported by the optional GitHub evidence
    source. The monitor only ever reads these — it never opens one. */
export interface GithubEvidenceRow {
  kind: "pull-request" | "issue";
  number: number;
  title: string;
  /** GitHub's own vocabulary: OPEN / CLOSED / MERGED, any case. */
  state: string;
  updatedAt?: string | null;
}

export function evidenceFromGithub(rows: readonly GithubEvidenceRow[]): EvidenceItem[] {
  return rows.map((row) => ({
    kind: row.kind,
    id: `#${row.number}`,
    title: firstLine(row.title),
    state: (row.state.toUpperCase() === "OPEN" ? "active" : "terminal") as EvidenceState,
    owner: row.kind === "pull-request" ? `pull request #${row.number}` : `issue #${row.number}`,
    updatedAt: row.updatedAt ?? null,
    references: [row.number],
    monitorRef: null,
  }));
}
