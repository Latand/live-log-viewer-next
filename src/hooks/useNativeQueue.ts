"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { projectNativeQueue, type NativeQueueView } from "@/components/nativeQueueView";
import type { NativeQueueSnapshot } from "@/lib/runtime/nativeCodexQueue";
import type { NativeQueueAction, NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";
import type { RuntimeSendSettings } from "@/lib/runtime/contracts";
import type { StructuredImageRef } from "@/lib/runtime/structuredContent";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";

/**
 * The operator's view of the native Codex queue, and the one place a control on
 * it is submitted from (#1629).
 *
 * READS ARRIVE BY PUSH. Native tells the host its queue changed
 * (`thread/queue/changed`), the host publishes that on the runtime bus as a
 * revision counter, and this refetches when the counter moves. A queue that is
 * not changing costs nothing, and a change the operator did not make — Codex
 * dispatching the head of the queue on its own — reaches the panel as fast as
 * one they did.
 *
 * EVERY WRITE IS AN ADMISSION. Every control POSTs one command with
 * its own immutable idempotency key and returns as soon as the journal has
 * committed it; the runtime's own executor is the single dispatch owner and this
 * adds no second scheduler. The reply is a receipt, so the row it belongs to
 * goes busy until the next read shows what actually happened — nothing here
 * infers a result from a 202.
 *
 * NOTHING IS RETRIED. A command whose outcome is unknown keeps its original key
 * and its original operation; replaying that key is the operator asking the same
 * question again, which the runtime answers with the same operation. A blind
 * second mutation is exactly what the native adapter refuses to do, and this
 * does not do it on its behalf.
 */

export interface NativeQueueMutation {
  action: NativeQueueAction;
  /**
   * The thread and account this command was admitted against.
   *
   * Absent means the conversation's live binding, which is what every ordinary
   * press wants. A REPLAY supplies the original one: an account switched between
   * the press and the replay must not silently move the message, and the journal
   * refusing a stale binding is an outcome where rebinding is not.
   */
  binding?: { threadId: string | null; accountId: string | null };
  entryId?: string;
  expectedRevision?: number;
  queuedSubmissionIds?: string[];
  text?: string;
  images?: StructuredImageRef[];
  runtime?: RuntimeSendSettings;
  selectedContext?: SelectedContextRef;
  /** Explicit null for an idle fence; a string permits only that active turn. */
  turnId?: string | null;
}

export interface NativeQueueSubmission {
  ok: boolean;
  /**
   * What the journal actually said, on a submission that did not succeed.
   *
   * `refused` is a verdict: the journal was reached, it answered, and it
   * admitted nothing. `unknown` is the absence of one — a thrown transport or a
   * server error, where the operation may already be committed. The two need
   * different next moves, and collapsing them into `ok: false` is how a caller
   * ends up minting a second key for an operation that already exists.
   */
  outcome?: "refused" | "unknown";
  /** The runtime's own words when it refused, for the row to show verbatim. */
  error?: string;
  status?: number;
  operationId?: string;
  /** The journal's own verdict, present only on a settled success. */
  receiptStatus?: string;
}

export interface NativeQueueState {
  view: NativeQueueView;
  /** True until the first read of this conversation's queue has answered. */
  loading: boolean;
  /** Why the queue could not be read, or null. Distinct from an empty queue. */
  error: string | null;
  refresh(): void;
  submit(mutation: NativeQueueMutation, idempotencyKey: string): Promise<NativeQueueSubmission>;
}

interface QueueRead {
  entries: NativeQueueRecord[];
  native: NativeQueueSnapshot | null;
}

const EMPTY_READ: QueueRead = { entries: [], native: null };

export interface NativeQueueDependencies {
  read(conversationId: string, signal: AbortSignal): Promise<QueueRead>;
  write(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}

async function readQueue(conversationId: string, signal: AbortSignal): Promise<QueueRead> {
  const response = await fetch(`/api/runtime/queue?conversationId=${encodeURIComponent(conversationId)}`, { signal });
  let body: Record<string, unknown>;
  /* AN UNREADABLE BODY IS A FAILED READ, at any status. Turning it into `{}` and
     then into an empty queue told the operator their queue was empty when the
     truth was that nobody could read it — and an empty queue renders no panel at
     all, so the message they queued would simply be gone from the screen. */
  try { body = await response.json() as Record<string, unknown>; }
  catch { throw new Error(`Codex's queue answered ${response.status} in a shape this Viewer could not read`); }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `queue read failed (${response.status})`);
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.entries)) {
    throw new Error("Codex's queue answered without the journal's own entries, so what it holds is unknown");
  }
  return {
    entries: body.entries as NativeQueueRecord[],
    native: (body.native ?? null) as NativeQueueSnapshot | null,
  };
}

