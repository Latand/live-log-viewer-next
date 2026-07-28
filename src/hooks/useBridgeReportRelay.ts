"use client";

import { useCallback, useEffect, useRef } from "react";

import { operatorHeaders } from "@/components/operatorCredential";
import {
  bridgeAcknowledgementFor,
  forgetBridgeAcknowledgement,
  pendingBridgeAcknowledgements,
  rememberBridgeAcknowledgement,
} from "@/lib/bridge/pendingAcknowledgements";
import { BRIDGE_LIVE_BATCH_INTERVAL_MS } from "@/lib/bridge/types";
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";

/**
 * The production relay: manager reports into the live call (#691 §4).
 *
 * This is the loop that was missing. The durable half of the bridge is a file and
 * an API route; something has to actually pull from it while a call is up and hand
 * what it finds to the one realtime client. That something is here, in the card's
 * tree — the opener — because it is a polling effect, and §4 rule 4 keeps every
 * polling effect and every dispatcher out of the PiP portal.
 *
 * Runs only while the call is live. There is no call to interject into otherwise,
 * and the design is explicit that nothing pushes when no call is up: the gateway's
 * next turn drains instead.
 *
 * Three outcomes, three different obligations, which is why the plan is a tagged
 * union rather than a nullable delivery:
 *
 * - `deliver` — hand it to the client and park the cursor. The acknowledgement is
 *   NOT sent here: `reconcileWorkerDeliveries` only enqueues, and a cursor advanced
 *   on an enqueue is exactly-once inverted — a crash before the host writes loses
 *   the report while the cursor swears it arrived. The cursor moves in the
 *   confirmation listener, when the host says the session took it.
 * - `already-acknowledged` — the batch provably reached the session but the cursor
 *   write was lost. Acknowledge immediately and nothing else. Skipping this leaves
 *   every later report queued behind something already spoken.
 * - `hold` / `idle` — nothing to do.
 */

type BridgeDeliveryPlanPayload =
  | { kind: "deliver"; delivery: RuntimeVoiceDelivery; ackToken: string }
  | { kind: "already-acknowledged"; ackToken: string }
  | { kind: "hold" }
  | { kind: "idle" };

export interface BridgeRelayClient {
  reconcileWorkerDeliveries(deliveries: readonly RuntimeVoiceDelivery[]): void;
  /** Fires when the runtime host has durably accepted a delivery. */
  onDeliveryAcknowledged(listener: (deliveryId: string) => void): () => void;
  /** #691 §4: this call's credential. The inbox carries deploy nonces, so reading it
      needs the same proof writing into the call does. */
  realtimeSession(): string | null;
}

/** Slightly under the coalescing window: polling faster cannot produce a batch any
    sooner, and polling slower would add latency the server already bounds. */
const POLL_MS = Math.floor(BRIDGE_LIVE_BATCH_INTERVAL_MS / 3);

/**
 * The no-call half of the relay (§4): drain at the start of the gateway's turn.
 *
 * Returned as a callback rather than run on a timer, because a turn is an event
 * the card already owns — it is the submit. Nothing pushes while no call is live;
 * this pulls once, at the only moment the inbox is about to matter.
 *
 * The cursor is acknowledged only after the caller reports the turn actually left,
 * for the reason the live path parks its cursor: a batch folded into a message that
 * never sent must arrive again.
 */
export interface BridgeTurnStart {
  /** Prepended to the turn's own input; "" when nothing is pending. */
  text: string;
  /** The token that settles this batch, or "" when nothing was drained. Handed to
      the caller so a send that settles LATER can still acknowledge it. */
  ackToken: string;
  /**
   * Advance the cursor — call ONLY once the turn carrying `text` has been durably
   * admitted. Same rule as the live path, same reason: a batch folded into a
   * message that was rejected, deadlined or never sent has not reached anyone, and
   * a cursor moved on composing it would lose those reports permanently.
   */
  commit: () => void;
}

const NOTHING_PENDING: BridgeTurnStart = { text: "", ackToken: "", commit: () => undefined };

