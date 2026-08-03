"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { viewBus } from "@/hooks/viewPresenceBus";
import { stableDeviceId } from "@/hooks/useViewPresence";
import { playCue } from "@/lib/audio/app";
import type { AttentionRequestV1, FocusResolutionKind, ReturnPoint } from "@/lib/attention/types";
import { useLocale } from "@/lib/i18n";
import { useAttentionOffers, type PostOutcome, type ViewportCapture } from "@/components/overlay/useAttentionOffers";

import { FocusReturnChip } from "./FocusReturnChip";
import { focusHandoffBus, type FocusHandoffBus } from "./focusHandoffBus";
import { restoreFocusPoint, runFocusHandoff, type HandoffTiming } from "./navigate";
import { forgetReturnProject, readReturnProject, rememberReturnProject } from "./returnProjectMemory";

/**
 * Where the focus handoff is actually mounted (#688 D3).
 *
 * Two operator decisions shape this file, and both are load-bearing:
 *
 * DESKTOP FOLLOWS IMMEDIATELY. An explicit focus event from the root agent
 * moves the view; there is no consent step, no preview, and no action row. The
 * confirmation cluster that used to live here is gone, and the only thing left
 * behind is a small Back control in the board chrome.
 *
 * MOBILE IS CHAT-ONLY. The phone never renders, offers, accepts or navigates a
 * focus request. That is enforced by withholding the device id — the same
 * switch that stops the poll also stops every POST, so a phone cannot even
 * report having seen an offer, and the request stays available for a desktop to
 * follow rather than being consumed by a surface that will not move.
 *
 * What this file owns beyond those two:
 *
 * - the DEVICE. One stable id per browser, the same one presence already uses,
 *   so "which device was offered this" and "which device is looking at what"
 *   name the same thing. Resolved in an effect because localStorage does not
 *   exist during the server render;
 * - the RETURN POINT, captured from this device's own viewport immediately
 *   before anything moves. It has to be taken before the move rather than at
 *   arrival, because opening another project moves the view on the way;
 * - the ORDER: agree, move, then report arrival with how the target resolved.
 *   A target that resolved to nothing is reported as `lost` and the record
 *   refuses to call it a follow, which is what keeps "you are looking at it"
 *   from being written about a view that never went anywhere.
 */

export interface AttentionHostProps {
  mobile: boolean;
  /** Test seams. Production passes none of these. */
  bus?: FocusHandoffBus;
  deviceId?: string | null;
  fetchFn?: typeof fetch;
  pollMs?: number;
  timing?: HandoffTiming;
}

type CapturedViewport = Pick<ReturnPoint, "mode" | "camera" | "focusedPath"> & { project: string | null };

/** This device's viewport, read from the same bus presence publishes from — so
    the point a return restores is the one the operator was actually at. */
export function currentViewport(): CapturedViewport {
  const slice = viewBus.getSlice();
  const camera = slice.camera;
  return {
    mode: slice.mode,
    /* Null in the modes presence forbids a camera in; there the handoff is a
       change of mode and focused path rather than a pan. */
    camera: camera ? { x: camera.x, y: camera.y, zoom: camera.zoom } : null,
    focusedPath: slice.focusedPath,
    project: viewBus.getContext().project,
  };
}

/**
 * Whether the server answered at all.
 *
 * A refusal IS an answer: the record moved on and this device's picture of it
 * was the stale one, so local state should follow the record. A transport
 * failure decided nothing — the record is untouched — so every local trace of
 * the handoff has to stay exactly as it was until it can be reconciled.
 * Collapsing the two is what turns "the wifi dropped" into "you already went
 * back", and the operator loses the way home to a lost packet.
 */
function decided(outcome: PostOutcome): boolean {
  return outcome.ok || outcome.refusal !== null;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    /* private-mode storage throw — useViewPresence falls back the same way */
    return null;
  }
}

