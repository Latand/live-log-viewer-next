import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";

/* Operator-selected PER-PROJECT orchestrator seats.
 *
 * The legacy single-instance record (`./store`) stays the bridge's manager
 * pointer; a seat is the operator's durable statement that ONE conversation
 * owns ONE project's board. A seat is written in two durable steps that
 * together make designate-and-inject atomic:
 *
 *  - a PENDING INTENT, persisted before anything is spawned or delivered. It
 *    carries the mandate and the client's idempotency key, so a crash between
 *    "prompt delivered" and "seat active" is recoverable: the retry replays the
 *    same key, the delivery layer deduplicates on it, and completion happens
 *    exactly once.
 *  - ACTIVATION, which seats the conversation, records the mandate that was
 *    actually delivered, and — when a different conversation held the seat —
 *    writes a durable REVOCATION for the predecessor in the same file write.
 *
 * Nothing here grants authority by itself: `./authority` reads seats and
 * revocations and fails closed on anything conflicting, revoked, superseded or
 * cross-project. A pending intent grants nothing, which is exactly why a
 * designation with no delivered mandate cannot exist as an authority.
 *
 * ABA is prevented by the seat epoch: every activation takes the next epoch
 * from a monotonic counter, and a revocation records the epoch it ended. A
 * predecessor returning from pause still names a conversation whose newest
 * revocation is >= any seat it could point at, so it stays dead until the
 * operator deliberately re-designates it — which mints a strictly newer epoch.
 */

export const ORCHESTRATOR_SEATS_SCHEMA_VERSION = 1;

export interface OrchestratorSeatIntent {
  /** Client idempotency key; doubles as the spawn clientAttemptId or the
      delivery clientMessageId, so every side effect replays instead of
      duplicating. */
  clientRequestId: string;
  mode: "spawn" | "existing";
  /** Durable launch receipt for an accepted asynchronous spawn. */
  launchId: string | null;
  /** Terminal error of the last completion attempt; null while none failed. */
  error: string | null;
}

export interface OrchestratorSeat {
  project: string;
  /** Monotonic designation epoch; strictly increases across the whole file. */
  seatEpoch: number;
  /** Null only while a spawn-mode intent has not settled a conversation. */
  conversationId: string | null;
  path: string | null;
  /** The mandate text delivered (active) or to be delivered (pending). */
  mandate: string;
  /** Version of the approved default prompt the mandate was based on; null
      when the designation predates versioning or the mandate is bespoke. */
  promptVersion: number | null;
  /** Rotation lineage: the conversation this seat replaced, when any. The
      matching revocation carries `successorConversationId`, so the link is
      bidirectional and both cards stay navigable. */
  predecessorConversationId: string | null;
  state: "pending" | "active";
  intent: OrchestratorSeatIntent;
  designatedAt: string;
  activatedAt: string | null;
}

/** A pending intent moved out of the blocking position — never deleted. The
    full seat snapshot (key, mandate, epoch, mode, error, timestamps) stays
    readable so the operator can see what was attempted and why it failed. */
export interface OrchestratorSeatTerminalization {
  seat: OrchestratorSeat;
  /** Why it stopped blocking: it recorded a terminal error, or its epoch fell
      below the project's active seat (something else already seated it). */
  reason: "terminal_error" | "superseded_epoch";
  terminalizedAt: string;
}

/** Newest-last bound on terminalized history, so the file cannot grow without
    limit; the oldest entries are trimmed first. */
export const ORCHESTRATOR_SEAT_HISTORY_CAP = 50;

export interface OrchestratorRevocation {
  project: string;
  conversationId: string;
  /** Epoch of the seat that ended. An identity is dead while its newest
      revocation is >= every active seat naming it. */
  seatEpoch: number;
  revokedAt: string;
  /** The seat that replaced it — the other half of the rotation lineage. */
  successorConversationId?: string | null;
}

interface OrchestratorSeatFile {
  schemaVersion: number;
  nextSeatEpoch: number;
  /** Active seat per project. */
  seats: Record<string, OrchestratorSeat>;
  /** Pending designate-and-inject intents per project. */
  pending: Record<string, OrchestratorSeat>;
  revocations: OrchestratorRevocation[];
  /** Terminalized pending intents, oldest first, bounded by
      ORCHESTRATOR_SEAT_HISTORY_CAP. */
  history: OrchestratorSeatTerminalization[];
}