/**
 * Settle a batch whose turn was admitted after the fact.
 *
 * A structured send answers `ok` with a receipt that may still be `pending`, and the
 * durable admission arrives later on the receipt stream — by which time the closure
 * that drained the batch is long gone. Acknowledging by TOKEN rather than by closure
 * is what lets the cursor move then: the token is a value, so it survives being
 * stored beside the delivery key and replayed once.
 */
export async function commitBridgeTurn(ackToken: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!ackToken) return;
  /* Awaitable and throwing on refusal, so the caller can keep the token when the
     cursor did not actually move. Swallowing the failure here is what left batches
     parked with nothing able to settle them. */
  const response = await fetchFn("/api/bridge", {
    method: "POST",
    headers: { "content-type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({ ackToken }),
  });
  if (!response.ok) throw new Error(`bridge acknowledgement refused with ${response.status}`);
}

export function useBridgeTurnStartDrain(
  enabled: boolean,
  options: { fetchFn?: typeof fetch } = {},
): () => Promise<BridgeTurnStart> {
  const fetchFn = options.fetchFn;
  return useCallback(async () => {
    if (!enabled) return NOTHING_PENDING;
    const request = fetchFn ?? fetch;
    try {
      /* No session id, deliberately: this is the path taken when NO call is live, so
         requiring one would mean the inbox drains only while it is not needed. The
         operator credential is what proves this is the Viewer opening a turn. */
      const response = await request("/api/bridge?mode=turn-start", {
        cache: "no-store",
        headers: operatorHeaders(),
      });
      if (!response.ok) return NOTHING_PENDING;
      const payload = await response.json() as { prelude?: { text: string; ackToken: string } | null };
      const prelude = payload.prelude;
      if (!prelude?.text) return NOTHING_PENDING;
      return {
        text: prelude.text,
        ackToken: prelude.ackToken,
        /* Through `commitBridgeTurn` rather than its own fetch, so this path gets the
           same rule as every other acknowledgement: a refusal is a refusal. The inline
           version treated any response as a settle, which turned a 403 or a 409 into a
           silently lost batch. Fire-and-forget by contract — the caller holds the
           token and can spend it again — so the rejection is absorbed here. */
        commit: () => {
          void commitBridgeTurn(prelude.ackToken, request).catch(() => undefined);
        },
      };
    } catch {
      /* The reports are durable and the cursor did not move: the next turn tries
         again. A blocked send would be a far worse failure than a late report. */
      return NOTHING_PENDING;
    }
  }, [enabled, fetchFn]);
}

