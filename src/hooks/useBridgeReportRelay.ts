"use client";

import { useEffect, useRef } from "react";

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
 * - `deliver` — hand it to the client, then acknowledge. In that order: the cursor
 *   must never move past something the call did not receive.
 * - `already-acknowledged` — the batch reached the user but the cursor write was
 *   lost. Acknowledge immediately and nothing else. Skipping this is what leaves
 *   every later report queued behind something already spoken.
 * - `hold` / `idle` — nothing to do.
 */

type BridgeDeliveryPlanPayload =
  | { kind: "deliver"; delivery: RuntimeVoiceDelivery; throughSeq: number }
  | { kind: "already-acknowledged"; throughSeq: number }
  | { kind: "hold" }
  | { kind: "idle" };

export interface BridgeRelayClient {
  reconcileWorkerDeliveries(deliveries: readonly RuntimeVoiceDelivery[]): void;
}

/** Slightly under the coalescing window: polling faster cannot produce a batch any
    sooner, and polling slower would add latency the server already bounds. */
const POLL_MS = Math.floor(BRIDGE_LIVE_BATCH_INTERVAL_MS / 3);

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

    const poll = async (): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const parameters = new URLSearchParams();
        for (const id of acknowledgedRef.current) parameters.append("acked", id);
        if (lastBatchAtRef.current) parameters.set("lastBatchAt", lastBatchAtRef.current.toISOString());
        const response = await request(`/api/bridge?${parameters.toString()}`, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const payload = await response.json() as { plan?: BridgeDeliveryPlanPayload };
        const plan = payload.plan;
        if (!plan || cancelled) return;

        if (plan.kind === "deliver") {
          /* Into the call first. The client's own tombstones make a repeat of this
             delivery a no-op, so an acknowledgement lost after this point costs a
             duplicate attempt, never a duplicate utterance. */
          client.reconcileWorkerDeliveries([plan.delivery]);
          acknowledgedRef.current = [...acknowledgedRef.current, plan.delivery.deliveryId].slice(-256);
          lastBatchAtRef.current = new Date();
        } else if (plan.kind !== "already-acknowledged") {
          return;
        }
        await request("/api/bridge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ throughSeq: plan.throughSeq }),
        });
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
      clearInterval(timer);
    };
  }, [client, fetchFn, live, pollMs]);
}