async function writeQueue(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch("/api/runtime/queue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

export const productionNativeQueueDependencies: NativeQueueDependencies = { read: readQueue, write: writeQueue };

/** Every status the runtime journal can put on a receipt. A value outside this
    set is a build disagreement rather than a verdict. */
const KNOWN_RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  "pending", "delivering", "applying", "turn-started", "steered", "queued",
  "delivered", "applied", "interrupted", "answered", "rejected", "failed", "uncertain",
]);

/** Verdicts that mean the journal admitted nothing. */
const REFUSING_RECEIPT_STATUSES: ReadonlySet<string> = new Set(["rejected", "failed"]);

/**
 * Whether a reply is about THIS operation, checked before it is read as one.
 *
 * The journal answers `{ operationId, receipt }`, and the receipt carries its own
 * identity: the operation, the conversation, the idempotency key it was admitted
 * under and the kind of command it was. Every one of those has to match what
 * this request submitted, because a receipt that names another operation is
 * evidence about that operation and none at all about this one — however
 * well-formed it is, and whichever verdict it carries.
 *
 * THE VERDICT COMES SECOND ON PURPOSE. A foreign `rejected` used to release this
 * operation just as readily as a foreign `queued`: the refusal path never looked
 * at identity, so a reply about somebody else's request settled ours and the next
 * press minted a new key for an operation that may already exist. Missing or
 * contradictory identity is UNKNOWN, and the caller keeps its envelope.
 */
function receiptIdentity(
  body: Record<string, unknown>,
  expected: { conversationId: string; idempotencyKey: string },
):
  | { ok: true; operationId: string; receiptStatus: string }
  | { ok: false; reason: string } {
  const unknown = (reason: string) => ({ ok: false as const, reason });
  const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  const receipt = body.receipt && typeof body.receipt === "object" && !Array.isArray(body.receipt)
    ? body.receipt as Record<string, unknown>
    : null;
  if (!operationId) return unknown("Codex answered without naming an operation, so what happened to this one is unknown.");
  if (!receipt) return unknown("Codex answered without a receipt, so what happened to this request is unknown.");

  const field = (name: string) => typeof receipt[name] === "string" ? (receipt[name] as string) : "";
  const receiptStatus = field("status");
  if (!receiptStatus) return unknown("Codex answered with a receipt that carries no status, so what happened to this request is unknown.");
  if (!KNOWN_RECEIPT_STATUSES.has(receiptStatus)) {
    return unknown(`Codex answered with an unrecognised receipt status (${receiptStatus}), so what happened to this request is unknown.`);
  }
  /* Each of these is required, and each is checked against what WE sent. An
     absent one is as unusable as a wrong one: it leaves the receipt unattributed,
     which is the state this exists to refuse. */
  if (field("operationId") !== operationId) {
    return unknown("Codex answered with a receipt that names a different operation from the reply, so what happened to this request is unknown.");
  }
  if (field("conversationId") !== expected.conversationId) {
    return unknown("Codex answered with a receipt belonging to another conversation, so what happened to this request is unknown.");
  }
  if (field("idempotencyKey") !== expected.idempotencyKey) {
    return unknown("Codex answered with a receipt for another request, so what happened to this one is unknown.");
  }
  if (field("kind") !== "native-queue") {
    return unknown("Codex answered with a receipt for a different kind of command, so what happened to this request is unknown.");
  }
  return { ok: true, operationId, receiptStatus };
}

