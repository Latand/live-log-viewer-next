import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

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
}

const seatsFile = () => statePath("orchestrator-seats.json");

function emptyFile(): OrchestratorSeatFile {
  return { schemaVersion: ORCHESTRATOR_SEATS_SCHEMA_VERSION, nextSeatEpoch: 1, seats: {}, pending: {}, revocations: [] };
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
    intent: { clientRequestId: intent.clientRequestId, mode: intent.mode, error: typeof intent.error === "string" ? intent.error : null },
    designatedAt: seat.designatedAt,
    activatedAt: seat.activatedAt ?? null,
  };
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
      if (seat && seat.project === project && seat.state === "active" && seat.conversationId) file.seats[project] = seat;
    }
    for (const [project, candidate] of Object.entries(parsed.pending ?? {})) {
      const seat = normalizeSeat(candidate);
      if (seat && seat.project === project && seat.state === "pending") file.pending[project] = seat;
    }
    for (const candidate of Array.isArray(parsed.revocations) ? parsed.revocations : []) {
      const revocation = candidate as Partial<OrchestratorRevocation>;
      if (typeof revocation.project === "string" && typeof revocation.conversationId === "string"
        && typeof revocation.seatEpoch === "number" && Number.isInteger(revocation.seatEpoch)
        && typeof revocation.revokedAt === "string") {
        file.revocations.push({
          project: revocation.project,
          conversationId: revocation.conversationId,
          seatEpoch: revocation.seatEpoch,
          revokedAt: revocation.revokedAt,
          successorConversationId: typeof revocation.successorConversationId === "string" ? revocation.successorConversationId : null,
        });
      }
    }
    /* The epoch counter must postdate everything on file, or a corrupted
       counter would let a fresh seat land at an epoch a revocation already
       covers and be born dead. */
    const highest = Math.max(0,
      ...Object.values(file.seats).map((seat) => seat.seatEpoch),
      ...Object.values(file.pending).map((seat) => seat.seatEpoch),
      ...file.revocations.map((revocation) => revocation.seatEpoch));
    if (file.nextSeatEpoch <= highest) file.nextSeatEpoch = highest + 1;
    return file;
  } catch {
    return emptyFile();
  }
}

function writeSeatFile(file: OrchestratorSeatFile): void {
  atomicWriteJson(seatsFile(), file);
}

/** The active seat and any pending intent for one project. */
export function orchestratorSeatFor(project: string): { active: OrchestratorSeat | null; pending: OrchestratorSeat | null } {
  const file = readOrchestratorSeatFile();
  return { active: file.seats[project] ?? null, pending: file.pending[project] ?? null };
}

export type BeginSeatIntentResult =
  /** A fresh pending intent, or the same intent replayed by its own key. */
  | { kind: "begun" | "replay"; seat: OrchestratorSeat }
  /** The same key already completed: designation and injection both happened. */
  | { kind: "completed"; seat: OrchestratorSeat };

/**
 * Persist the designate-and-inject intent BEFORE any side effect. Idempotent on
 * `clientRequestId`: a replay of a completed intent short-circuits to the active
 * seat (deliver nothing twice), a replay of a pending one returns it for the
 * caller to finish, and a NEW key simply replaces an abandoned pending intent —
 * the abandoned one never activated, so nothing durable referenced it.
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
  const active = file.seats[input.project];
  if (active && active.intent.clientRequestId === input.clientRequestId) {
    return { kind: "completed", seat: active };
  }
  const pending = file.pending[input.project];
  if (pending && pending.intent.clientRequestId === input.clientRequestId) {
    return { kind: "replay", seat: pending };
  }
  const seat: OrchestratorSeat = {
    project: input.project,
    seatEpoch: file.nextSeatEpoch,
    conversationId: input.conversationId ?? null,
    path: null,
    mandate: input.mandate,
    promptVersion: input.promptVersion ?? null,
    predecessorConversationId: null,
    state: "pending",
    intent: { clientRequestId: input.clientRequestId, mode: input.mode, error: null },
    designatedAt: input.now ?? new Date().toISOString(),
    activatedAt: null,
  };
  file.nextSeatEpoch += 1;
  file.pending[input.project] = seat;
  writeSeatFile(file);
  return { kind: "begun", seat };
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
  now?: string;
}): CompleteSeatIntentResult {
  const file = readOrchestratorSeatFile();
  const active = file.seats[input.project];
  if (active && active.intent.clientRequestId === input.clientRequestId) {
    return { kind: "replay", seat: active };
  }
  const pending = file.pending[input.project];
  if (!pending || pending.intent.clientRequestId !== input.clientRequestId) return { kind: "missing" };
  const now = input.now ?? new Date().toISOString();
  let revoked: OrchestratorRevocation | null = null;
  if (active && active.conversationId && active.conversationId !== input.conversationId) {
    revoked = {
      project: input.project,
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
    intent: { ...pending.intent, error: null },
    activatedAt: now,
  };
  delete file.pending[input.project];
  file.seats[input.project] = seat;
  writeSeatFile(file);
  return { kind: "activated", seat, revoked };
}

/** Record why a pending intent could not complete; the seat stays pending and
    recoverable, and the previous active seat (if any) stays authoritative. */
export function failOrchestratorSeatIntent(project: string, clientRequestId: string, error: string): void {
  const file = readOrchestratorSeatFile();
  const pending = file.pending[project];
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
