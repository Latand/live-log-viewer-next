"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { playCue } from "@/lib/audio/app";
import type { AttentionEvent } from "@/lib/attention/machine";
import type { DeviceAttentionView } from "@/lib/attention/service";
import type { AttentionRequestV1, AttentionState, FocusResolutionKind, ReturnPoint } from "@/lib/attention/types";

/**
 * The client half of #688's ask-accept-decline-return loop.
 *
 * The record is the authority; this only reads it and posts answers back. Three
 * things are worth naming:
 *
 * - rendering an offer is itself a transition (`pending` → `offered`), because
 *   "no active device ever showed it" and "they saw it and said nothing" are
 *   different facts, and the expiry line the operator hears depends on which.
 *   A surface nobody can see reports NOTHING, for exactly that reason: a
 *   background tab claiming the operator saw an offer teaches the agent the
 *   wrong lesson about whether to ask again;
 * - the return point is captured HERE, immediately before the move, from this
 *   device's own viewport — never from presence, and never shared with another
 *   device;
 * - a refused answer is not a delivered one. The route answers an out-of-order
 *   transition with 409 and the state the record is actually in, so a refusal
 *   re-reads and is shown, rather than looking exactly like success.
 */

/** The viewport this device is about to leave. */
export type ViewportCapture = () => Pick<ReturnPoint, "mode" | "camera" | "focusedPath">;

/** How long a refusal stays on screen before it takes itself off. A refusal is
    a message about one answer, not a status: left standing it becomes a warning
    band the operator cannot get rid of, and after the record has moved on it is
    describing something that is no longer true. Dismissible before then. */
export const REFUSAL_TTL_MS = 12_000;

/** The refusal reason a handoff that found nowhere to land reports. Not a
    server code: the record accepted the close, and this is what the surface
    says about it. */
export const LOST_TARGET_REFUSAL = "lost-target";

/** The server refused this device's own answer. Transport failures are NOT
    refusals: those retry silently, because nothing was decided. */
export interface AttentionRefusal {
  requestId: string;
  /** The route's error code, or `http-<status>` when it named none. */
  reason: string;
  /** Where the record actually stands, when the route said. */
  state: AttentionState | null;
}

