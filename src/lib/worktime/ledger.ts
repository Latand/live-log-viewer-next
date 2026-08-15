import crypto from "node:crypto";

import { kyivDayKey } from "./calculator";
import type {
  CanonicalOperatorEvent,
  OperatorOccurrenceInput,
  WorktimeStateV1,
} from "./types";

const HISTORICAL_MATCH_WINDOW_MS = 30_000;
const PROJECT_PATTERN = /^-?[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;

function digest(...parts: Array<string | number>): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function resolveProject(event: CanonicalOperatorEvent): void {
  const candidates = Object.entries(event.projectCandidates);
  if (!event.provenOperator || candidates.length === 0) {
    event.project = null;
    event.ambiguous = false;
    return;
  }
  const highest = Math.max(...candidates.map(([, candidate]) => candidate.rank));
  const projects = candidates
    .filter(([, candidate]) => candidate.rank === highest)
    .map(([project]) => project)
    .sort();
  event.project = projects.length === 1 ? projects[0]! : null;
  event.ambiguous = projects.length > 1;
}

function matchingEvent(state: WorktimeStateV1, input: OperatorOccurrenceInput, sourceDigest: string): CanonicalOperatorEvent | null {
  if (!input.historical) {
    return Object.values(state.events).find((event) =>
      !event.historical && event.sourceDigest === sourceDigest) ?? null;
  }
  return Object.values(state.events).find((event) =>
    event.historical?.contentDigest === input.historical!.contentDigest
    && event.historical.lineageDigest === input.historical!.lineageDigest
    && Math.abs(event.occurredAtMs - input.occurredAtMs) <= HISTORICAL_MATCH_WINDOW_MS) ?? null;
}

export function emptyWorktimeState(enabledAtMs: number): WorktimeStateV1 {
  return {
    version: 1,
    enabledAtMs,
    events: {},
    rollups: {},
    catchup: { lastAttemptedAt: null, failedDay: null, lastError: null },
  };
}

export function upsertOperatorOccurrence(
  state: WorktimeStateV1,
  input: OperatorOccurrenceInput,
): CanonicalOperatorEvent {
  if (!Number.isFinite(input.occurredAtMs) || input.occurredAtMs <= 0) {
    throw new Error("operator occurrence timestamp is invalid");
  }
  if (!input.sourceId && !input.historical) throw new Error("operator occurrence identity is missing");
  const sourceDigest = input.sourceId
    ? digest("llv-worktime-source-v1", input.sourceId)
    : digest("llv-worktime-historical-source-v1", input.historical!.contentDigest, input.historical!.lineageDigest);
  let event = matchingEvent(state, input, sourceDigest);
  const previousDay = event ? kyivDayKey(event.occurredAtMs) : null;
  const previousValue = event ? JSON.stringify(event) : null;
  if (!event) {
    const id = digest(
      "llv-worktime-event-v1",
      sourceDigest,
      input.historical ? input.occurredAtMs : "stable",
    );
    event = {
      id,
      sourceDigest,
      origin: input.origin,
      occurredAtMs: input.occurredAtMs,
      provenOperator: input.relation === "direct",
      project: null,
      ambiguous: false,
      projectCandidates: {},
      occurrenceDigests: [],
      occurrenceCount: 0,
      deduplicatedCount: 0,
      evidenceDigests: [],
      ...(input.historical ? { historical: { ...input.historical } } : {}),
    };
    state.events[id] = event;
  }

  if (input.relation === "direct") {
    event.occurredAtMs = event.provenOperator
      ? Math.min(event.occurredAtMs, input.occurredAtMs)
      : input.occurredAtMs;
    event.provenOperator = true;
    event.origin = input.origin;
    for (const candidate of input.projectCandidates) {
      const project = candidate.project.trim();
      if (!PROJECT_PATTERN.test(project) || !Number.isFinite(candidate.rank) || candidate.rank < 0) continue;
      const evidenceDigest = digest("llv-worktime-project-evidence-v1", candidate.evidence);
      const existing = event.projectCandidates[project];
      if (!existing || candidate.rank > existing.rank) {
        event.projectCandidates[project] = { rank: candidate.rank, evidenceDigests: [evidenceDigest] };
      } else if (candidate.rank === existing.rank) {
        existing.evidenceDigests = uniqueSorted([...existing.evidenceDigests, evidenceDigest]);
      }
      event.evidenceDigests = uniqueSorted([...event.evidenceDigests, evidenceDigest]);
    }
  } else if (!event.provenOperator) {
    event.occurredAtMs = Math.min(event.occurredAtMs, input.occurredAtMs);
  }
  const occurrenceDigest = digest("llv-worktime-occurrence-v1", input.occurrenceId);
  event.occurrenceDigests = uniqueSorted([...event.occurrenceDigests, occurrenceDigest]);
  event.occurrenceCount = event.occurrenceDigests.length;
  event.deduplicatedCount = Math.max(0, event.occurrenceCount - 1);
  resolveProject(event);
  if (event.historical) {
    const canonicalId = digest("llv-worktime-event-v1", event.sourceDigest, event.occurredAtMs);
    if (canonicalId !== event.id) {
      delete state.events[event.id];
      event.id = canonicalId;
      state.events[event.id] = event;
    }
  }
  if (previousValue !== JSON.stringify(event)) {
    for (const day of new Set([previousDay, kyivDayKey(event.occurredAtMs)])) {
      if (!day) continue;
      const rollup = state.rollups[day];
      if (rollup && rollup.lifecycle.deliveredAt === null) delete state.rollups[day];
    }
  }
  return event;
}

function normalizeHistoricalText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function historicalOperatorOccurrence(input: {
  normalizedText: string;
  lineageId: string;
  occurrenceId: string;
  occurredAtMs: number;
  projectCandidates: OperatorOccurrenceInput["projectCandidates"];
}): OperatorOccurrenceInput {
  return {
    occurrenceId: input.occurrenceId,
    origin: "historical",
    relation: "direct",
    occurredAtMs: input.occurredAtMs,
    projectCandidates: input.projectCandidates,
    historical: {
      contentDigest: digest("llv-worktime-historical-content-v1", normalizeHistoricalText(input.normalizedText)),
      lineageDigest: digest("llv-worktime-historical-lineage-v1", input.lineageId),
    },
  };
}
