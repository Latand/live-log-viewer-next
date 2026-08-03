import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { applyAttentionEvent, expiryCauseByClock, expiryFrom, type AttentionEvent, type AttentionTransition } from "./machine";
import { defaultZoomIntent, isFocusTarget, targetAcceptsIntent } from "./targets";
import {
  ATTENTION_SCHEMA_VERSION,
  isTerminalAttentionState,
  MAX_CONTEXT_LABEL_LENGTH,
  MAX_JOURNAL_CANDIDATES,
  MAX_REASON_LENGTH,
  QUEUE_CAP,
  type AttentionFileV1,
  type AttentionOrigin,
  type AttentionRaisedBy,
  type AttentionRequestV1,
  type AttentionState,
  type DesktopWindowRef,
  type FocusFrame,
  type FocusIntent,
  type FocusTarget,
  type JournalEventRef,
  type ZoomIntent,
} from "./types";

/**
 * The durable home of attention requests (#688 slice 1).
 *
 * Revisioned and written by temp-and-rename under the shared file transaction —
 * the discipline board state already uses — because presence cannot hold this:
 * it is in-memory, retains for two minutes, and a request has to survive a page
 * reload, a restart, and a root-session rollover.
 */

/** Terminal records kept for history before the oldest fall away. */
const MAX_RETAINED_TERMINAL = 50;

/** States that still count against the queue: raised, but not yet answered. */
const QUEUEABLE: readonly AttentionState[] = ["pending", "offered", "previewing"];

export function attentionFile(): string {
  return statePath("attention.json");
}

export class AttentionStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttentionStoreError";
  }
}

export class AttentionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AttentionValidationError";
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, filePath);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}

function emptyFile(now: Date): AttentionFileV1 {
  return { schemaVersion: ATTENTION_SCHEMA_VERSION, revision: 0, updatedAt: now.toISOString(), requests: [] };
}

function isRequest(value: unknown): value is AttentionRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AttentionRequestV1>;
  return (
    typeof request.id === "string" && request.id.length > 0
    && typeof request.createdAt === "string"
    && Boolean(request.requestedBy) && typeof request.requestedBy!.rootId === "string" && request.requestedBy!.rootId.length > 0
    && (request.origin === "root-agent" || request.origin === "operator")
    && isFocusTarget(request.target)
    && typeof request.state === "string"
    && typeof request.stateChangedAt === "string"
    && typeof request.expiresAt === "string"
    && Array.isArray(request.offeredTo) && request.offeredTo.every((entry) => typeof entry === "string")
    && Array.isArray(request.returnPoints)
    && Number.isInteger(request.revision) && request.revision! >= 0
  );
}

/** The persisted file. A missing file is an empty one; a malformed file is an
    error, because losing an in-flight request silently is the failure this
    whole record exists to prevent. */
export function readAttentionFile(filePath = attentionFile(), now = new Date()): AttentionFileV1 {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile(now);
    throw new AttentionStoreError("could not read attention state", { cause: error });
  }
  let parsed: Partial<AttentionFileV1>;
  try {
    parsed = JSON.parse(text) as Partial<AttentionFileV1>;
  } catch (error) {
    throw new AttentionStoreError("attention state contains malformed JSON", { cause: error });
  }
  if (parsed.schemaVersion !== ATTENTION_SCHEMA_VERSION) throw new AttentionStoreError(`unsupported attention schema: ${String(parsed.schemaVersion)}`);
  if (!Number.isInteger(parsed.revision) || !Array.isArray(parsed.requests)) throw new AttentionStoreError("attention state is not a valid record");
  if (!parsed.requests.every(isRequest)) throw new AttentionStoreError("attention state holds an invalid request");
  return {
    schemaVersion: ATTENTION_SCHEMA_VERSION,
    revision: parsed.revision!,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now.toISOString(),
    requests: parsed.requests,
  };
}

/** Trim history without ever dropping something still in flight. */
function retain(requests: AttentionRequestV1[]): AttentionRequestV1[] {
  const live = requests.filter((request) => !isTerminalAttentionState(request.state));
  const terminal = requests.filter((request) => isTerminalAttentionState(request.state));
  const kept = terminal.length > MAX_RETAINED_TERMINAL ? terminal.slice(terminal.length - MAX_RETAINED_TERMINAL) : terminal;
  return requests.filter((request) => live.includes(request) || kept.includes(request));
}

/**
 * One serialized read-modify-write over the attention file. The callback stays
 * synchronous; return `requests: undefined` to skip the write entirely, so a
 * no-op transition never churns the file revision.
 */
export function mutateAttention<R>(
  mutate: (file: AttentionFileV1) => { requests: AttentionRequestV1[] | undefined; result: R },
  options: { filePath?: string; now?: Date } = {},
): R {
  const filePath = options.filePath ?? attentionFile();
  const now = options.now ?? new Date();
  return withFileTransactionSync(filePath, "attention state is busy", () => {
    const current = readAttentionFile(filePath, now);
    const outcome = mutate(current);
    if (outcome.requests) {
      atomicWriteJson(filePath, {
        schemaVersion: ATTENTION_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        requests: retain(outcome.requests),
      } satisfies AttentionFileV1);
    }
    return outcome.result;
  });
}