export interface AttentionOffersHandle {
  view: DeviceAttentionView | null;
  offer: DeviceAttentionView["offer"];
  /** Set when this device's last answer was refused; cleared by the next one
      that lands, by the operator, or by its own expiry. */
  refusal: AttentionRefusal | null;
  /** Take the refusal band off screen. */
  dismissRefusal: () => void;
  accept: (request: AttentionRequestV1, via?: "operator" | "auto-follow") => Promise<void>;
  preview: (request: AttentionRequestV1) => Promise<void>;
  /** Refuse before looking. Valid only from `offered`. */
  decline: (request: AttentionRequestV1) => Promise<void>;
  /** Looked, and stayed put. Valid only from `previewing` — a different fact
      from declining unseen, and the machine keeps them apart. */
  dismiss: (request: AttentionRequestV1) => Promise<void>;
  /** Called once the camera has landed, with how the target resolved. A `lost`
      resolution ends the request instead of recording an arrival — see below. */
  arrive: (request: AttentionRequestV1, resolution: FocusResolutionKind) => Promise<void>;
  goBack: (request: AttentionRequestV1, via?: "control" | "manual-move") => Promise<void>;
  refresh: () => Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json" };

/** Whether a POST decided anything: `null` means the server never answered. */
type PostOutcome = { ok: true } | { ok: false; refusal: AttentionRefusal | null };

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function useAttentionOffers({
  deviceId,
  captureViewport,
  pollMs = 4_000,
  refusalTtlMs = REFUSAL_TTL_MS,
  fetchFn,
  surfaceVisible,
}: {
  deviceId: string | null;
  captureViewport: ViewportCapture;
  pollMs?: number;
  /** Test seam. Production leaves this at {@link REFUSAL_TTL_MS}. */
  refusalTtlMs?: number;
  fetchFn?: typeof fetch;
  /** Whether this surface is on screen. Defaults to the document's own
      visibility; a sheet collapsed out of sight passes its own answer. */
  surfaceVisible?: () => boolean;
}): AttentionOffersHandle {
  const [view, setView] = useState<DeviceAttentionView | null>(null);
  const [refusal, setRefusal] = useState<AttentionRefusal | null>(null);
  const call = fetchFn ?? (typeof fetch === "function" ? fetch : null);

  /* Held in a ref so a caller passing an inline predicate does not restart the
     poll on every render. */
  const visible = useRef<() => boolean>(documentIsVisible);
  useEffect(() => { visible.current = surfaceVisible ?? documentIsVisible; }, [surfaceVisible]);

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

  const post = useCallback(async (id: string, event: AttentionEvent): Promise<PostOutcome> => {
    if (!call) return { ok: false, refusal: null };
    let response: Response;
    try {
      response = await call(`/api/attention/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(event),
      });
    } catch {
      /* Unreachable: nothing was decided, so the next poll simply tries again
         and the last known offer stays on screen. */
      return { ok: false, refusal: null };
    }
    if (response.ok) return { ok: true };
    /* Refused. The route returns the state the record is actually in for this
       case, so the surface can re-render from the truth instead of from what
       this device hoped had happened. */
    let body: { error?: unknown; state?: unknown } | null = null;
    try {
      body = await response.json() as { error?: unknown; state?: unknown };
    } catch {
      body = null;
    }
    return {
      ok: false,
      refusal: {
        requestId: id,
        reason: typeof body?.error === "string" ? body.error : `http-${response.status}`,
        state: typeof body?.state === "string" ? body.state as AttentionState : null,
      },
    };
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
    /* A surface nobody is looking at reads, but never claims the offer was
       shown: `pending` and `offered` are the difference between "no active
       device ever showed it" and "they saw it and said nothing", and a hidden
       tab reporting the second would make the expiry line a lie. */
    if (!pending || !deviceId || !visible.current()) {
      setView(first);
      return;
    }
    /* Rings exactly where the offer is first SHOWN — the same place the record
       learns it was shown — so a hidden tab stays as silent as it is honest. The
       request id is the identity: this poll runs every few seconds and the offer
       stays in the record until it is answered. */
    playCue({ cue: "attention", eventId: `attention:${pending.request.id}` });
    await post(pending.request.id, { kind: "offer", deviceId });
    setView(await read() ?? first);
  }, [read, post, deviceId]);

  const answer = useCallback(async (id: string, event: AttentionEvent) => {
    const outcome = await post(id, event);
    if (outcome.ok) setRefusal(null);
    else if (outcome.refusal) setRefusal(outcome.refusal);
    /* Refused or not, the record is re-read: a refusal is exactly the case
       where this device's picture of the request is the stale one. */
    await refresh();
  }, [post, refresh]);

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    const poll = async () => { if (!stopped) await refresh(); };
    const timer = setInterval(() => { void poll(); }, pollMs);
    /* The first read is a poll like any other, just an immediate one. */
    void poll();
    /* Coming back to the tab reports the offer straight away rather than
       leaving it unreported until the next tick. */
    const onVisibility = () => { void poll(); };
    const watched = typeof document === "undefined" ? null : document;
    watched?.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearInterval(timer);
      watched?.removeEventListener("visibilitychange", onVisibility);
    };
  }, [deviceId, pollMs, refresh]);

  const accept = useCallback(async (request: AttentionRequestV1, via: "operator" | "auto-follow" = "operator") => {
    if (!deviceId) return;
    await answer(request.id, { kind: "accept", deviceId, via });
  }, [answer, deviceId]);

  const arrive = useCallback(async (request: AttentionRequestV1, resolution: FocusResolutionKind) => {
    if (!deviceId) return;
    if (resolution === "lost") {
      /* Nothing moved, so there is no arrival to record and no return point
         worth keeping. The device that agreed closes its own request: reporting
         it as an arrival would be refused by the record and leave the request
         `accepted` forever — the oldest live entry, and therefore the only
         thing this device is ever offered again. The operator is told on the
         same surface, because they pressed a control and the view stayed put. */
      await answer(request.id, { kind: "abandon", deviceId });
      setRefusal({ requestId: request.id, reason: LOST_TARGET_REFUSAL, state: null });
      return;
    }
    await answer(request.id, {
      kind: "arrive",
      deviceId,
      resolution,
      returnPoint: { deviceId, capturedAt: new Date().toISOString(), ...captureViewport() },
    });
  }, [answer, deviceId, captureViewport]);

  /* A refusal is about one answer, so it outlives that answer by a bounded
     moment and no longer. Keyed on the refusal itself, so a second one restarts
     the clock rather than inheriting the first one's remaining time. */
  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(() => setRefusal((current) => (current === refusal ? null : current)), refusalTtlMs);
    return () => clearTimeout(timer);
  }, [refusal, refusalTtlMs]);

  return {
    view,
    offer: view?.offer ?? null,
    refusal,
    dismissRefusal: useCallback(() => setRefusal(null), []),
    accept,
    preview: useCallback(async (request) => {
      if (deviceId) await answer(request.id, { kind: "preview", deviceId });
    }, [answer, deviceId]),
    decline: useCallback(async (request) => {
      if (deviceId) await answer(request.id, { kind: "decline", deviceId });
    }, [answer, deviceId]),
    dismiss: useCallback(async (request) => {
      if (deviceId) await answer(request.id, { kind: "dismiss", deviceId });
    }, [answer, deviceId]),
    arrive,
    goBack: useCallback(async (request, via: "control" | "manual-move" = "control") => {
      if (deviceId) await answer(request.id, { kind: "return", deviceId, via });
    }, [answer, deviceId]),
    refresh,
  };
}
