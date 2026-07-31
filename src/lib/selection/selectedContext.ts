/**
 * The selected-card reference an operator submission carries (#844).
 *
 * The motivating gesture: the operator selects a conversation card in the
 * Viewer, then types — or speaks — an instruction into a DIFFERENT conversation
 * ("look at that one"). The agent on the other end cannot see the screen, and
 * PR #753's plain-text prelude only tells it a path in prose. This module is the
 * typed, durable half of that: one record, admitted atomically with the turn,
 * that names the selected conversation by its stable identity.
 *
 * Three rules shape everything below.
 *
 * 1. VERSIONED AND DISCRIMINATED. `version` gates the whole shape and `state`
 *    splits `selected` from an EXPLICIT `none`. An empty selection is a fact the
 *    operator produced, not an absence: "I asked with nothing selected" and "the
 *    reference was lost" must never read the same, so the `none` variant carries
 *    the same binding evidence a `selected` one does.
 * 2. `conversationId` IS THE IDENTITY. Everything else — project, path, label,
 *    view/device, revision — is evidence for humans and for staleness checks. A
 *    selected variant without a canonical conversation id is not a weaker
 *    reference, it is not a reference, and parsing rejects it.
 * 3. NO TRANSCRIPT CONTENT. The reference names a conversation; reading it is a
 *    separate, explicitly bounded tail operation (see `./resolve`). Duplicating
 *    the selected card's text into every utterance is what this design exists to
 *    avoid.
 *
 * Evidence fields are dropped when they cannot be validated, rather than
 * rejecting the record: a browser that could not read its device id still
 * produced a real selection, and losing the whole reference over it would be the
 * worse failure. The two things that ARE load-bearing — the identity and the
 * capture time — are required, because a reference that cannot be resolved or
 * aged is not one.
 */

export const SELECTED_CONTEXT_VERSION = 1 as const;

/** A human label rides along for the badge only; the card's title, not its text. */
export const MAX_SELECTED_LABEL_CHARS = 80;
export const MAX_SELECTED_PROJECT_CHARS = 200;
export const MAX_SELECTED_PATH_CHARS = 1_024;
/** Canonical Viewer conversation identity, the same grammar the registry mints. */
const CONVERSATION_ID = /^conversation_[A-Za-z0-9_-]{1,180}$/;
/** Opaque view/device tokens: no whitespace, no separators, and bounded, so a
    hostile body cannot smuggle a payload into the journal through an id. */
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** Evidence every variant carries, each part present only when it validated. */
interface SelectedContextEvidence {
  /** ISO-8601 instant the reference was captured. Required: staleness is a rule. */
  capturedAt: string;
  project?: string;
  /** The publishing document's presence session — a reload mints a new one. */
  viewSessionId?: string;
  /** Stable per device; two devices are two selections, never one. */
  deviceId?: string;
  /** The view's input/selection revision at capture; monotonic per view session. */
  revision?: number;
}

export type SelectedContextRef =
  | (SelectedContextEvidence & {
      version: typeof SELECTED_CONTEXT_VERSION;
      state: "selected";
      conversationId: string;
      /** The selected card's transcript path AT CAPTURE — provenance, never identity. */
      path?: string;
      /** Bounded card title for the badge. Never transcript content. */
      label?: string;
    })
  | (SelectedContextEvidence & {
      version: typeof SELECTED_CONTEXT_VERSION;
      state: "none";
    });

export type SelectedContextSelected = Extract<SelectedContextRef, { state: "selected" }>;

/** The conversation a reference names, or null for the explicit empty selection. */
export function selectedContextConversationId(ref: SelectedContextRef | null): string | null {
  return ref && ref.state === "selected" ? ref.conversationId : null;
}

/* ------------------------------------------------------------------ *
 * Capture                                                            *
 * ------------------------------------------------------------------ */

/** What the current view can say about one card on screen. Assembled by the
    surface that owns `FileEntry` objects; the presence bus only carries paths. */
export interface SelectedCardIdentity {
  path: string;
  /** Absent while the backend has not yet named this artifact — then the card
      cannot be referenced, and capture falls through to `none`. */
  conversationId?: string;
  project?: string;
  label?: string;
}

export interface SelectedContextCaptureInput {
  context: { project: string | null };
  slice: { focusedPath: string | null; selectedPaths: readonly string[] };
  /** Path → identity for the cards this view can name. */
  cards: readonly SelectedCardIdentity[];
  /** The publishing document's presence identity, or null before it resolves. */
  identity: { viewSessionId: string; deviceId: string } | null;
  /** The view's input/selection revision, or null when the view has none. */
  revision: number | null;
  /** Epoch ms, read ONCE by the caller at the admission boundary. */
  now: number;
}