export interface AttentionCreateInput {
  rootId: string;
  origin: AttentionOrigin;
  /** Server-derived caller attribution; never accepted from a tool caller. */
  raisedBy?: AttentionRaisedBy;
  target: FocusTarget;
  frameAtCreation: FocusFrame;
  intent: FocusIntent;
  reason: string;
  zoom?: ZoomIntent;
  contextLabel?: string;
  candidates?: JournalEventRef[];
  offeredTo?: string[];
  /**
   * #873: an immediate directed handoff. The server has already resolved the
   * one active view this request moves, so the record is born `accepted` for
   * that device — it never passes through an actionable `pending`/`offered`
   * state, no other device is named, and nothing renders a confirmation for
   * it. `acceptedVia` is `auto-follow`, because nothing was put in front of
   * the operator and nothing was pressed. Server-internal only: the HTTP
   * validator never passes this through, so no client can direct-accept a
   * device of its choosing.
   */
  directedAt?: string;
  desktopTarget?: DesktopWindowRef;
}

function validate(input: AttentionCreateInput): void {
  if (typeof input.rootId !== "string" || input.rootId.length === 0) {
    throw new AttentionValidationError("INVALID_ROOT", "a request must name the root agent by its stable identity");
  }
  if (!isFocusTarget(input.target)) throw new AttentionValidationError("INVALID_TARGET", "invalid focus target");
  if (input.intent !== "show" && input.intent !== "open") throw new AttentionValidationError("INVALID_INTENT", "intent must be show or open");
  if (!targetAcceptsIntent(input.target, input.intent)) {
    /* Refused, never downgraded: the operator is told which of show/open they
       are agreeing to, so a silently rewritten intent would make that a lie. */
    throw new AttentionValidationError("INTENT_NOT_AVAILABLE", "a geometric target can only be shown, not opened");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0 || input.reason.length > MAX_REASON_LENGTH) {
    throw new AttentionValidationError("INVALID_REASON", `a request needs one operator-safe sentence of at most ${MAX_REASON_LENGTH} characters`);
  }
  if (input.contextLabel !== undefined && (typeof input.contextLabel !== "string" || input.contextLabel.length > MAX_CONTEXT_LABEL_LENGTH)) {
    throw new AttentionValidationError("INVALID_CONTEXT_LABEL", "invalid context label");
  }
  if (input.candidates !== undefined && (!Array.isArray(input.candidates) || input.candidates.length > MAX_JOURNAL_CANDIDATES)) {
    throw new AttentionValidationError("INVALID_CANDIDATES", "too many journal candidates");
  }
  if (!input.frameAtCreation || typeof input.frameAtCreation.project !== "string" || input.frameAtCreation.project.length === 0) {
    throw new AttentionValidationError("INVALID_FRAME", "a request must record the frame it was created against");
  }
  if (input.directedAt !== undefined && (typeof input.directedAt !== "string" || input.directedAt.length === 0)) {
    throw new AttentionValidationError("INVALID_DIRECTED_AT", "a directed handoff must name the device it moves");
  }
}

/** Requests still competing for the screen, oldest first. */
export function liveAttentionRequests(file: AttentionFileV1): AttentionRequestV1[] {
  return file.requests.filter((request) => !isTerminalAttentionState(request.state));
}

/**
 * Create a request.
 *
 * Two things happen here that the machine cannot do on its own, because both
 * are about the *set* of requests rather than one of them:
 *
 * - a newer root-agent request supersedes that root's older un-acknowledged
 *   ones. There is one speaker, so a second request means it changed its mind.
 *   It also supersedes a follow whose way back has already collapsed: the
 *   machine decides that, and it is what keeps a handoff the operator never
 *   closed from shadowing everything raised afterwards;
 * - the queue is capped, and overflow drops the oldest routine entry. The
 *   caller is told which, so a dropped request can be said out loud instead of
 *   vanishing, and the record itself keeps `expiredCause: "queue-evicted"` so
 *   the distinction outlives that one response.
 *
 * An operator command enters at `accepted` — skipping consent, because it is
 * their own act — but is still recorded, so return, expiry and the multi-device
 * rules apply to it uniformly.
 */
