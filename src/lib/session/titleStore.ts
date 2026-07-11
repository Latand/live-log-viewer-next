import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

/** Longest custom title we store; the derived title uses the same 120 cap. */
export const MAX_CUSTOM_TITLE = 120;
/** Bounded store — the oldest records are evicted past this many keys, so a
    machine that renames thousands of sessions never grows the file without a
    ceiling. Chosen well above any plausible working set. */
export const MAX_TITLE_OVERRIDES = 2_000;

/** Resolve on every call, never bake at module load: a test that pins
    LLV_STATE_DIR after this module first imports must still redirect writes to
    its sandbox (see flows/store.ts for the same reasoning). */
const titlesFile = () => statePath("session-titles.json");

/** One durable rename record. `key` is the stable identity the title is filed
    under (see {@link titleKeysForEntry}). `title` is the custom name, or `null`
    for a **tombstone** — a cleared override whose `revision` is preserved so a
    later set never reuses a revision an earlier editor still holds (that would
    let a stale write slip past the concurrency guard). `revision` bumps on
    every set and clear. */
export interface SessionTitleOverride {
  key: string;
  title: string | null;
  revision: number;
  updatedAt: string;
}

type TitlesFile = { version?: unknown; titles?: unknown };

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is SessionTitleOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SessionTitleOverride>;
  return (
    typeof record.key === "string" &&
    record.key.length > 0 &&
    (record.title === null || (typeof record.title === "string" && record.title.length > 0)) &&
    typeof record.revision === "number" &&
    Number.isInteger(record.revision) &&
    record.revision > 0 &&
    typeof record.updatedAt === "string"
  );
}

export function loadSessionTitles(filePath = titlesFile()): SessionTitleOverride[] {
  const raw = readJson(filePath) as TitlesFile | null;
  return Array.isArray(raw?.titles) ? raw.titles.filter(isRecord) : [];
}

export function saveSessionTitles(records: SessionTitleOverride[], filePath = titlesFile()): void {
  atomicWriteJson(filePath, { version: 1, titles: records });
}

/** Sanitize + bound a user title. Returns null when it collapses to empty (an
    empty title is a clear, never a blank card). */
export function sanitizeCustomTitle(value: string): string | null {
  const cleaned = cleanTitle(value, MAX_CUSTOM_TITLE);
  return cleaned.length > 0 ? cleaned : null;
}

/** Path-level subagent exclusion for the rename scope (issue #33, AC9): Claude
    subagent transcripts are `agent-*.jsonl` and/or live under a `subagents/`
    directory. Native Codex subagents share the ordinary `rollout-*.jsonl` name
    and are filtered separately from transcript metadata — see
    `isRenameableSessionEntry` in `renameEligibility.ts`. Pure string ops so this
    stays importable from client-safe server code without pulling `node:fs`. */
export function isRenameableSessionPath(pathname: string): boolean {
  const base = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !base.startsWith("agent-") && !pathname.includes("/subagents/");
}

/** Candidate keys for an entry, most-stable first: the Viewer conversation
    identity owns the title when present (so account/compaction successors adopt
    it through the registry), the session UUID is the compatibility key that
    survives archive/revive/move, and the transcript path is the bounded
    fallback for a session the registry never named. */
export function titleKeysForEntry(entry: Pick<FileEntry, "engine" | "path" | "conversationId">): string[] {
  const keys: string[] = [];
  if (entry.conversationId?.startsWith("conversation_")) keys.push(`conversation:${entry.conversationId}`);
  if (entry.engine === "claude" || entry.engine === "codex") {
    const sessionKey = sessionKeyFromTranscript(entry.engine, entry.path);
    if (sessionKey) keys.push(`uuid:${sessionKeyId(sessionKey)}`);
  }
  keys.push(`path:${entry.path}`);
  return keys;
}

/** The single key a fresh rename is filed under — the most stable available. */
export function preferredTitleKey(entry: Pick<FileEntry, "engine" | "path" | "conversationId">): string {
  return titleKeysForEntry(entry)[0]!;
}

/** Index records by key for O(1) overlay lookups. */
export function indexSessionTitles(records: SessionTitleOverride[]): Map<string, SessionTitleOverride> {
  return new Map(records.map((record) => [record.key, record]));
}

/** The record that owns an entry's title, checked most-stable key first —
    including a tombstone, so the overlay can surface its revision as the base
    for the next write. */