const seatsFile = () => statePath("orchestrator-seats.json");

/** One durable namespace for named projects and their repository identities. */
export function canonicalOrchestratorProject(project: string): string {
  return canonicalProject(project.trim());
}

function emptyFile(): OrchestratorSeatFile {
  return { schemaVersion: ORCHESTRATOR_SEATS_SCHEMA_VERSION, nextSeatEpoch: 1, seats: {}, pending: {}, revocations: [], history: [] };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}

function normalizeSeat(value: unknown): OrchestratorSeat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seat = value as Partial<OrchestratorSeat>;
  if (typeof seat.project !== "string" || !seat.project) return null;
  if (typeof seat.seatEpoch !== "number" || !Number.isInteger(seat.seatEpoch) || seat.seatEpoch < 1) return null;
  if (seat.conversationId !== null && typeof seat.conversationId !== "string") return null;
  if (seat.path !== null && typeof seat.path !== "string") return null;
  if (typeof seat.mandate !== "string") return null;
  if (seat.state !== "pending" && seat.state !== "active") return null;
  const intent = seat.intent as Partial<OrchestratorSeatIntent> | undefined;
  if (!intent || typeof intent.clientRequestId !== "string" || !intent.clientRequestId) return null;
  if (intent.mode !== "spawn" && intent.mode !== "existing") return null;
  if (typeof seat.designatedAt !== "string") return null;
  if (seat.activatedAt !== null && typeof seat.activatedAt !== "string") return null;
  return {
    project: seat.project,
    seatEpoch: seat.seatEpoch,
    conversationId: seat.conversationId ?? null,
    path: seat.path ?? null,
    mandate: seat.mandate,
    promptVersion: typeof seat.promptVersion === "number" && Number.isInteger(seat.promptVersion) ? seat.promptVersion : null,
    predecessorConversationId: typeof seat.predecessorConversationId === "string" ? seat.predecessorConversationId : null,
    state: seat.state,
    intent: {
      clientRequestId: intent.clientRequestId,
      mode: intent.mode,
      launchId: typeof intent.launchId === "string" ? intent.launchId : null,
      error: typeof intent.error === "string" ? intent.error : null,
    },
    designatedAt: seat.designatedAt,
    activatedAt: seat.activatedAt ?? null,
  };
}

function retainNewestSeat(collection: Record<string, OrchestratorSeat>, seat: OrchestratorSeat): void {
  const current = collection[seat.project];
  if (!current || seat.seatEpoch > current.seatEpoch) collection[seat.project] = seat;
}

/**
 * A malformed or future-schema file reads as EMPTY, not as an error: authority
 * fails closed on an absent seat, and the next designation overwrites the
 * corrupt file — the same recovery shape the legacy record uses. Individual
 * malformed rows are dropped for the same reason.
 */
