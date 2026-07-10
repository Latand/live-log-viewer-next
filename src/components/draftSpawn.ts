import type { FileEntry } from "@/lib/types";

/* The draft spawn lifecycle, as a pure module the pane renders from.
 *
 * Issue #67: a fresh spawn opens a durable server receipt before tmux launches,
 * and `/api/resources` can observe the live pane before the POST resolves. The
 * fixed backend therefore never errors once a pane exists — it returns HTTP 200
 * with a launched receipt (settled, or path-pending when the transcript is not
 * yet resolvable). The client mirror of that contract lives here: classify the
 * POST outcome, decide which durable phase a worker-may-exist result lands in,
 * and match the spawned transcript back to the draft by the strongest evidence
 * available. Everything is a pure function so the whole lifecycle is testable
 * without a DOM. */

/** The engine a draft can launch — the transcript roots differ per engine. */
export type DraftEngine = "claude" | "codex";

/** Display phase of a draft card, derived from the durable attempt + timers. */
export type DraftPhase = "draft" | "launching" | "booting" | "booting-slow" | "confirming" | "attention";

/** Durable phase persisted across reload — every value means a worker may
    already exist, so the send affordance stays disabled until the draft is
    dismissed or the transcript is adopted. `draft`/`launching` persist nothing. */
export type DurablePhase = "booting" | "confirming" | "attention";

/** The exact attachment payload accepted by the spawn route. Keeping it with
    the attempt lets a reload replay the same request without inventing a new
    launch shape. */
export interface SpawnImage {
  base64: string;
  mime: string;
}

/** Request fields that must survive a reload while POST is in flight. */
export interface RecoverableSpawnRequest {
  engine: DraftEngine;
  model: string;
  cwd: string;
  effort: string;
  fast: boolean | null;
  accountId: string;
  prompt: string;
  images: SpawnImage[];
  src: string;
}

/** The persisted record of an in-flight or unsettled launch. Its presence is
    the single source of truth for "a worker may exist" — send stays disabled,
    the prompt/images stay shown, and the copy discourages relaunch. */
export interface SpawnAttempt {
  /** Idempotency key sent with the POST; a converging re-POST replays onto the
      same server receipt instead of spawning a duplicate. */
  clientAttemptId: string;
  /** Launch moment (ms) — the mtime floor for heuristic transcript matching. */
  at: number;
  /** tmux target the pane launched into, or "" when the outcome was ambiguous
      (transport loss / opaque 5xx) and the client never learned it. */
  target: string;
  /** Exact transcript path the fresh session will write, when the server
      settled one (claude, or a resolved codex rollout); null while pending. */
  path: string | null;
  /** Stable Viewer conversation id the server settled, for exact adoption. */
  conversationId: string | null;
  /** Durable launch id owning the server receipt. */
  launchId: string | null;
  /** The first prompt, kept for the frozen bubble and for retry after a proven
      pre-launch failure. */
  prompt: string;
  /** Whether the prompt carried pasted images (shown as a placeholder). */
  hasImages: boolean;
  /** Exact POST data for idempotent recovery. Legacy records have no request
      payload and remain frozen because their identity cannot be reconstructed. */
  request: RecoverableSpawnRequest | null;
  engine: DraftEngine;
  /** Handoff source transcript, or "" for a plain draft. */
  src: string;
  phase: DurablePhase;
}

export function createSpawnAttempt(clientAttemptId: string, at: number, request: RecoverableSpawnRequest): SpawnAttempt & { request: RecoverableSpawnRequest } {
  return {
    clientAttemptId,
    at,
    target: "",
    path: null,
    conversationId: null,
    launchId: null,
    prompt: request.prompt.trim(),
    hasImages: request.images.length > 0,
    request,
    engine: request.engine,
    src: request.src,
    phase: "confirming",
  };
}

/** Validates records before a reload replays them. Missing or altered fields
    leave the card frozen rather than issuing a broad substitute launch. */
export function hasRecoverableRequest(attempt: SpawnAttempt): attempt is SpawnAttempt & { request: RecoverableSpawnRequest } {
  const request = attempt.request;
  return Boolean(
    request &&
    (request.engine === "claude" || request.engine === "codex") &&
    request.engine === attempt.engine &&
    typeof request.model === "string" &&
    typeof request.cwd === "string" && request.cwd.length > 0 &&
    typeof request.effort === "string" &&
    (request.fast === null || typeof request.fast === "boolean") &&
    typeof request.accountId === "string" &&
    typeof request.prompt === "string" &&
    typeof request.src === "string" && request.src === attempt.src &&
    Array.isArray(request.images) && request.images.every((image) => typeof image?.base64 === "string" && typeof image?.mime === "string"),
  );
}

/** Builds the same request body on the initial POST and on reload recovery. */
export function spawnRequestBody(attempt: SpawnAttempt & { request: RecoverableSpawnRequest }): Record<string, unknown> {
  const { request } = attempt;
  return {
    engine: request.engine,
    ...(request.model ? { model: request.model } : {}),
    cwd: request.cwd,
    ...(request.effort ? { effort: request.effort } : {}),
    ...(request.fast === null ? {} : { fast: request.fast }),
    ...(request.accountId ? { accountId: request.accountId } : {}),
    prompt: request.prompt,
    images: request.images,
    clientAttemptId: attempt.clientAttemptId,
    ...(request.src ? { src: request.src } : {}),
  };
}

