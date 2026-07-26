import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import {
  isLifecycleEventType,
  isLifecycleState,
  LIFECYCLE_STATE_FOR_EVENT,
  operatorSafeSummary,
  type LifecycleEventType,
  type LifecycleState,
} from "./vocabulary";

/**
 * #686 — the durable lifecycle event journal.
 *
 * One append-only record per meaningful transition, carrying a stable id, a
 * timestamp, project/pipeline lineage, the conversation/stage role, the shared
 * event type and one bounded, redacted operator-safe summary. It survives a
 * Viewer restart because it is a file, and a replay cannot duplicate anything
 * because every id is derived from a caller-supplied stable key: appending the
 * same transition twice is a no-op, whatever produced it.
 *
 * Never a notification service: nothing here pushes. Producers append,
 * consumers read by lineage and cursor.
 */

export const LIFECYCLE_JOURNAL_VERSION = 1;

/** Events retained in the file. Older ones are trimmed, their ids retired. */
export const LIFECYCLE_JOURNAL_CAPACITY = 2_000;
/** Retired ids kept so a trimmed event cannot be re-appended by a late replay. */
const RETIRED_ID_CAPACITY = 8_000;

export interface LifecycleEvent {
  id: string;
  /** Monotonic, never reused — the cursor a consumer stores. */
  seq: number;
  at: string;
  type: LifecycleEventType;
  state: LifecycleState;
  project: string | null;
  pipelineId: string | null;
  stageId: string | null;
  attempt: number | null;
  conversationId: string | null;
  /** Stage or agent role this event belongs to (`reviewer`, `builder`, …). */
  role: string | null;
  /** Bounded, redacted. Raw transcript text can never reach this field. */
  summary: string;
}

export interface LifecycleEventInput {
  /** Stable identity of the transition. The same key always yields the same
      event id, which is what makes replay idempotent. */
  key: string;
  type: LifecycleEventType;
  at: string;
  project?: string | null;
  pipelineId?: string | null;
  stageId?: string | null;
  attempt?: number | null;
  conversationId?: string | null;
  role?: string | null;
  /** Raw candidate text; bounded and redacted before it is stored. */
  summary?: string | null;
}

export interface LifecycleJournalFile {
  version: number;
  lastSeq: number;
  events: LifecycleEvent[];
  retired: string[];
}

export interface LifecycleEventQuery {
  project?: string;
  pipelineId?: string;
  conversationId?: string;
  stageId?: string;
  type?: LifecycleEventType;
  /** Exclusive cursor: only events with a greater seq are returned. */
  afterSeq?: number;
  limit?: number;
}

export interface LifecycleEventPage {
  count: number;
  events: LifecycleEvent[];
  /** Highest seq in the journal — a caller with no events yet can start here. */
  cursor: number;
  /** Events matching the query that did not fit under `limit`. */
  remaining: number;
}

export function lifecycleJournalPath(): string {
  return statePath("lifecycle-journal.json");
}

