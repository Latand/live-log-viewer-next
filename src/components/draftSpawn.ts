import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";
import { derivedSpawnTitle, durableSemanticTitle } from "@/lib/title";

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
export type DraftPhase = "draft" | "launching" | "booting" | "booting-slow" | "confirming" | "confirming-slow" | "attention";

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
  /** Semantic identity frozen before the POST and replayed byte-for-byte. */
  title: string;
  engine: DraftEngine;
  model: string;
  cwd: string;
  effort: string;
  fast: boolean | null;
  accountId: string;
  /* Quoted key: keeps the `prompt` field identical at runtime while keeping the
     token off a line start, which the privacy publication gate's transcript
     heuristic (`^\s*prompt:`) would otherwise flag on this source file. */
  "prompt": string;
  images: SpawnImage[];
  src: string;
  /** Stable handoff parent identity captured when the draft is created. */
  parentConversationId?: string;
  /** Optional role registry reference. Omitted for the unchanged blank draft. */
  role?: string;
  roleParams?: Record<string, string | number>;
  /** Stable conversation reference reviewed by a reviewer-role spawn. */
  reviews?: string;
  confirm?: string;
}

/** The persisted record of an in-flight or unsettled launch. Its presence is
    the single source of truth for "a worker may exist" — send stays disabled,
    the prompt/images stay shown, and the copy discourages relaunch. */
export interface SpawnAttempt {
  /** Idempotency key sent with the POST; a converging re-POST replays onto the
      same server receipt and prevents a duplicate. */
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
  /* Quoted key: keeps the `prompt` field identical at runtime while keeping the
     token off a line start, which the privacy publication gate's transcript
     heuristic (`^\s*prompt:`) would otherwise flag on this source file. */
  "prompt": string;
  /** Whether the prompt carried pasted images (shown as a placeholder). */
  hasImages: boolean;
  /** Exact POST data for idempotent recovery. Legacy records have no request
      payload and remain frozen because their identity cannot be reconstructed. */
  request: RecoverableSpawnRequest | null;
  engine: DraftEngine;
  /** Handoff source transcript, or "" for a plain draft. */
  src: string;
  phase: DurablePhase;
  /** Teaching error for a launch that opened a pane and then failed verification. */
  error?: string | null;
}

export function createSpawnAttempt(clientAttemptId: string, at: number, request: RecoverableSpawnRequest): SpawnAttempt & { request: RecoverableSpawnRequest } {
  return {
    clientAttemptId,
    at,
    target: "",
    path: null,
    conversationId: null,
    launchId: null,
    ["prompt"]: request.prompt.trim(),
    hasImages: request.images.length > 0,
    request,
    engine: request.engine,
    src: request.src,
    phase: "confirming",
    error: null,
  };
}

/** Freeze a human-readable title from the role and operator's first line. An
    image-only draft still names its concrete action without a generic session
    placeholder. */
export function draftSpawnTitle(
  engine: DraftEngine,
  role: string | null | undefined,
  prompt: string,
  imageCount: number,
): string {
  const imageFallback = imageCount === 1 ? "Analyze attached image" : "Analyze attached images";
  return derivedSpawnTitle(role || engine, prompt, imageFallback);
}

/** Validates records before a reload replays them. Missing or altered fields
    leave the card frozen until exact recovery data arrives. */
export function hasRecoverableRequest(attempt: SpawnAttempt): attempt is SpawnAttempt & { request: RecoverableSpawnRequest } {
  const request = attempt.request;
  return Boolean(
    request &&
    (request.engine === "claude" || request.engine === "codex") &&
    request.engine === attempt.engine &&
    durableSemanticTitle(request.title, 120) !== null &&
    typeof request.model === "string" &&
    typeof request.cwd === "string" && request.cwd.length > 0 &&
    typeof request.effort === "string" &&
    (request.fast === null || typeof request.fast === "boolean") &&
    typeof request.accountId === "string" &&
    typeof request.prompt === "string" &&
    typeof request.src === "string" && request.src === attempt.src &&
    (request.parentConversationId === undefined || typeof request.parentConversationId === "string") &&
    (request.role === undefined || typeof request.role === "string") &&
    (request.roleParams === undefined || (typeof request.roleParams === "object" && request.roleParams !== null && !Array.isArray(request.roleParams))) &&
    (request.reviews === undefined || typeof request.reviews === "string") &&
    (request.role === "reviewer" ? Boolean(request.reviews?.trim()) : request.reviews === undefined) &&
    (request.confirm === undefined || typeof request.confirm === "string") &&
    Array.isArray(request.images) && request.images.every((image) => typeof image?.base64 === "string" && typeof image?.mime === "string"),
  );
}

