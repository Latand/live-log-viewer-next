import type { NativeQueuedSubmission, NativeQueueSnapshot } from "@/lib/runtime/nativeCodexQueue";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";
import type { RuntimeSendSettings } from "@/lib/runtime/contracts";
import type { StructuredImageRef } from "@/lib/runtime/structuredContent";

/**
 * What the operator sees of the native Codex queue, and what they may do to it
 * (#1629).
 *
 * TWO SOURCES, AND THEY MEAN DIFFERENT THINGS. The Viewer's journal says what
 * this Viewer admitted, with every payload version and the proof of delivery
 * when there is one. The native snapshot says what Codex is actually holding,
 * in the order Codex will dispatch it. Neither is a substitute for the other:
 * the journal knows about a mutation the queue has not acknowledged yet, and
 * only the queue knows the order.
 *
 * So the rows are the journal's, ORDERED BY THE QUEUE, and every row says which
 * of the two it was seen in. A row the journal holds and the queue does not is
 * not "delivered" and not "gone" — the runtime is explicit that a disappearance
 * settles nothing — so it says what it is: acknowledged and not observed, or
 * not acknowledged at all.
 *
 * Pure, so the whole table can be driven in a test without a browser, a socket
 * or a host.
 */

/** Whether an entry may still be changed, and why not when it may not.
    `start` is native's own idle dispatch of one entry, which is the only route
    back for a payload native no longer holds; `send-now` is the steer. */
export type NativeQueueRowAction = "edit" | "delete" | "send-now" | "move" | "start";

/**
 * Why a row offers no controls.
 *
 * A CODE, NOT A SENTENCE. This module is pure and locale-free — it runs in
 * tests, in a capture script and in the panel — so it names the condition and
 * the view translates it. Emitting English prose here is how half a panel ends
 * up in one language.
 */
export type NativeQueueBlockedCode =
  | "busy"
  | "dispatched"
  | "delivered"
  | "removed"
  | "refused"
  | "uncertain"
  | "withdrawn-running"
  | "unacknowledged";

export interface NativeQueueBlocked {
  code: NativeQueueBlockedCode;
  /** The runtime's own words, when it gave any. Shown verbatim beside the code
      because a refusal the operator cannot read is a refusal they cannot act on. */
  detail?: string;
}

/** Why the queue as a whole cannot be fully acted on. */
export type NativeQueueNotice =
  | { code: "stale" }
  | { code: "pending"; count: number };

export interface NativeQueueRow {
  entryId: string;
  clientUserMessageId: string;
  nativeSubmissionId: string | null;
  revision: number;
  /** The latest admitted version's text. */
  text: string;
  /** The latest admitted version's attachments, so an edit of the words carries
      them forward instead of admitting a payload that has lost them. */
  images: readonly StructuredImageRef[];
  imageCount: number;
  state: NativeQueueRecord["state"];
  /** The runtime's own reason for a refusal or an unknown outcome. */
  reason: string | null;
  /** A mutation of this entry is in flight and nothing else may be started. */
  busy: boolean;
  /** Present in the native snapshot this read carried. */
  observedInNative: boolean;
  /** The version that was dispatched, once one was; it can never change. */
  dispatchedRevision: number | null;
  /** Canonical history has proved this entry became a turn. */
  proven: boolean;
  /** What the operator asked for when they queued it, for audit only. */
  requestedRuntime: RuntimeSendSettings | null;
  /** The controls this row may offer right now. */
  actions: readonly NativeQueueRowAction[];
  /** Why the row offers no controls, when it offers none. */
  blocked: NativeQueueBlocked | null;
}

export interface NativeQueueView {
  rows: NativeQueueRow[];
  /** True when the native snapshot could not be read on this pass; the order
      and the "observed" column are then the last ones known, not current. */
  nativeStale: boolean;
  /** The queue can be started only from an idle thread. */
  canStart: boolean;
  /** The turn a `send-now` must fence against, or null when the thread is idle.
      Naming the wrong one is refused by the runtime, so the panel never guesses
      it. */
  activeTurnId: string | null;
  /** Entries whose order this Viewer may submit: native submission ids, in the
      order shown. Empty when the queue's own order is unknown. */
  reorderable: string[];
  /** One line about anything the operator cannot act on. */
  notice: NativeQueueNotice | null;
}

