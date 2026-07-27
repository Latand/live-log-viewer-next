"use client";

import { useCallback, useEffect, useRef } from "react";

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
  /**
   * Advance the cursor — call ONLY once the turn carrying `text` has been durably
   * admitted. Same rule as the live path, same reason: a batch folded into a
   * message that was rejected, deadlined or never sent has not reached anyone, and
   * a cursor moved on composing it would lose those reports permanently.
   */
  commit: () => void;
}

const NOTHING_PENDING: BridgeTurnStart = { text: "", commit: () => undefined };

export function useBridgeTurnStartDrain(
  enabled: boolean,
  options: { fetchFn?: typeof fetch; realtimeSession?: () => string | null } = {},
): () => Promise<BridgeTurnStart> {
  const fetchFn = options.fetchFn;
  const realtimeSession = options.realtimeSession;
  return useCallback(async () => {
    if (!enabled) return NOTHING_PENDING;
    const request = fetchFn ?? fetch;
    const session = realtimeSession?.() ?? null;
    /* Same credential as the live drain: the inbox carries deploy nonces, so a turn
       that cannot prove it is the gateway reads nothing. */
    if (!session) return NOTHING_PENDING;
    try {
      const response = await request(
        `/api/bridge?mode=turn-start&realtimeSessionId=${encodeURIComponent(session)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return NOTHING_PENDING;
      const payload = await response.json() as { prelude?: { text: string; ackToken: string } | null };
      const prelude = payload.prelude;
      if (!prelude?.text) return NOTHING_PENDING;
      return {
        text: prelude.text,
        commit: () => {
          void request("/api/bridge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ackToken: prelude.ackToken, realtimeSessionId: session }),
          }).catch(() => undefined);
        },
      };
    } catch {
      /* The reports are durable and the cursor did not move: the next turn tries
         again. A blocked send would be a far worse failure than a late report. */
      return NOTHING_PENDING;
    }
  }, [enabled, fetchFn, realtimeSession]);
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

    /* Batches handed to the client and still waiting on the host's confirmation.
       The cursor for each moves only when its delivery id comes back. */
    const awaitingConfirmation = new Map<string, string>();

    const acknowledgeCursor = async (ackToken: string): Promise<void> => {
      await request("/api/bridge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* The token the batch was handed out with — never a sequence of our own
           choosing, which the server would be right to refuse. */
        body: JSON.stringify({ ackToken, realtimeSessionId: client.realtimeSession() }),
      });
    };

    const releaseAcknowledged = client.onDeliveryAcknowledged((deliveryId) => {
      const ackToken = awaitingConfirmation.get(deliveryId);
      if (ackToken === undefined || cancelled) return;
      awaitingConfirmation.delete(deliveryId);
      /* Now — and only now — has the report provably reached the session. */
      acknowledgedRef.current = [...acknowledgedRef.current, deliveryId].slice(-256);
      void acknowledgeCursor(ackToken).catch(() => undefined);
    });

    const poll = async (): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const session = client.realtimeSession();
        /* No credential, no read: the inbox carries deploy nonces. A call that has
           not finished its SDP exchange has nothing to present yet, and waits. */
        if (!session) return;
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
          awaitingConfirmation.set(plan.delivery.deliveryId, plan.ackToken);
          client.reconcileWorkerDeliveries([plan.delivery]);
          lastBatchAtRef.current = new Date();
          return;
        }
        if (plan.kind !== "already-acknowledged") return;
        /* Already spoken and provably received; this only heals the cursor. */
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