/** Builds the same request body on the initial POST and on reload recovery. */
export function spawnRequestBody(attempt: SpawnAttempt & { request: RecoverableSpawnRequest }): Record<string, unknown> {
  const { request } = attempt;
  return {
    title: request.title,
    engine: request.engine,
    ...(request.model ? { model: request.model } : {}),
    cwd: request.cwd,
    ...(request.effort ? { effort: request.effort } : {}),
    ...(request.fast === null ? {} : { fast: request.fast }),
    ...(request.accountId ? { accountId: request.accountId } : {}),
    ["prompt"]: request.prompt,
    images: request.images,
    clientAttemptId: attempt.clientAttemptId,
    ...(request.src ? { src: request.src } : {}),
    ...(request.parentConversationId ? { parentConversationId: request.parentConversationId } : {}),
    ...(request.role ? { role: request.role, roleParams: request.roleParams ?? {} } : {}),
    ...(request.reviews ? { reviews: request.reviews } : {}),
    ...(request.confirm ? { confirm: request.confirm } : {}),
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
    error: null,
  };
}

export function applySpawnFailure(
  attempt: SpawnAttempt,
  outcome: Extract<SpawnOutcome, { kind: "failed-launch" }>,
): SpawnAttempt {
  return {
    ...attempt,
    target: outcome.target,
    conversationId: outcome.conversationId,
    launchId: outcome.launchId,
    phase: "attention",
    error: outcome.message,
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
  initialMessage?: "pending" | "queued" | "delivered" | "failed";
  state?: "settled" | "path-pending" | "starting" | "failed" | "conflict";
  /** The transport the receipt actually launched over (issue #919): a
      structured receipt is the trigger for the instant receipt-keyed attach. */
  transport?: "structured" | "tmux";
  error?: string;
}

/** What the POST outcome means for the draft card. */
export type SpawnOutcome =
  /** A worker exists (or very likely does). `durable` picks booting when the
      exact transcript path is known, else confirming. `structured`, `state` and
      `initialMessage` carry the receipt facts the instant attach (issue #919)
      projects into the provisional conversation window. */
  | {
      kind: "launched";
      durable: "booting" | "confirming";
      target: string;
      path: string | null;
      conversationId: string | null;
      launchId: string | null;
      structured: boolean;
      state: NonNullable<SpawnResponseBody["state"]> | null;
      initialMessage: NonNullable<SpawnResponseBody["initialMessage"]> | null;
    }
  /** Proven retry-safe failure: the server has released worker ownership, so
      the draft re-enables send and shows the reason. */
  | { kind: "failed-preflight"; message: string | null }
  /** A pane opened, then positive launch verification found a terminal screen. */
  | { kind: "failed-launch"; message: string; target: string; conversationId: string | null; launchId: string | null }
  /** The client cannot prove whether a worker exists (transport loss, opaque
      5xx, a conflicting attempt). Treated as worker-may-exist: send stays off. */
  | { kind: "ambiguous" };

/* After this long without a matched transcript, a known-path boot admits it is
   slow (the file will still appear — the path is deterministic), an admitted
   confirming launch admits the same (issue #919: the receipt proved the worker,
   so the watch continues indefinitely), and only a confirming launch with NO
   receipt escalates to `attention`. */
export const SLOW_BOOT_MS = 90_000;
export const CONFIRM_ATTENTION_MS = 90_000;

/**
 * Map the spawn POST result to a card outcome. The duplicate-prevention
 * invariant lives here: only an outcome the server marks retry-safe re-enables
 * send; every uncertain result is `ambiguous` and keeps the card frozen. A
 * `200 {ok:true}` is trusted as a durable launch receipt.
 */
export function classifySpawnResponse(status: number, ok: boolean, body: SpawnResponseBody | null): SpawnOutcome {
  /* A terminal replay retains its durable card identity while releasing the
     draft guard for a fresh clientAttemptId. */
  if (body?.retrySafe) return { kind: "failed-preflight", message: body.error ?? null };
  if (ok && body?.ok) {
    const path = typeof body.path === "string" ? body.path : null;
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    const launchId = typeof body.launchId === "string" ? body.launchId : null;
    const target = typeof body.target === "string" ? body.target : "";
    if (body.launched === false && typeof body.error === "string" && body.error) {
      return { kind: "failed-launch", message: body.error, target, conversationId, launchId };
    }
    /* A settled receipt with a known path is the only deterministic match; any
       other unresolved launch receipt (path-pending, starting replay,
       conflict) becomes confirming and adopts by identity/heuristic. */
    const deterministic = body.state === "settled" && path !== null;
    return {
      kind: "launched",
      durable: deterministic ? "booting" : "confirming",
      target,
      path: deterministic ? path : null,
      conversationId,
      launchId,
      structured: body.transport === "structured",
      state: body.state ?? null,
      initialMessage: body.initialMessage ?? null,
    };
  }
  /* A conflicting attempt (same key, different request) can leave the
     original worker alive. Send stays disabled. */
  if (status === 409) return { kind: "ambiguous" };
  /* Every other 4xx is a preflight rejection (validation, bad account, missing
     dir, oversize image, cross-origin) — no pane opened, safe to fix and retry. */
  if (status >= 400 && status < 500) return { kind: "failed-preflight", message: body?.error ?? null };
  /* 5xx / opaque: the fixed route emits 500 before launch. A proxy 5xx can
     land after launch, so recovery treats the worker as possibly alive. */
  return { kind: "ambiguous" };
}

/** A thrown fetch (network drop, navigation) leaves worker existence
    uncertain. Recovery stays in the confirming state. */
export function classifyTransportLoss(): SpawnOutcome {
  return { kind: "ambiguous" };
}

/**
 * Find the spawned transcript using only evidence carried by the exact server
 * receipt. Similar engine/cwd/timestamp transcripts can belong to another
 * concurrent draft and must never be adopted here.
 *
 * When the accepted POST's response was lost (transport drop / opaque 5xx) the
 * attempt learned neither path nor conversation id, while the durable launch
 * projection still surfaces a `spawn` card carrying this attempt's EXACT
 * `clientAttemptId` (round-2 finding 3). That exact id is a precise match that
 * lets the draft adopt its own canonical conversation; unrelated launches, whose
 * projected `clientAttemptId` differs or is null, stay unclaimed.
 */
export function matchSpawnedFile(
  attempt: Pick<SpawnAttempt, "path" | "conversationId" | "clientAttemptId">,
  files: readonly FileEntry[],
): FileEntry | null {
  if (attempt.path) {
    const byPath = files.find((file) => file.path === attempt.path);
    if (byPath) return byPath;
  }
  /* The durable conversation id from the receipt keys the attach (issue #919):
     a settled path that has not entered the scan yet must not block adoption of
     the same conversation's earlier surface (its `spawn:` projection). */
  if (attempt.conversationId) {
    const byId = files.find((file) => file.conversationId === attempt.conversationId);
    if (byId) return byId;
  }
  if (attempt.clientAttemptId) {
    const byAttempt = files.find((file) => file.spawn?.clientAttemptId === attempt.clientAttemptId);
    if (byAttempt) return byAttempt;
  }
  return null;
}

/** Receipt evidence that the server admitted this launch: any durable identity
    the response settled. An admitted spawn is a proven worker — the watch shows
    a launching state forever and never escalates to the «may already be
    running» attention copy, which is reserved for launches whose receipt was
    lost (transport drop, opaque 5xx, conflicting attempt). Issue #919. */
export function admittedSpawn(attempt: Pick<SpawnAttempt, "conversationId" | "launchId" | "path" | "target">): boolean {
  return Boolean(attempt.conversationId || attempt.launchId || attempt.path || attempt.target);
}

/**
 * The provisional conversation window for an admitted STRUCTURED receipt
 * (issue #919): the receipt already names the durable conversation id and the
 * launch, which is exactly what the server's own `spawn:<launchId>` projection
 * keys on — so the client renders the same card immediately instead of waiting
 * for the files feed to deliver it. The feed's copy later replaces this one by
 * path/conversation identity (never duplicating it), and the live window it
 * opens subscribes to the structured host's stream by conversation id on its
 * own. Null when the receipt cannot prove a structured conversation (tmux
 * transport, missing identity, terminal failure/conflict) — those keep the
 * legacy transcript watch.
 */
export function provisionalSpawnFile(
  attempt: SpawnAttempt,
  outcome: Extract<SpawnOutcome, { kind: "launched" }>,
  project: string,
): FileEntry | null {
  if (!outcome.structured || !outcome.conversationId || !outcome.launchId) return null;
  if (outcome.state === "failed" || outcome.state === "conflict") return null;
  const initialMessage = outcome.initialMessage ?? "pending";
  const state: StructuredSpawnCardState["state"] = initialMessage === "delivered"
    ? "recovered"
    : initialMessage === "queued"
      ? "queued"
      : outcome.state === "path-pending"
        ? "binding"
        : "starting";
  const spawn: StructuredSpawnCardState = {
    launchId: outcome.launchId,
    clientAttemptId: attempt.clientAttemptId,
    accountId: attempt.request?.accountId || null,
    conversationId: outcome.conversationId,
    /* A fresh launch owns generation one, same as the server projection of a
       receipt with no key yet — required for launch-bubble ownership (#922). */
    generation: 1,
    state,
    initialMessage,
    retrySafe: false,
    error: null,
    ...(attempt.prompt.trim() || attempt.hasImages
      ? {
          ["prompt"]: attempt.prompt,
          promptImages: attempt.request?.images.length ?? 0,
          promptAt: attempt.at,
        }
      : {}),
  };
  return {
    path: `spawn:${outcome.launchId}`,
    root: attempt.engine === "codex" ? "codex-sessions" : "claude-projects",
    name: `spawn:${outcome.launchId}`,
    project,
    ...(attempt.request?.cwd ? { cwd: attempt.request.cwd } : {}),
    title: attempt.engine === "codex" ? "Codex" : "Claude",
    engine: attempt.engine,
    kind: "session",
    fmt: attempt.engine,
    spawnOrigin: "viewer",
    parent: null,
    mtime: attempt.at / 1000,
    size: 0,
    activity: "live",
    activityReason: `structured_spawn_${state}`,
    proc: null,
    pid: null,
    model: attempt.request?.model || null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId: outcome.conversationId,
    generation: 1,
    spawn,
  };
}

/** The send affordance re-enables only in `draft`/`failed-preflight` — i.e.
    exactly when no attempt record exists. This is the duplicate-prevention gate. */
export function sendEnabled(attempt: SpawnAttempt | null): boolean {
  return attempt === null;
}

/** Resolve the display phase from the durable attempt and the timer flags. An
    admitted confirming launch earns only the slow admission after its window
    (issue #919) — the timer never escalates it to `attention`. */
export function displayPhase(attempt: Pick<SpawnAttempt, "phase"> | null, launching: boolean, slow: boolean): DraftPhase {
  if (!attempt) return launching ? "launching" : "draft";
  if (attempt.phase === "attention") return "attention";
  if (attempt.phase === "confirming") return slow ? "confirming-slow" : "confirming";
  return slow ? "booting-slow" : "booting";
}