export function AttentionHost({ mobile, bus = focusHandoffBus, deviceId: forcedDeviceId, fetchFn, pollMs, timing }: AttentionHostProps) {
  const { t } = useLocale();
  const [resolvedDeviceId, setResolvedDeviceId] = useState<string | null>(forcedDeviceId ?? null);
  useEffect(() => {
    if (forcedDeviceId !== undefined) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is unavailable during the server render, so the id can only be resolved once mounted */
    setResolvedDeviceId(stableDeviceId(browserStorage()));
  }, [forcedDeviceId]);
  /* The single switch that makes the phone chat-only. Every read and every POST
     below is gated on a device id, so withholding it here is what guarantees a
     phone neither moves its own board nor consumes a request a desktop should
     answer — rather than relying on each call site to remember. */
  const deviceId = mobile ? null : (forcedDeviceId ?? resolvedDeviceId);

  /* The viewport the operator is leaving, taken before the move and handed to
     the arrival that records it. Held in a ref because `arrive` reads it after
     the camera has already gone somewhere else.

     Keyed by request and kept until the server has confirmed the arrival, not
     just until the first attempt returns: an arrival the network swallowed is
     retried below, and by then `currentViewport()` is the TARGET. A retry that
     recaptured it would write the place the operator went as the place to
     return to — the return control would still be there and would land them
     exactly where they already are. */
  const leaving = useRef(new Map<string, CapturedViewport>());

  const captureViewport = useCallback<ViewportCapture>((requestId) => {
    const captured = leaving.current.get(requestId) ?? currentViewport();
    return { mode: captured.mode, camera: captured.camera, focusedPath: captured.focusedPath };
  }, []);

  /* Arrivals this device made on the board but has not got an answer about.
     Only transport failures land here: a refusal is the server having decided,
     and there is nothing to reconcile with a decision. */
  const unconfirmedArrivals = useRef(new Map<string, FocusResolutionKind>());

  const offers = useAttentionOffers({
    deviceId,
    captureViewport,
    ...(fetchFn ? { fetchFn } : {}),
    ...(pollMs ? { pollMs } : {}),
  });

  /** Move this device to a request the record already names as ours, and
      report the arrival. The pre-move viewport must already be in `leaving`
      and the return project already remembered — the two things that have to
      be taken before anything moves. */
  const completeHandoff = useCallback(async (request: AttentionRequestV1) => {
    let keepReturnPoint = false;
    try {
      const outcome = await runFocusHandoff(request, bus, timing ?? {});
      const arrival = await offers.arrive(request, outcome.resolution);
      /* The record says `following` only when the server said so. A move that
         happened on this screen but never reached the record is NOT a follow:
         nothing will offer a Return control for it, and treating it as one
         leaves the operator at the target with the way back already discarded. */
      if (arrival.ok) keepReturnPoint = true;
      else if (!decided(arrival) && outcome.resolution !== "lost") {
        /* Nothing was decided, so this is still owed to the record. Keep the
           pre-move viewport and retry it below. */
        keepReturnPoint = true;
        unconfirmedArrivals.current.set(request.id, outcome.resolution);
      }
    } finally {
      if (!unconfirmedArrivals.current.has(request.id)) leaving.current.delete(request.id);
      if (!keepReturnPoint) forgetReturnProject(browserStorage(), deviceId, request.id);
    }
  }, [offers, bus, deviceId, timing]);

  const onAccept = useCallback(async (request: AttentionRequestV1) => {
    const before = currentViewport();
    leaving.current.set(request.id, before);
    /* `auto-follow`, because that is what this is: nothing was put in front of
       the operator and nothing was pressed. Recording it as the operator's own
       act would tell the agent they chose to come — the one thing the record
       is there to keep honest. */
    const accepted = await offers.accept(request, "auto-follow");
    if (!accepted.ok) {
      leaving.current.delete(request.id);
      return;
    }
    /* Written after the server confirmed ownership, so a rejected device
       never stores a return point it will never use. */
    rememberReturnProject(browserStorage(), deviceId, request.id, before.project);
    await completeHandoff(request);
  }, [offers, deviceId, completeHandoff]);

  /**
   * A DIRECTED request (#873): the server already resolved this device as the
   * one active view and wrote the record `accepted` for it — the tool call is
   * blocked on the arrival right now. There is nothing to accept and nothing
   * to confirm; what is owed is the move itself and the arrival report, with
   * the pre-move viewport captured before anything happens.
   */
  const onDirected = useCallback(async (request: AttentionRequestV1) => {
    /* The same cue the offer path rings when a request first reaches a screen —
       a directed request never passes through `pending`, so this is its one
       chance to be heard. The request id keys the dedupe, so however many polls
       re-deliver it, it rings once. */
    playCue({ cue: "attention", eventId: `attention:${request.id}` });
    const before = currentViewport();
    leaving.current.set(request.id, before);
    /* Ownership is already on the record — `acknowledgedBy` names this device —
       so the return project is remembered up front, exactly as the accept path
       does once the server confirms. */
    rememberReturnProject(browserStorage(), deviceId, request.id, before.project);
    await completeHandoff(request);
  }, [deviceId, completeHandoff]);

  const onReturn = useCallback(async (request: AttentionRequestV1) => {
    const point = request.returnPoints.find((entry) => entry.deviceId === deviceId);
    if (point) {
      const restored = await restoreFocusPoint(point, readReturnProject(browserStorage(), deviceId, request.id), bus, timing ?? {});
      if (!restored) return;
    }
    const outcome = await offers.goBack(request, "control");
    /* Forgotten only once the record has actually left `following`. A return
       the server never received leaves the control on screen, and a second
       press with the memory already dropped restores the viewport into
       whichever project happens to be open instead of the one departed from. */
    if (decided(outcome)) forgetReturnProject(browserStorage(), deviceId, request.id);
  }, [offers, bus, deviceId, timing]);

  /**
   * Re-report an arrival the network swallowed, on the next poll that still
   * shows the record waiting for it.
   *
   * Idempotent by construction: the retry is gated on the record still being
   * `accepted` by this device, which is the one state `arrive` is legal from.
   * Once it lands the request is `following` and the gate never opens again, so
   * a duplicate cannot be posted however many polls run. Left unreconciled, the
   * landing grace expires the request as `lost` and the agent is told the
   * operator never got there — while they are sitting on the target.
   */
  const reconciling = useRef(new Set<string>());
  /* Read through a ref so the effect can depend on the poll tick ALONE. Listing
     the view would reintroduce the self-trigger the tick exists to avoid. */
  const viewRef = useRef(offers.view);
  const currentView = offers.view;
  useEffect(() => { viewRef.current = currentView; }, [currentView]);
  const pollGeneration = offers.pollGeneration;
  useEffect(() => {
    if (!deviceId || unconfirmedArrivals.current.size === 0) return;
    for (const entry of viewRef.current?.live ?? []) {
      const resolution = unconfirmedArrivals.current.get(entry.request.id);
      if (resolution === undefined || reconciling.current.has(entry.request.id)) continue;
      if (entry.request.state !== "accepted" || entry.request.acknowledgedBy !== deviceId) {
        /* The record moved on without this device's report — nothing left to
           reconcile, and the captured viewport is only noise from here. */
        unconfirmedArrivals.current.delete(entry.request.id);
        leaving.current.delete(entry.request.id);
        continue;
      }
      reconciling.current.add(entry.request.id);
      void (async () => {
        try {
          const retry = await offers.arrive(entry.request, resolution);
          if (!decided(retry)) return;
          unconfirmedArrivals.current.delete(entry.request.id);
          leaving.current.delete(entry.request.id);
          if (!retry.ok) forgetReturnProject(browserStorage(), deviceId, entry.request.id);
        } finally {
          reconciling.current.delete(entry.request.id);
        }
      })();
    }
  }, [pollGeneration, offers, deviceId]);

  /**
   * Follow an explicit focus event, exactly once.
   *
   * Edge-triggered on the request id and latched forever: the poll re-delivers
   * the same actionable offer every few seconds, and a replayed MCP call
   * re-delivers the same request id, so anything level-triggered here would
   * re-move the view on a heartbeat. The latch is set BEFORE the await, because
   * accepting is asynchronous and the next poll can land while it is still in
   * flight.
   *
   * Nothing re-opens the latch. A second navigation requires a genuinely new
   * request, which carries its own id.
   */
  const followed = useRef(new Set<string>());
  const offer = offers.offer;
  const actionableRequestId = offer && offer.status === "actionable" ? offer.request.id : null;
  const actionableRequest = offer && offer.status === "actionable" ? offer.request : null;
  /* A directed request still owed its move: the server accepted it FOR this
     device and no arrival is on the record yet. The return-point check is what
     keeps a remount from re-treating a landed-but-unreported request as new —
     that case belongs to the arrival reconciliation above. */
  const directedRequest = offer
    && offer.status === "following"
    && offer.request.state === "accepted"
    && offer.request.acknowledgedBy === deviceId
    && !offer.request.returnPoints.some((point) => point.deviceId === deviceId)
    ? offer.request : null;
  const directedRequestId = directedRequest?.id ?? null;
  useEffect(() => {
    if (!deviceId) return;
    const request = actionableRequest ?? directedRequest;
    if (!request || followed.current.has(request.id)) return;
    followed.current.add(request.id);
    void (actionableRequest ? onAccept(request) : onDirected(request));
  }, [deviceId, actionableRequestId, actionableRequest, directedRequestId, directedRequest, onAccept, onDirected]);

  const onReturnClick = useCallback(() => {
    if (offer) void onReturn(offer.request);
  }, [offer, onReturn]);

  /* The whole surface: one small control, and only while there is somewhere to
     go back to. Everything else the overlay used to put here — the request card,
     the accept/preview/decline row, the refusal band — is gone. A move that has
     already happened does not need announcing, and a failed one is reported to
     the agent through the focus-follow outcome rather than as a banner over the
     operator's board. Gated on the record's OWN `following` — not merely on the
     device status — so a directed request still mid-flight (`accepted`, nothing
     moved yet) never shows a Return before there is anywhere to return from. */
  if (!offer || offer.status !== "following" || offer.request.state !== "following") return null;

  return <FocusReturnChip onReturn={onReturnClick} precise={offer.returnAvailable} t={t} />;
}