export function readOrchestratorSeatFile(): OrchestratorSeatFile {
  let raw: string;
  try {
    raw = fs.readFileSync(seatsFile(), "utf8");
  } catch {
    return emptyFile();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrchestratorSeatFile>;
    if (parsed.schemaVersion !== ORCHESTRATOR_SEATS_SCHEMA_VERSION) return emptyFile();
    const file = emptyFile();
    file.nextSeatEpoch = typeof parsed.nextSeatEpoch === "number" && Number.isInteger(parsed.nextSeatEpoch) && parsed.nextSeatEpoch >= 1
      ? parsed.nextSeatEpoch
      : 1;
    for (const [project, candidate] of Object.entries(parsed.seats ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.project === project && seat.state === "active" && seat.conversationId) {
        retainNewestSeat(file.seats, { ...seat, project: canonicalOrchestratorProject(project) });
      }
    }
    for (const [project, candidate] of Object.entries(parsed.pending ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.project === project && seat.state === "pending") {
        retainNewestSeat(file.pending, { ...seat, project: canonicalOrchestratorProject(project) });
      }
    }
    for (const candidate of Array.isArray(parsed.revocations) ? parsed.revocations : []) {
      const revocation = candidate as Partial<OrchestratorRevocation>;
      if (typeof revocation.project === "string" && typeof revocation.conversationId === "string"
        && typeof revocation.seatEpoch === "number" && Number.isInteger(revocation.seatEpoch)
        && typeof revocation.revokedAt === "string") {
        file.revocations.push({
          project: canonicalOrchestratorProject(revocation.project),
          conversationId: revocation.conversationId,
          seatEpoch: revocation.seatEpoch,
          revokedAt: revocation.revokedAt,
          successorConversationId: typeof revocation.successorConversationId === "string" ? revocation.successorConversationId : null,
        });
      }
    }
    for (const candidate of Array.isArray(parsed.history) ? parsed.history : []) {
      const entry = candidate as Partial<OrchestratorSeatTerminalization>;
      const seat = normalizeSeat(entry.seat);
      if (seat
        && (entry.reason === "terminal_error" || entry.reason === "superseded_epoch")
        && typeof entry.terminalizedAt === "string") {
        file.history.push({
          seat: { ...seat, project: canonicalOrchestratorProject(seat.project) },
          reason: entry.reason,
          terminalizedAt: entry.terminalizedAt,
        });
      }
    }
    /* The epoch counter must postdate everything on file, or a corrupted
       counter would let a fresh seat land at an epoch a revocation already
       covers and be born dead. */
    const highest = Math.max(0,
      ...Object.values(file.seats).map((seat) => seat.seatEpoch),
      ...Object.values(file.pending).map((seat) => seat.seatEpoch),
      ...file.revocations.map((revocation) => revocation.seatEpoch),
      ...file.history.map((entry) => entry.seat.seatEpoch));
    if (file.nextSeatEpoch <= highest) file.nextSeatEpoch = highest + 1;
    return file;
  } catch {
    return emptyFile();
  }
}

function writeSeatFile(file: OrchestratorSeatFile): void {
  atomicWriteJson(seatsFile(), file);
}

/** The active seat, any pending intent, and the terminalized-intent history
    for one project (oldest first). */
export function orchestratorSeatFor(project: string): {
  active: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  history: OrchestratorSeatTerminalization[];
} {
  const file = readOrchestratorSeatFile();
  const canonical = canonicalOrchestratorProject(project);
  return {
    active: file.seats[canonical] ?? null,
    pending: file.pending[canonical] ?? null,
    history: file.history.filter((entry) => entry.seat.project === canonical),
  };
}

export type BeginSeatIntentResult =
  /** A fresh pending intent; `terminalized` names the abandoned intent it
      moved into durable history, when there was one. */
  | { kind: "begun"; seat: OrchestratorSeat; terminalized?: OrchestratorSeatTerminalization }
  /** The same intent replayed by its own key, for the caller to finish. */
  | { kind: "replay"; seat: OrchestratorSeat }
  /** Another request owns the in-flight transition for this project. */
  | { kind: "in_progress"; seat: OrchestratorSeat }
  /** The same key already completed: designation and injection both happened. */
  | { kind: "completed"; seat: OrchestratorSeat };

/**
 * Persist the designate-and-inject intent BEFORE any side effect. Idempotent on
 * `clientRequestId`: a replay of a completed intent short-circuits to the active
 * seat (deliver nothing twice), and a replay of a pending one returns it for the
 * caller to finish. A NEW key is blocked (`in_progress`) only by a genuinely
 * in-flight pending intent — one with no terminal error whose epoch is at or
 * above the project's active seat. An ABANDONED pending intent — terminal
 * `intent.error` recorded, or epoch below the active seat — is TERMINALIZED in
 * the same write: moved out of the blocking `pending` position into the bounded
 * durable `history`, never deleted, and the new intent proceeds.
 */