export function createAttentionRequest(
  input: AttentionCreateInput,
  options: { filePath?: string; now?: Date; id?: string } = {},
): { request: AttentionRequestV1; superseded: string[]; dropped: string[] } {
  validate(input);
  const now = options.now ?? new Date();
  return mutateAttention((file) => {
    const id = options.id ?? `attention_${crypto.randomUUID()}`;
    const request: AttentionRequestV1 = {
      id,
      createdAt: now.toISOString(),
      requestedBy: { rootId: input.rootId },
      origin: input.origin,
      ...(input.raisedBy !== undefined ? { raisedBy: input.raisedBy } : {}),
      target: input.target,
      frameAtCreation: input.frameAtCreation,
      intent: input.intent,
      zoom: input.zoom ?? defaultZoomIntent(input.target, input.intent),
      reason: input.reason.trim(),
      ...(input.contextLabel !== undefined ? { contextLabel: input.contextLabel } : {}),
      ...(input.candidates !== undefined ? { candidates: input.candidates } : {}),
      state: input.origin === "operator" || input.directedAt !== undefined ? "accepted" : "pending",
      stateChangedAt: now.toISOString(),
      expiresAt: expiryFrom(now),
      offeredTo: input.directedAt !== undefined ? [input.directedAt] : input.offeredTo ?? [],
      ...(input.directedAt !== undefined
        ? { acknowledgedBy: input.directedAt, acceptedVia: input.origin === "operator" ? ("operator" as const) : ("auto-follow" as const) }
        : input.origin === "operator" && input.offeredTo?.length
          ? { acknowledgedBy: input.offeredTo[0], acceptedVia: "operator" as const }
          : {}),
      returnPoints: [],
      ...(input.desktopTarget !== undefined ? { desktopTarget: input.desktopTarget } : {}),
      revision: 0,
    };

    const superseded: string[] = [];
    const dropped: string[] = [];
    let requests = file.requests.map((existing) => {
      if (input.origin !== "root-agent") return existing;
      if (existing.requestedBy.rootId !== input.rootId) return existing;
      const transition = applyAttentionEvent(existing, { kind: "supersede", by: id }, { now });
      if (!transition.ok) return existing;
      superseded.push(existing.id);
      return transition.request;
    });

    /* The queue is the set still waiting to be answered. A request the operator
       already agreed to has left the queue — the view has moved or is moving for
       it — so it is neither counted nor evicted. Overflow drops the OLDEST
       routine entry, and an operator command is never the one thrown away. */
    const queued = () => requests.filter((entry) => QUEUEABLE.includes(entry.state) && entry.id !== id);
    while (queued().length >= QUEUE_CAP) {
      const waiting = queued();
      const victim = waiting.find((entry) => entry.origin === "root-agent") ?? waiting[0];
      if (!victim) break;
      const transition = applyAttentionEvent(victim, { kind: "expire", cause: "queue-evicted" }, { now });
      if (!transition.ok) break;
      dropped.push(victim.id);
      requests = requests.map((entry) => (entry.id === victim.id ? transition.request : entry));
    }

    return { requests: [...requests, request], result: { request, superseded, dropped } };
  }, { filePath: options.filePath, now });
}

/** Apply one lifecycle event to one request and persist the outcome. */
export function transitionAttentionRequest(
  id: string,
  event: AttentionEvent,
  options: { filePath?: string; now?: Date; expectedRevision?: number } = {},
): AttentionTransition | { ok: false; reason: "not-found" } {
  const now = options.now ?? new Date();
  return mutateAttention<AttentionTransition | { ok: false; reason: "not-found" }>((file) => {
    const current = file.requests.find((request) => request.id === id);
    if (!current) return { requests: undefined, result: { ok: false, reason: "not-found" } };
    const transition = applyAttentionEvent(current, event, { now, expectedRevision: options.expectedRevision });
    if (!transition.ok || !transition.changed) return { requests: undefined, result: transition };
    return {
      requests: file.requests.map((request) => (request.id === id ? transition.request : request)),
      result: transition,
    };
  }, { filePath: options.filePath, now });
}

/**
 * Expire everything the clock has run out on. Every expiry is a fact both sides
 * can see — the caller writes one line to the conversation and one event to the
 * journal for each id returned here.
 *
 * The clock has three causes, and the sweep carries whichever applies rather
 * than stamping them all `ttl`: an unanswered offer ran out; an agreed request
 * that never landed is `lost`; a follow nobody ever closed is `follow-elapsed`.
 * The last two are the recovery paths for the two states a request cannot leave
 * on its own — a device that agreed and then vanished mid-handoff, and an
 * operator who followed and walked away — and each of those, left live, is the
 * device's one offer slot held against everything raised after it.
 */
export function sweepExpiredAttention(options: { filePath?: string; now?: Date } = {}): string[] {
  const now = options.now ?? new Date();
  return mutateAttention((file) => {
    const expired: string[] = [];
    const requests = file.requests.map((request) => {
      const cause = expiryCauseByClock(request, now);
      if (!cause) return request;
      const transition = applyAttentionEvent(request, { kind: "expire", cause }, { now });
      if (!transition.ok) return request;
      expired.push(request.id);
      return transition.request;
    });
    return { requests: expired.length ? requests : undefined, result: expired };
  }, { filePath: options.filePath, now });
}