export interface NativeQueueViewInput {
  entries: readonly NativeQueueRecord[];
  native: NativeQueueSnapshot | null;
  /** The thread's current turn, from the runtime session projection. */
  turn: "running" | "idle" | "unknown";
  /** The turn currently running, from the same projection; null when idle. */
  activeTurnId?: string | null;
  /** Entry ids with a Viewer mutation in flight from this browser. */
  inFlight?: ReadonlySet<string>;
}

/** States that describe an entry the queue no longer holds, either way. */
const TERMINAL: ReadonlySet<NativeQueueRecord["state"]> = new Set(["delivered", "removed", "refused"]);

function latestVersion(entry: NativeQueueRecord) {
  return entry.versions.find((version) => version.revision === entry.revision) ?? entry.versions.at(-1) ?? null;
}

function nativeOrder(items: readonly NativeQueuedSubmission[] | null | undefined): Map<string, number> {
  const order = new Map<string, number>();
  for (const [index, item] of (items ?? []).entries()) {
    order.set(item.clientUserMessageId, index);
    order.set(item.id, index);
  }
  return order;
}

/**
 * What this row may offer, and the one sentence that says why when it offers
 * nothing.
 *
 * The rules are the runtime's, restated where the operator can see them:
 *
 * - A DISPATCHED VERSION IS FROZEN. Once an entry has a dispatched revision it
 *   became a turn, and a turn's payload is not editable by anything.
 * - AN ENTRY NATIVE HAS NOT ACKNOWLEDGED HAS NO HANDLE. Update, delete and send
 *   now all name the native submission, so an entry still waiting for its own
 *   acknowledgement can only be waited on. Offering a control that would be
 *   refused on the wire is worse than showing it disabled with the reason.
 * - AN UNCERTAIN ENTRY IS NOT RETRIED FROM HERE. The runtime keeps the original
 *   operation and its payload; a second mutation would be a second attempt at
 *   something whose first outcome nobody knows.
 */
function rowActions(
  entry: NativeQueueRecord,
  busy: boolean,
  turn: NativeQueueViewInput["turn"],
): { actions: NativeQueueRowAction[]; blocked: NativeQueueBlocked | null } {
  if (busy) return { actions: [], blocked: { code: "busy" } };
  if (entry.dispatchedRevision !== null || entry.state === "dispatching") {
    return { actions: [], blocked: { code: "dispatched" } };
  }
  if (TERMINAL.has(entry.state)) {
    if (entry.state === "delivered") return { actions: [], blocked: { code: "delivered" } };
    if (entry.state === "removed") return { actions: [], blocked: { code: "removed" } };
    return { actions: [], blocked: { code: "refused", ...(entry.reason ? { detail: entry.reason } : {}) } };
  }
  if (entry.state === "uncertain") {
    return { actions: [], blocked: { code: "uncertain", ...(entry.reason ? { detail: entry.reason } : {}) } };
  }
  if (entry.state === "withdrawn") {
    /* Withdrawn means native no longer holds it and the Viewer still does: the
       payload survived a send-now whose steer did not land. Only an explicit
       idle START can move it — the runtime refuses every other action on a
       withdrawn entry, so offering `send-now` here was offering the one control
       that could never be admitted, and the operator's words had no route back
       at all. */
    return turn === "idle"
      ? { actions: ["start"], blocked: null }
      : { actions: [], blocked: { code: "withdrawn-running" } };
  }
  if (!entry.nativeSubmissionId) return { actions: [], blocked: { code: "unacknowledged" } };
  return { actions: ["edit", "delete", "move", "send-now"], blocked: null };
}