export function beginOrchestratorSeatIntent(input: {
  project: string;
  mandate: string;
  clientRequestId: string;
  mode: "spawn" | "existing";
  conversationId?: string | null;
  promptVersion?: number | null;
  now?: string;
}): BeginSeatIntentResult {
  const file = readOrchestratorSeatFile();
  const project = canonicalOrchestratorProject(input.project);
  const active = file.seats[project];
  if (active && active.intent.clientRequestId === input.clientRequestId) {
    return { kind: "completed", seat: active };
  }
  const pending = file.pending[project];
  if (pending && pending.intent.clientRequestId === input.clientRequestId) {
    return { kind: "replay", seat: pending };
  }
  let terminalized: OrchestratorSeatTerminalization | undefined;
  if (pending) {
    const abandoned = pending.intent.error !== null || (active !== undefined && pending.seatEpoch < active.seatEpoch);
    if (!abandoned) return { kind: "in_progress", seat: pending };
    terminalized = {
      seat: pending,
      reason: pending.intent.error !== null ? "terminal_error" : "superseded_epoch",
      terminalizedAt: input.now ?? new Date().toISOString(),
    };
    file.history.push(terminalized);
    if (file.history.length > ORCHESTRATOR_SEAT_HISTORY_CAP) {
      file.history.splice(0, file.history.length - ORCHESTRATOR_SEAT_HISTORY_CAP);
    }
    delete file.pending[project];
  }
  const seat: OrchestratorSeat = {
    project,
    seatEpoch: file.nextSeatEpoch,
    conversationId: input.conversationId ?? null,
    path: null,
    mandate: input.mandate,
    promptVersion: input.promptVersion ?? null,
    predecessorConversationId: null,
    state: "pending",
    intent: { clientRequestId: input.clientRequestId, mode: input.mode, launchId: null, error: null },
    designatedAt: input.now ?? new Date().toISOString(),
    activatedAt: null,
  };
  file.nextSeatEpoch += 1;
  file.pending[project] = seat;
  writeSeatFile(file);
  return { kind: "begun", seat, ...(terminalized ? { terminalized } : {}) };
}

export type CompleteSeatIntentResult =
  | { kind: "activated"; seat: OrchestratorSeat; revoked: OrchestratorRevocation | null }
  | { kind: "replay"; seat: OrchestratorSeat }
  | { kind: "missing" };

/**
 * Activate the pending intent — the mandate has provably been delivered (or
 * durably accepted for exactly-once delivery by the spawn receipt) to
 * `conversationId`. One atomic write seats the conversation AND revokes a
 * differing predecessor, so there is no interleaving in which both, or
 * neither, hold the project.
 */
export function completeOrchestratorSeatIntent(input: {
  project: string;
  clientRequestId: string;
  conversationId: string;
  path: string | null;
  launchId?: string | null;
  now?: string;
}): CompleteSeatIntentResult {
  const file = readOrchestratorSeatFile();
  const project = canonicalOrchestratorProject(input.project);
  const active = file.seats[project];
  if (active && active.intent.clientRequestId === input.clientRequestId) {
    return { kind: "replay", seat: active };
  }
  const pending = file.pending[project];
  if (!pending || pending.intent.clientRequestId !== input.clientRequestId) return { kind: "missing" };
  const now = input.now ?? new Date().toISOString();
  let revoked: OrchestratorRevocation | null = null;
  if (active && active.conversationId && active.conversationId !== input.conversationId) {
    revoked = {
      project,
      conversationId: active.conversationId,
      seatEpoch: active.seatEpoch,
      revokedAt: now,
      /* Bidirectional lineage: the revocation names its successor, the
         successor seat names its predecessor, and both cards stay navigable. */
      successorConversationId: input.conversationId,
    };
    file.revocations.push(revoked);
  }
  const seat: OrchestratorSeat = {
    ...pending,
    conversationId: input.conversationId,
    path: input.path,
    predecessorConversationId: revoked?.conversationId ?? pending.predecessorConversationId,
    state: "active",
    intent: { ...pending.intent, launchId: input.launchId ?? pending.intent.launchId, error: null },
    activatedAt: now,
  };
  delete file.pending[project];
  file.seats[project] = seat;
  writeSeatFile(file);
  return { kind: "activated", seat, revoked };
}

/** Record why a pending intent could not complete; the seat stays pending and
    recoverable, and the previous active seat (if any) stays authoritative. */
export function failOrchestratorSeatIntent(project: string, clientRequestId: string, error: string): void {
  const file = readOrchestratorSeatFile();
  const canonical = canonicalOrchestratorProject(project);
  const pending = file.pending[canonical];
  if (!pending || pending.intent.clientRequestId !== clientRequestId) return;
  pending.intent.error = error.slice(0, 500);
  writeSeatFile(file);
}

/** Every active seat, for the authority resolver. */
export function activeOrchestratorSeats(): OrchestratorSeat[] {
  return Object.values(readOrchestratorSeatFile().seats);
}

/** Every durable revocation, for the authority resolver's ABA guard. */
export function orchestratorRevocations(): OrchestratorRevocation[] {
  return readOrchestratorSeatFile().revocations;
}