export function overrideForEntry(
  entry: Pick<FileEntry, "engine" | "path" | "conversationId">,
  index: Map<string, SessionTitleOverride>,
): SessionTitleOverride | null {
  for (const key of titleKeysForEntry(entry)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

/** Overlay a custom title onto a scanned entry. An active record replaces
    `title` and preserves the derived title on `autoTitle`; a tombstone leaves
    the title untouched (cleared → auto title stands). Either way `titleRevision`
    carries the concurrency token consumers echo back on the next PATCH, so a
    reset-then-rename never reuses a stale revision. */
export function applyTitleOverride(entry: FileEntry, index: Map<string, SessionTitleOverride>): void {
  const record = overrideForEntry(entry, index);
  if (!record) return;
  entry.titleRevision = record.revision;
  if (record.title === null || record.title === entry.title) return;
  entry.autoTitle = entry.title;
  entry.title = record.title;
}

/**
 * Serialized read-modify-write over the titles file — the only sanctioned way
 * to persist a rename. The whole load→transform→save runs synchronously so a
 * handler can never save a snapshot that predates another handler's write
 * (mirrors {@link import("@/lib/tasks/store").mutateTasks}).
 */
export function mutateSessionTitles<R>(
  mutate: (records: SessionTitleOverride[]) => { records: SessionTitleOverride[] | undefined; result: R },
  filePath = titlesFile(),
): R {
  const outcome = mutate(loadSessionTitles(filePath));
  if (outcome.records) saveSessionTitles(capRecords(outcome.records), filePath);
  return outcome.result;
}

/** Keep the store bounded — evict the least-recently-updated records once the
    key count exceeds the cap. */
function capRecords(records: SessionTitleOverride[]): SessionTitleOverride[] {
  if (records.length <= MAX_TITLE_OVERRIDES) return records;
  return [...records]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_TITLE_OVERRIDES);
}

export type SetTitleOutcome =
  | { ok: true; override: SessionTitleOverride | null }
  | { ok: false; conflict: SessionTitleOverride | null };

/**
 * Set (non-empty) or clear (null) a session's custom title.
 *
 * `candidateKeys` are the entry's keys in stable-first priority (see
 * {@link titleKeysForEntry}); `preferredKey` (their first entry) is where the
 * result lands. The mutation bases its concurrency check on the **first
 * existing record among the candidates** — the same record the overlay surfaced
 * as `titleRevision` — then collapses every candidate-key record into a single
 * record under `preferredKey`. That migrates a title filed under the UUID/path
 * onto the conversation key once identity appears, so a later clear can never
 * miss it (finding: fallback-key overrides couldn't be cleared).
 *
 * A clear writes a **tombstone** (title `null`) that preserves the monotonic
 * revision; a set writes the sanitized title. When `baseRevision` is supplied it
 * must match the current record's revision, else the write is rejected as a
 * conflict carrying the current record. Returns the effective active record, or
 * null once cleared.
 */
export function writeSessionTitle(
  candidateKeys: string[],
  preferredKey: string,
  title: string | null,
  baseRevision: number | undefined,
  now: string,
  filePath = titlesFile(),
): SetTitleOutcome {
  const keySet = new Set(candidateKeys);
  return mutateSessionTitles<SetTitleOutcome>((records) => {
    let current: SessionTitleOverride | null = null;
    for (const key of candidateKeys) {
      const hit = records.find((record) => record.key === key);
      if (hit) { current = hit; break; }
    }
    if (baseRevision !== undefined && baseRevision !== (current?.revision ?? 0)) {
      return { records: undefined, result: { ok: false, conflict: current } };
    }
    const sanitized = title === null ? null : sanitizeCustomTitle(title);
    // Drop every candidate-key record; the single new record is re-added under
    // the preferred key, collapsing duplicates and migrating stale keys.
    const rest = records.filter((record) => !keySet.has(record.key));
    if (sanitized === null) {
      // Nothing set, or already a tombstone: clearing again is a no-op that must
      // not bump the revision (and must not create a tombstone from nothing).
      if (!current || current.title === null) return { records: undefined, result: { ok: true, override: null } };
      const tombstone: SessionTitleOverride = { key: preferredKey, title: null, revision: current.revision + 1, updatedAt: now };
      return { records: [...rest, tombstone], result: { ok: true, override: null } };
    }
    const record: SessionTitleOverride = { key: preferredKey, title: sanitized, revision: (current?.revision ?? 0) + 1, updatedAt: now };
    return { records: [...rest, record], result: { ok: true, override: record } };
  }, filePath);
}
