"use client";

import { useCallback, useEffect, useState } from "react";

import type { AttentionEvent } from "@/lib/attention/machine";
import type { DeviceAttentionView } from "@/lib/attention/service";
import type { AttentionRequestV1, FocusResolutionKind, ReturnPoint } from "@/lib/attention/types";

/**
 * The client half of #688's ask-accept-decline-return loop.
 *
 * The record is the authority; this only reads it and posts answers back. Two
 * things are worth naming:
 *
 * - rendering an offer is itself a transition (`pending` → `offered`), because
 *   "no active device ever showed it" and "they saw it and said nothing" are
 *   different facts, and the expiry line the operator hears depends on which;
 * - the return point is captured HERE, immediately before the move, from this
 *   device's own viewport — never from presence, and never shared with another
 *   device.
 */

/** The viewport this device is about to leave. */
export type ViewportCapture = () => Pick<ReturnPoint, "mode" | "camera" | "focusedPath">;

export interface AttentionOffersHandle {
  view: DeviceAttentionView | null;
  offer: DeviceAttentionView["offer"];
  accept: (request: AttentionRequestV1, via?: "operator" | "auto-follow") => Promise<void>;
  preview: (request: AttentionRequestV1) => Promise<void>;
  decline: (request: AttentionRequestV1) => Promise<void>;
  /** Called once the camera has landed, with how the target resolved. */
  arrive: (request: AttentionRequestV1, resolution: FocusResolutionKind) => Promise<void>;
  goBack: (request: AttentionRequestV1, via?: "control" | "manual-move") => Promise<void>;
  refresh: () => Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json" };

export function useAttentionOffers({
  deviceId,
  captureViewport,
  pollMs = 4_000,
  fetchFn,
}: {
  deviceId: string | null;
  captureViewport: ViewportCapture;
  pollMs?: number;
  fetchFn?: typeof fetch;
}): AttentionOffersHandle {
  const [view, setView] = useState<DeviceAttentionView | null>(null);
  const call = fetchFn ?? (typeof fetch === "function" ? fetch : null);

  const read = useCallback(async (): Promise<DeviceAttentionView | null> => {
    if (!deviceId || !call) return null;
    try {
      const response = await call(`/api/attention?deviceId=${encodeURIComponent(deviceId)}`);
      if (!response.ok) return null;
      return await response.json() as DeviceAttentionView;
    } catch {
      /* A poll that cannot reach the server leaves the last known offer on
         screen: the record is durable, so the answer is still valid when the
         connection returns. */
      return null;
    }
  }, [deviceId, call]);

  const post = useCallback(async (id: string, event: AttentionEvent) => {
    if (!call) return;
    try {
      await call(`/api/attention/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(event),
      });
    } catch {
      /* Refused or unreachable: the next read re-renders from the truth rather
         than from what this device hoped had happened. */
    }
  }, [call]);

  /**
   * One read, and — if it turned up a request no device has rendered yet — the
   * offer transition that this device rendering it represents, followed by a
   * second read.
   *
   * Reporting here rather than from an effect on the rendered view is what
   * keeps it from cascading: a failed POST retries on the next poll tick, not
   * on every re-render.
   */
  const refresh = useCallback(async () => {
    const first = await read();
    if (!first) return;
    const pending = first.live.find((entry) => entry.request.state === "pending");
    if (!pending || !deviceId) {
      setView(first);
      return;
    }
    await post(pending.request.id, { kind: "offer", deviceId });
    setView(await read() ?? first);
  }, [read, post, deviceId]);

  const answer = useCallback(async (id: string, event: AttentionEvent) => {
    await post(id, event);
    await refresh();
  }, [post, refresh]);

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    const poll = async () => { if (!stopped) await refresh(); };
    const timer = setInterval(() => { void poll(); }, pollMs);
    /* The first read is a poll like any other, just an immediate one. */
    void poll();
    return () => { stopped = true; clearInterval(timer); };
  }, [deviceId, pollMs, refresh]);

  const accept = useCallback(async (request: AttentionRequestV1, via: "operator" | "auto-follow" = "operator") => {
    if (!deviceId) return;
    await answer(request.id, { kind: "accept", deviceId, via });
  }, [answer, deviceId]);

  const arrive = useCallback(async (request: AttentionRequestV1, resolution: FocusResolutionKind) => {
    if (!deviceId) return;
    await answer(request.id, {
      kind: "arrive",
      deviceId,
      resolution,
      returnPoint: { deviceId, capturedAt: new Date().toISOString(), ...captureViewport() },
    });
  }, [answer, deviceId, captureViewport]);

  return {
    view,
    offer: view?.offer ?? null,
    accept,
    preview: useCallback(async (request) => {
      if (deviceId) await answer(request.id, { kind: "preview", deviceId });
    }, [answer, deviceId]),
    decline: useCallback(async (request) => {
      if (deviceId) await answer(request.id, { kind: "decline", deviceId });
    }, [answer, deviceId]),
    arrive,
    goBack: useCallback(async (request, via: "control" | "manual-move" = "control") => {
      if (deviceId) await answer(request.id, { kind: "return", deviceId, via });
    }, [answer, deviceId]),
    refresh,
  };
}