export function useBridgeReportRelay(
  client: BridgeRelayClient | null,
  live: boolean,
  options: { fetchFn?: typeof fetch; pollMs?: number } = {},
): void {
  const acknowledgedRef = useRef<string[]>([]);
  const lastBatchAtRef = useRef<Date | null>(null);
  /* Held in a ref rather than state: a poll in flight must not be restarted by the
     re-render its own result causes. */
  const busyRef = useRef(false);

  const fetchFn = options.fetchFn;
  const pollMs = options.pollMs ?? POLL_MS;

  useEffect(() => {
    if (!client || !live) return;
    const request = fetchFn ?? fetch;
    let cancelled = false;

    /**
     * Settle a batch, and REPORT WHETHER IT SETTLED.
     *
     * The version this replaces awaited the fetch and then resolved, whatever came
     * back. `fetch` rejects only on transport failure, so a 403 from an unauthenticated
     * poll, a 409 on a token the server no longer holds, and a 500 mid-write all
     * resolved as success — and every caller here treats success as permission to
     * delete the token. The one thing that could settle the batch was thrown away
     * precisely when the batch had NOT been settled, which loses the reports
     * permanently: the server's cursor never moved, and nothing is left to move it.
     *
     * So a refusal throws, and the token stays parked for the next poll to spend.
     */
    const acknowledgeCursor = async (ackToken: string): Promise<void> => {
      const response = await request("/api/bridge", {
        method: "POST",
        headers: { "content-type": "application/json", ...operatorHeaders() },
        /* The token the batch was handed out with — never a sequence of our own
           choosing, which the server would be right to refuse. */
        body: JSON.stringify({ ackToken, realtimeSessionId: client.realtimeSession() }),
      });
      if (!response.ok) throw new Error(`bridge acknowledgement refused with ${response.status}`);
    };

    const settle = (deliveryId: string): void => {
      const ackToken = bridgeAcknowledgementFor(deliveryId);
      if (!ackToken || cancelled) return;
      /* Now — and only now — has the report provably reached the session. */
      acknowledgedRef.current = [...acknowledgedRef.current, deliveryId].slice(-256);
      void acknowledgeCursor(ackToken)
        /* Only an ACCEPTED acknowledgement drops the token. `acknowledgeCursor` now
           throws on a refusal, so this `.then` no longer fires for a 403 or a 409 —
           which is what used to delete the token while the cursor stood still. */
        .then(() => forgetBridgeAcknowledgement(deliveryId))
        .catch(() => {
          /* The cursor did not move, so the token is still the only thing that can
             settle this batch. It stays parked, and the poll's retry sweep spends it. */
        });
    };
    const releaseAcknowledged = client.onDeliveryAcknowledged(settle);

    const poll = async (): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const session = client.realtimeSession();
        /* No credential, no read: the inbox carries deploy nonces. A call that has
           not finished its SDP exchange has nothing to present yet, and waits — and
           it must not acknowledge anything either, which is why the retry below sits
           after this check rather than before it. */
        if (!session) return;

        /* Autonomous retry. A token parked by a torn-down effect, a reload mid-call,
           or a refused POST is spent here rather than waiting for a confirmation that
           already happened and will not fire again.

           AWAITED, not fired off. The drain below reports what is still outstanding,
           and starting it while these are in flight asks the server a question whose
           answer these retries are busy changing: the GET would see the batch still
           unsettled and hand out a second token for it, so the same reports come back
           and the acknowledgement that lands second is refused against a cursor that
           already moved. One at a time is also cheap here — the whole point is that
           there is usually nothing parked. */
        await Promise.all(pendingBridgeAcknowledgements().map(async (entry) => {
          if (!entry.waitingOn.startsWith("voice:")) return;
          try {
            await acknowledgeCursor(entry.ackToken);
            forgetBridgeAcknowledgement(entry.waitingOn);
          } catch {
            /* Still the only thing that can settle this batch; the next poll retries. */
          }
        }));
        if (cancelled) return;

        const parameters = new URLSearchParams({ realtimeSessionId: session });
        for (const id of acknowledgedRef.current) parameters.append("acked", id);
        if (lastBatchAtRef.current) parameters.set("lastBatchAt", lastBatchAtRef.current.toISOString());
        const response = await request(`/api/bridge?${parameters.toString()}`, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const payload = await response.json() as { plan?: BridgeDeliveryPlanPayload };
        const plan = payload.plan;
        if (!plan || cancelled) return;

        if (plan.kind === "deliver") {
          /* Enqueue only. `reconcileWorkerDeliveries` puts the batch in an
             in-memory queue and returns; the host has not written anything yet.
             Advancing the cursor here would invert exactly-once — a crash in
             between loses the report while the cursor claims it was delivered — so
             the batch is parked until the host confirms, above. */
          /* Parked OUTSIDE this effect: a call-phase transition tears the effect down,
             and the host's confirmation would then arrive with nothing left to spend. */
          rememberBridgeAcknowledgement(plan.delivery.deliveryId, plan.ackToken);
          client.reconcileWorkerDeliveries([plan.delivery]);
          lastBatchAtRef.current = new Date();
          return;
        }
        if (plan.kind !== "already-acknowledged") return;
        /* Already spoken and provably received; this only heals the cursor. A refusal
           throws into the poll's own catch, and the server hands out a fresh token for
           the same batch on the next GET — nothing is parked here because there is no
           delivery left to wait on. */
        await acknowledgeCursor(plan.ackToken);
      } catch {
        /* A dropped poll is a retry, not an incident: the reports are durable and
           the cursor did not move. Surfacing a transport blip mid-call would be
           noise on the one surface that must stay calm. */
      } finally {
        busyRef.current = false;
      }
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, pollMs);
    return () => {
      cancelled = true;
      releaseAcknowledged();
      clearInterval(timer);
    };
  }, [client, fetchFn, live, pollMs]);
}
