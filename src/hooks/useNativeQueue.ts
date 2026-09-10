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
 * READS ARE PUSHED, NEVER POLLED. Native tells the host its queue changed
 * (`thread/queue/changed`), the host publishes that on the runtime bus as a
 * revision counter, and this refetches when the counter moves. A queue that is
 * not changing costs nothing, and a change the operator did not make — Codex
 * dispatching the head of the queue on its own — reaches the panel as fast as
 * one they did.
 *
 * WRITES ARE ADMISSIONS, NOT ACTUATIONS. Every control POSTs one command with
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

/** Receipt statuses the runtime journal can answer an admission with. A value
    outside this set is a build disagreement rather than a verdict. */
const ADMITTED_RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  "pending", "delivering", "applying", "turn-started", "steered", "queued",
  "delivered", "applied", "interrupted", "answered", "uncertain",
]);

/**
 * Whether a non-error reply actually identifies the operation it settled.
 *
 * The journal's own answer is `{ operationId, receipt }`. Anything short of that
 * — a body that lost its envelope in a proxy, a receipt with no status, a status
 * this build does not know — cannot be read as "your message is queued", and
 * reading it that way is how a possibly-admitted operation was released and then
 * submitted again under a new identity.
 */
function settledEnvelope(body: Record<string, unknown>):
  | { ok: true; operationId: string; receiptStatus: string }
  | { ok: false; reason: string } {
  const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  const receipt = body.receipt && typeof body.receipt === "object" && !Array.isArray(body.receipt)
    ? body.receipt as Record<string, unknown>
    : null;
  const receiptStatus = receipt && typeof receipt.status === "string" ? receipt.status : "";
  if (!operationId) return { ok: false, reason: "Codex accepted the request but named no operation, so whether it was queued is unknown." };
  if (!receiptStatus) return { ok: false, reason: "Codex accepted the request but returned no receipt status, so whether it was queued is unknown." };
  if (!ADMITTED_RECEIPT_STATUSES.has(receiptStatus)) {
    return { ok: false, reason: `Codex answered with an unrecognised receipt status (${receiptStatus}), so whether it was queued is unknown.` };
  }
  /* The receipt must be about the operation the reply names, when it says. */
  if (typeof receipt!.operationId === "string" && receipt!.operationId !== operationId) {
    return { ok: false, reason: "Codex answered with a receipt for a different operation, so whether this one was queued is unknown." };
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
      const failed = answer.status >= 400;
      const receipt = answer.body.receipt as { status?: string } | undefined;
      /* A REJECTED RECEIPT IS A FAILURE EVEN AT 202. The journal answers with the
         operation it holds, and its status is the verdict; the HTTP code only
         says the request was understood. */
      const rejected = receipt?.status === "rejected" || receipt?.status === "failed";
      if (failed || rejected) {
        return {
          ok: false,
          /* A 5xx is the server failing to answer for the journal, which is not
             the journal refusing: the write may have committed before the
             failure. Only a verdict it actually gave settles the operation. */
          outcome: answer.status >= 500 ? "unknown" : "refused",
          status: answer.status,
          error: typeof answer.body.error === "string"
            ? answer.body.error
            : `Codex refused this change (${receipt?.status ?? answer.status})`,
        };
      }
      /* A SUCCESSFUL STATUS IS NOT A SUCCESSFUL ANSWER. The journal replies with
         the operation it committed — an id and a receipt whose status is one it
         knows — and only that settles anything. A 202 carrying `{}`, a receipt
         with no status, or a status this build has never heard of describes a
         write whose fate nobody here can state, so it is UNKNOWN and the caller
         keeps its operation rather than releasing it as delivered. */
      const settled = settledEnvelope(answer.body);
      if (!settled.ok) {
        return { ok: false, outcome: "unknown", status: answer.status, error: settled.reason };
      }
      return { ok: true, status: answer.status, operationId: settled.operationId, receiptStatus: settled.receiptStatus };
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