export function projectNativeQueue(input: NativeQueueViewInput): NativeQueueView {
  const inFlight = input.inFlight ?? new Set<string>();
  const order = nativeOrder(input.native?.items);
  /* THE QUEUE, AND ONLY THE QUEUE. The journal returns up to 128 settled rows so
     a reader can see history; the panel is the operator's view of what Codex may
     still dispatch, and counting delivered messages into its header read
     "129 messages" above a queue holding one. History belongs to the transcript,
     which is where a delivered message actually appears. */
  const live = input.entries.filter((entry) => !TERMINAL.has(entry.state));
  const rows: NativeQueueRow[] = live.map((entry) => {
    const version = latestVersion(entry);
    const busy = inFlight.has(entry.entryId) || (entry.mutationOperationId !== null && entry.state !== "uncertain");
    const { actions, blocked } = rowActions(entry, busy, input.turn);
    return {
      entryId: entry.entryId,
      clientUserMessageId: entry.clientUserMessageId,
      nativeSubmissionId: entry.nativeSubmissionId,
      revision: entry.revision,
      text: version?.text ?? "",
      images: version?.images ?? [],
      imageCount: version?.images.length ?? 0,
      state: entry.state,
      reason: entry.reason,
      busy,
      observedInNative: entry.nativeSubmissionId !== null && order.has(entry.nativeSubmissionId),
      dispatchedRevision: entry.dispatchedRevision,
      proven: entry.proof !== null,
      requestedRuntime: version?.requestedRuntime ?? null,
      actions,
      blocked,
    };
  });
  /* Codex's order, and the Viewer's only for what Codex has not acknowledged
     yet. A row with no place in the queue sorts after the ones that have one,
     in the order this Viewer admitted them — which is where it will land. */
  const admitted = new Map(input.entries.map((entry, index) => [entry.entryId, index]));
  rows.sort((left, right) => {
    const leftPlace = left.nativeSubmissionId === null ? undefined : order.get(left.nativeSubmissionId);
    const rightPlace = right.nativeSubmissionId === null ? undefined : order.get(right.nativeSubmissionId);
    if (leftPlace !== undefined && rightPlace !== undefined) return leftPlace - rightPlace;
    if (leftPlace !== undefined) return -1;
    if (rightPlace !== undefined) return 1;
    return (admitted.get(left.entryId) ?? 0) - (admitted.get(right.entryId) ?? 0);
  });
  const nativeStale = input.native === null || input.native.stale || input.native.items === null;
  const observed = rows.filter((row) => row.observedInNative);
  /* Rows that are genuinely WAITING for Codex to acknowledge them, which is what
     the notice says of them. A withdrawn entry is one Codex deliberately no
     longer holds and an uncertain one has its own sentence on its own row; both
     counted here made the notice describe the opposite of their situation. */
  const pending = rows.filter((row) => !row.observedInNative && !TERMINAL.has(row.state)
    && row.state !== "withdrawn" && row.state !== "uncertain");
  return {
    rows,
    nativeStale,
    /* Native starts the queue only from an idle thread, and the runtime refuses
       a start whose idle state it cannot prove. Showing the control while a turn
       is running would be an offer the wire will not keep. */
    canStart: input.turn === "idle" && observed.length > 0 && !nativeStale,
    activeTurnId: input.turn === "running" ? input.activeTurnId ?? null : null,
    reorderable: nativeStale ? [] : observed.map((row) => row.nativeSubmissionId!),
    notice: nativeStale
      ? { code: "stale" }
      : pending.length > 0 ? { code: "pending", count: pending.length } : null,
  };
}

/**
 * The order this Viewer would submit after moving one entry (#1629).
 *
 * Native reorders by SUBMISSION ID and by nothing else, so an entry Codex has
 * not acknowledged cannot take part: it has no id to name. Moving is therefore
 * defined over the observed rows alone, and an unobserved row keeps its place
 * at the end.
 *
 * Returns null when the move changes nothing, so a caller has one obvious way
 * to skip a pointless round trip.
 */
export function reorderedNativeQueue(
  view: NativeQueueView,
  nativeSubmissionId: string,
  direction: "up" | "down",
): string[] | null {
  const ids = [...view.reorderable];
  const index = ids.indexOf(nativeSubmissionId);
  if (index < 0) return null;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= ids.length) return null;
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  return ids;
}

/**
 * What the queue can honestly say about the settings a message will run on.
 *
 * Native's queue parameters carry NO model or effort: a queued submission
 * inherits the thread's profile at the moment Codex dispatches it, which is what
 * `profilePolicy: "thread-at-dispatch"` records. So a queued entry's requested
 * settings are audit — what the operator asked for when they queued it — and the
 * effective settings are the thread's, whatever they are then. Presenting the
 * request as a promise would be inventing a frozen profile the protocol does not
 * have.
 */
export function nativeQueueProfile(
  row: Pick<NativeQueueRow, "requestedRuntime">,
  thread: { model: string | null; effort: string | null },
): { effective: string | null; requested: string | null } {
  const effective = [thread.model, thread.effort].filter(Boolean).join(" · ") || null;
  const requested = [row.requestedRuntime?.model, row.requestedRuntime?.effort].filter(Boolean).join(" · ") || null;
  return { effective, requested: requested && requested !== effective ? requested : null };
}