/** Applies an exact receipt response while preserving the persisted request and
    original launch timestamp used to correlate the attempt. */
export function applySpawnOutcome(
  attempt: SpawnAttempt,
  outcome: Extract<SpawnOutcome, { kind: "launched" }>,
): SpawnAttempt {
  return {
    ...attempt,
    target: outcome.target,
    path: outcome.path,
    conversationId: outcome.conversationId,
    launchId: outcome.launchId,
    phase: outcome.durable,
  };
}

/** The subset of the spawn POST body the client reads back. */
export interface SpawnResponseBody {
  ok?: boolean;
  target?: string | null;
  path?: string | null;
  launchId?: string;
  conversationId?: string;
  launched?: boolean;
  retrySafe?: boolean;
  state?: "settled" | "path-pending" | "starting" | "conflict";
  error?: string;
}

/** What the POST outcome means for the draft card. */
export type SpawnOutcome =
  /** A worker exists (or very likely does). `durable` picks booting when the
      exact transcript path is known, else confirming. */
  | { kind: "launched"; durable: "booting" | "confirming"; target: string; path: string | null; conversationId: string | null; launchId: string | null }
  /** Proven pre-launch failure: no pane opened, images cleaned up server-side.
      Safe to retry — the draft re-enables send and shows the reason. */
  | { kind: "failed-preflight"; message: string | null }
  /** The client cannot prove whether a worker exists (transport loss, opaque
      5xx, a conflicting attempt). Treated as worker-may-exist: send stays off. */
  | { kind: "ambiguous" };

/* After this long without a matched transcript, a known-path boot admits it is
   slow (the file will still appear — the path is deterministic), and an
   unresolved confirming launch escalates to `attention`. */
export const SLOW_BOOT_MS = 90_000;
export const CONFIRM_ATTENTION_MS = 90_000;

/**
 * Map the spawn POST result to a card outcome. The duplicate-prevention
 * invariant lives here: only an outcome the client can *prove* is pre-launch
 * (`failed-preflight`) re-enables send; every uncertain result is `ambiguous`
 * and keeps the card frozen. A `200 {ok:true}` is always trusted as launched.
 */
export function classifySpawnResponse(status: number, ok: boolean, body: SpawnResponseBody | null): SpawnOutcome {
  if (ok && body?.ok) {
    const path = typeof body.path === "string" ? body.path : null;
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    const launchId = typeof body.launchId === "string" ? body.launchId : null;
    const target = typeof body.target === "string" ? body.target : "";
    /* A settled receipt with a known path is the only deterministic match; any
       other launched-but-unresolved receipt (path-pending, starting replay,
       conflict) becomes confirming and adopts by identity/heuristic. */
    const deterministic = body.state === "settled" && path !== null;
    return {
      kind: "launched",
      durable: deterministic ? "booting" : "confirming",
      target,
      path: deterministic ? path : null,
      conversationId,
      launchId,
    };
  }
  /* A replay of a receipt that failed before launch is explicitly retry-safe. */
  if (status === 409 && body?.retrySafe) return { kind: "failed-preflight", message: body?.error ?? null };
  /* A conflicting attempt (same key, different request) may have left the
     original worker alive — do not re-enable send. */
  if (status === 409) return { kind: "ambiguous" };
  /* Every other 4xx is a preflight rejection (validation, bad account, missing
     dir, oversize image, cross-origin) — no pane opened, safe to fix and retry. */
  if (status >= 400 && status < 500) return { kind: "failed-preflight", message: body?.error ?? null };
  /* 5xx / opaque: the fixed route only 500s pre-launch, but a proxy 5xx could
     land after launch — fail closed and treat the worker as possibly alive. */
  return { kind: "ambiguous" };
}

/** A thrown fetch (network drop, navigation) — the client saw nothing, so the
    worker may or may not exist. Always ambiguous → confirming. */
export function classifyTransportLoss(): SpawnOutcome {
  return { kind: "ambiguous" };
}

/**
 * Find the spawned transcript using only evidence carried by the exact server
 * receipt. Similar engine/cwd/timestamp transcripts can belong to another
 * concurrent draft and must never be adopted here.
 */
export function matchSpawnedFile(
  attempt: Pick<SpawnAttempt, "path" | "conversationId">,
  files: readonly FileEntry[],
): FileEntry | null {
  if (attempt.path) return files.find((file) => file.path === attempt.path) ?? null;
  if (attempt.conversationId) {
    const byId = files.find((file) => file.conversationId === attempt.conversationId);
    if (byId) return byId;
  }
  return null;
}

/** The send affordance re-enables only in `draft`/`failed-preflight` — i.e.
    exactly when no attempt record exists. This is the duplicate-prevention gate. */
export function sendEnabled(attempt: SpawnAttempt | null): boolean {
  return attempt === null;
}

/** Resolve the display phase from the durable attempt and the timer flags. */
export function displayPhase(attempt: Pick<SpawnAttempt, "phase"> | null, launching: boolean, slow: boolean): DraftPhase {
  if (!attempt) return launching ? "launching" : "draft";
  if (attempt.phase === "attention") return "attention";
  if (attempt.phase === "confirming") return "confirming";
  return slow ? "booting-slow" : "booting";
}