export function useNativeQueue(
  conversationId: string,
  options: {
    enabled: boolean;
    threadId: string | null;
    accountId: string | null;
    turn: "running" | "idle" | "unknown";
    /** The running turn's id, so a `send-now` fences against the right one. */
    activeTurnId: string | null;
    /** The runtime's own change counter; a move here is what triggers a read. */
    changeRevision: number;
  },
  dependencies: NativeQueueDependencies = productionNativeQueueDependencies,
): NativeQueueState {
  const { enabled, threadId, accountId, turn, activeTurnId, changeRevision } = options;
  const [read, setRead] = useState<QueueRead>(EMPTY_READ);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());

  const refresh = useCallback(() => setLocalRevision((current) => current + 1), []);

  /* A different conversation OR A DIFFERENT BINDING is a different queue, so
     nothing of the last one's is shown while the new one is being read.
     Registered before the read below, so it lands first in the same commit.

     The binding matters as much as the conversation: an account switch or a
     rehosted thread leaves the same card in front of the operator, and keeping
     the previous read meant rows belonging to a queue this Viewer no longer
     talks to stayed on screen with their controls live. Every one of those
     controls names a binding the runtime would refuse, so the operator's press
     buys a refusal — but the rows themselves were already a false statement
     about what Codex is holding, and a read that fails or never answers leaves
     them there indefinitely. */
  useEffect(() => {
    setRead(EMPTY_READ);
    setLoading(enabled);
    setError(null);
  }, [conversationId, enabled, threadId, accountId]);

  /* One read at a time, and the last one wins. A stale answer that arrived after
     a newer one must never overwrite it — that is how a panel ends up showing a
     queue the operator has already changed. */
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const mine = ++generation.current;
    void dependencies.read(conversationId, controller.signal)
      .then((answer) => {
        if (mine !== generation.current) return;
        setRead(answer);
        setError(null);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (mine !== generation.current || controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, dependencies, enabled, threadId, accountId, changeRevision, localRevision]);

  const submit = useCallback(async (mutation: NativeQueueMutation, idempotencyKey: string): Promise<NativeQueueSubmission> => {
    /* Nothing left this browser, so the journal holds nothing to replay. */
    if (!threadId) return { ok: false, outcome: "refused", error: "this conversation has no native Codex thread" };
    const entryId = mutation.entryId;
    if (entryId) setInFlight((current) => new Set(current).add(entryId));
    try {
      const { binding: replayBinding, ...command } = mutation;
      const answer = await dependencies.write({
        conversationId,
        idempotencyKey,
        binding: replayBinding ?? { threadId, accountId },
        ...command,
      });
      const error = typeof answer.body.error === "string" ? answer.body.error : "";
      const carriesReceipt = Boolean(answer.body.receipt) || typeof answer.body.operationId === "string";
      /* NO RECEIPT AT ALL. The route answered before the journal did — a parser
         refusal, an ownership conflict, a host that is not there — so there is no
         receipt to attribute and the HTTP code is the whole answer. A 5xx is the
         server failing to answer FOR the journal, where the write may have
         committed first, so only that one is unknown. */
      if (!carriesReceipt) {
        if (answer.status >= 500) {
          return { ok: false, outcome: "unknown", status: answer.status, error: error || `Codex could not answer for the queue (${answer.status}).` };
        }
        if (answer.status >= 400) {
          return { ok: false, outcome: "refused", status: answer.status, error: error || `Codex refused this change (${answer.status}).` };
        }
        return {
          ok: false,
          outcome: "unknown",
          status: answer.status,
          error: "Codex accepted the request without saying what it did with it, so whether it was queued is unknown.",
        };
      }
      /* A RECEIPT IS EVIDENCE ONLY ABOUT THE OPERATION IT NAMES, and this checks
         that before reading its verdict — at any status, including a refusal.
         A reply about somebody else's request settles nothing here. */
      const identified = receiptIdentity(answer.body, { conversationId, idempotencyKey });
      if (!identified.ok) {
        return { ok: false, outcome: "unknown", status: answer.status, error: identified.reason };
      }
      /* Now the verdict, from the receipt this operation actually owns. A
         rejected or failed receipt is a refusal even at 202: the journal answers
         with the operation it holds and its status IS the verdict, where the HTTP
         code only says the request was understood. */
      if (REFUSING_RECEIPT_STATUSES.has(identified.receiptStatus)) {
        return {
          ok: false,
          outcome: "refused",
          status: answer.status,
          error: error || `Codex refused this change (${identified.receiptStatus})`,
        };
      }
      /* A 5xx still outranks an otherwise good-looking receipt: the server did
         not finish answering, so what reached us may not be the whole of it. */
      if (answer.status >= 500) {
        return { ok: false, outcome: "unknown", status: answer.status, error: error || `Codex could not answer for the queue (${answer.status}).` };
      }
      if (answer.status >= 400) {
        return { ok: false, outcome: "refused", status: answer.status, error: error || `Codex refused this change (${answer.status}).` };
      }
      return { ok: true, status: answer.status, operationId: identified.operationId, receiptStatus: identified.receiptStatus };
    } catch (failure) {
      /* The request may or may not have reached the journal. Replaying the SAME
         key is the only safe next move, and it is the operator's to make. */
      return { ok: false, outcome: "unknown", error: failure instanceof Error ? failure.message : String(failure) };
    } finally {
      if (entryId) {
        setInFlight((current) => {
          const next = new Set(current);
          next.delete(entryId);
          return next;
        });
      }
      refresh();
    }
  }, [accountId, conversationId, dependencies, refresh, threadId]);

  const view = useMemo(
    () => projectNativeQueue({ entries: read.entries, native: read.native, turn, activeTurnId, inFlight }),
    [activeTurnId, inFlight, read.entries, read.native, turn],
  );

  return { view, loading, error, refresh, submit };
}