/**
 * Read the whole reference in one synchronous pass.
 *
 * Atomicity is the point and it is structural, not promised: the caller invokes
 * this at the instant the turn is admitted, and everything the reference will
 * ever say is decided here. Board movement after admission cannot rewrite it,
 * because nothing re-reads the view.
 *
 * Precedence is the operator's own attention order: the FOCUSED card first (the
 * one they are looking at), then the first member of the selection in this
 * view's published order. A selected path this view cannot name as a
 * conversation yields `none` rather than a guessed identity.
 */
export function captureSelectedContext(input: SelectedContextCaptureInput): SelectedContextRef {
  const evidence: SelectedContextEvidence = {
    capturedAt: new Date(input.now).toISOString(),
    ...optional("project", boundedText(input.context.project, MAX_SELECTED_PROJECT_CHARS)),
    ...optional("viewSessionId", input.identity ? opaqueId(input.identity.viewSessionId) : null),
    ...optional("deviceId", input.identity ? opaqueId(input.identity.deviceId) : null),
    ...optional("revision", revisionOf(input.revision)),
  };
  const byPath = new Map(input.cards.map((card) => [card.path, card]));
  const candidates = input.slice.focusedPath ? [input.slice.focusedPath, ...input.slice.selectedPaths] : input.slice.selectedPaths;
  for (const path of candidates) {
    const card = byPath.get(path);
    const conversationId = card && typeof card.conversationId === "string" && CONVERSATION_ID.test(card.conversationId)
      ? card.conversationId
      : null;
    if (!card || !conversationId) continue;
    return {
      version: SELECTED_CONTEXT_VERSION,
      state: "selected",
      conversationId,
      ...evidence,
      ...optional("path", boundedPath(card.path)),
      ...optional("label", boundedText(card.label, MAX_SELECTED_LABEL_CHARS)),
    };
  }
  return { version: SELECTED_CONTEXT_VERSION, state: "none", ...evidence };
}

/* ------------------------------------------------------------------ *
 * Validation                                                         *
 * ------------------------------------------------------------------ */

function optional<K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/** Collapse every control character (the whole C0/C1 range, not just newlines)
    to a space and bound the result. A single-line, printable value is what keeps
    a hostile card title out of a marker comment and out of a log line. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, max).join("").trim() || null;
}

/** A path is DROPPED when it breaks its bound, never truncated. A shortened
    path is not a shorter fact — it names a different file, or none — and this
    field is provenance an operator reads. The label above truncates because a
    clipped title still says which card, which is all a badge needs. */
function boundedPath(value: unknown): string | null {
  const cleaned = boundedText(value, MAX_SELECTED_PATH_CHARS + 1);
  return cleaned && cleaned.length <= MAX_SELECTED_PATH_CHARS ? cleaned : null;
}

function opaqueId(value: unknown): string | null {
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : null;
}

function revisionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function capturedAtOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Validate an untrusted reference — a request body, a journal marker, a replayed
 * record. Returns null when the record is not a reference at all; drops evidence
 * it cannot validate while keeping one that is.
 */
export function parseSelectedContextRef(value: unknown): SelectedContextRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.version !== SELECTED_CONTEXT_VERSION) return null;
  const capturedAt = capturedAtOf(body.capturedAt);
  if (!capturedAt) return null;
  const evidence: SelectedContextEvidence = {
    capturedAt,
    ...optional("project", boundedText(body.project, MAX_SELECTED_PROJECT_CHARS)),
    ...optional("viewSessionId", opaqueId(body.viewSessionId)),
    ...optional("deviceId", opaqueId(body.deviceId)),
    ...optional("revision", revisionOf(body.revision)),
  };
  if (body.state === "none") return { version: SELECTED_CONTEXT_VERSION, state: "none", ...evidence };
  if (body.state !== "selected") return null;
  const conversationId = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId)
    ? body.conversationId
    : null;
  if (!conversationId) return null;
  return {
    version: SELECTED_CONTEXT_VERSION,
    state: "selected",
    conversationId,
    ...evidence,
    ...optional("path", boundedPath(body.path)),
    ...optional("label", boundedText(body.label, MAX_SELECTED_LABEL_CHARS)),
  };
}

/* ------------------------------------------------------------------ *
 * Wire form                                                          *
 * ------------------------------------------------------------------ */

/** Base64url of the compact JSON: one token with no `-->`, no newline and no
    quoting hazard, so the reference can ride inside the structured-user marker
    comment without a second escaping scheme. */
export function encodeSelectedContextRef(ref: SelectedContextRef): string {
  const json = JSON.stringify(ref);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSelectedContextRef(value: string): SelectedContextRef | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return parseSelectedContextRef(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}