export function lifecycleEventId(key: string): string {
  return `evt_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function emptyJournal(): LifecycleJournalFile {
  return { version: LIFECYCLE_JOURNAL_VERSION, lastSeq: 0, events: [], retired: [] };
}

function normalizeEvent(value: unknown): LifecycleEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<LifecycleEvent>;
  if (typeof event.id !== "string" || !event.id) return null;
  if (!Number.isInteger(event.seq) || (event.seq as number) < 1) return null;
  if (typeof event.at !== "string" || !event.at) return null;
  if (!isLifecycleEventType(event.type)) return null;
  const state = isLifecycleState(event.state) ? event.state : LIFECYCLE_STATE_FOR_EVENT[event.type];
  const nullableString = (candidate: unknown): string | null => (typeof candidate === "string" ? candidate : null);
  return {
    id: event.id,
    seq: event.seq as number,
    at: event.at,
    type: event.type,
    state,
    project: nullableString(event.project),
    pipelineId: nullableString(event.pipelineId),
    stageId: nullableString(event.stageId),
    attempt: Number.isInteger(event.attempt) ? event.attempt as number : null,
    conversationId: nullableString(event.conversationId),
    role: nullableString(event.role),
    summary: typeof event.summary === "string" ? event.summary : "",
  };
}

function normalizeJournal(value: unknown): LifecycleJournalFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyJournal();
  const file = value as Partial<LifecycleJournalFile>;
  const events = Array.isArray(file.events)
    ? file.events.map(normalizeEvent).filter((event): event is LifecycleEvent => event !== null)
    : [];
  events.sort((left, right) => left.seq - right.seq);
  const retired = Array.isArray(file.retired) ? file.retired.filter((id): id is string => typeof id === "string") : [];
  const highest = events.at(-1)?.seq ?? 0;
  const lastSeq = Number.isInteger(file.lastSeq) ? Math.max(file.lastSeq as number, highest) : highest;
  return { version: LIFECYCLE_JOURNAL_VERSION, lastSeq, events, retired };
}

function readJournalFile(): LifecycleJournalFile {
  try {
    return normalizeJournal(JSON.parse(fs.readFileSync(lifecycleJournalPath(), "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyJournal();
    /* A corrupt journal must never take the Viewer down with it: the surface
       degrades to "nothing recorded yet" and the next append rewrites it. */
    return emptyJournal();
  }
}

function writeJournalFile(file: LifecycleJournalFile): void {
  const target = lifecycleJournalPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

/** The durable journal exactly as stored. */
export function readLifecycleJournal(): LifecycleJournalFile {
  return readJournalFile();
}

/**
 * Appends every input whose id is not already recorded (or already retired by
 * trimming), in one file transaction. Returns what was actually added, so a
 * projector can tell a genuinely new transition from a replay of an old one.
 */
export function appendLifecycleEvents(inputs: LifecycleEventInput[]): { appended: LifecycleEvent[]; skipped: number } {
  if (inputs.length === 0) return { appended: [], skipped: 0 };
  return withFileTransactionSync(lifecycleJournalPath(), "lifecycle journal is busy", () => {
    const file = readJournalFile();
    const known = new Set<string>([...file.events.map((event) => event.id), ...file.retired]);
    const appended: LifecycleEvent[] = [];
    let skipped = 0;
    for (const input of inputs) {
      const id = lifecycleEventId(input.key);
      if (known.has(id)) {
        skipped += 1;
        continue;
      }
      known.add(id);
      file.lastSeq += 1;
      const event: LifecycleEvent = {
        id,
        seq: file.lastSeq,
        at: input.at,
        type: input.type,
        state: LIFECYCLE_STATE_FOR_EVENT[input.type],
        project: input.project ?? null,
        pipelineId: input.pipelineId ?? null,
        stageId: input.stageId ?? null,
        attempt: Number.isInteger(input.attempt) ? input.attempt as number : null,
        conversationId: input.conversationId ?? null,
        role: input.role ?? null,
        summary: operatorSafeSummary(input.summary),
      };
      file.events.push(event);
      appended.push(event);
    }
    if (appended.length === 0) return { appended, skipped };
    if (file.events.length > LIFECYCLE_JOURNAL_CAPACITY) {
      const trimmed = file.events.splice(0, file.events.length - LIFECYCLE_JOURNAL_CAPACITY);
      file.retired = [...file.retired, ...trimmed.map((event) => event.id)].slice(-RETIRED_ID_CAPACITY);
    }
    writeJournalFile(file);
    return { appended, skipped };
  });
}

/** Queryable by project, pipeline, conversation and cursor, as #686 requires. */
export function queryLifecycleEvents(query: LifecycleEventQuery = {}): LifecycleEventPage {
  const file = readJournalFile();
  return pageFromEvents(file, query);
}

export function pageFromEvents(file: LifecycleJournalFile, query: LifecycleEventQuery = {}): LifecycleEventPage {
  const limit = Math.max(1, Math.min(200, Number.isInteger(query.limit) ? query.limit as number : 50));
  const afterSeq = Number.isInteger(query.afterSeq) ? query.afterSeq as number : 0;
  const matched = file.events.filter((event) => {
    if (event.seq <= afterSeq) return false;
    if (query.project && event.project !== query.project) return false;
    if (query.pipelineId && event.pipelineId !== query.pipelineId) return false;
    if (query.conversationId && event.conversationId !== query.conversationId) return false;
    if (query.stageId && event.stageId !== query.stageId) return false;
    if (query.type && event.type !== query.type) return false;
    return true;
  });
  const events = matched.slice(0, limit);
  return {
    count: events.length,
    events,
    cursor: file.lastSeq,
    remaining: matched.length - events.length,
  };
}
