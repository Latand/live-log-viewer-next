"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { viewBus } from "@/hooks/viewPresenceBus";
import { stableDeviceId } from "@/hooks/useViewPresence";
import type { AttentionRequestV1, ReturnPoint } from "@/lib/attention/types";
import { useLocale } from "@/lib/i18n";
import { RootOverlayHost } from "@/components/overlay/RootOverlayHost";
import { useAttentionOffers, type ViewportCapture } from "@/components/overlay/useAttentionOffers";

import { focusHandoffBus, type FocusHandoffBus } from "./focusHandoffBus";
import { restoreFocusPoint, runFocusHandoff, type HandoffTiming } from "./navigate";
import { attentionPreviewFor } from "./preview";
import { forgetReturnProject, readReturnProject, rememberReturnProject } from "./returnProjectMemory";

/**
 * Where #688's loop is actually mounted (D3).
 *
 * Everything below it already existed and is unchanged; what was missing was a
 * surface that polls the record on a real device and can move the real board.
 * Three things this file is responsible for, and nothing else is:
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
 *
 * The overlay renders only while something needs an answer. The root
 * conversation's own turns are a separate slice (they need a transcript feed
 * adapter), and a permanently docked empty conversation would be worse than
 * none — but an unanswered request must never be invisible, which is the whole
 * failure this mount exists to end.
 */

/** Fallback height for the mobile sheet before the window can be measured. */
const DEFAULT_USABLE_HEIGHT = 720;

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
  const deviceId = forcedDeviceId ?? resolvedDeviceId;

  const [usableHeight, setUsableHeight] = useState(DEFAULT_USABLE_HEIGHT);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const measure = () => setUsableHeight(window.innerHeight || DEFAULT_USABLE_HEIGHT);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /* The viewport the operator is leaving, taken before the move and handed to
     the arrival that records it. Held in a ref because `arrive` reads it after
     the camera has already gone somewhere else. */
  const leaving = useRef<CapturedViewport | null>(null);

  const captureViewport = useCallback<ViewportCapture>(() => {
    const captured = leaving.current ?? currentViewport();
    return { mode: captured.mode, camera: captured.camera, focusedPath: captured.focusedPath };
  }, []);

  const offers = useAttentionOffers({
    deviceId,
    captureViewport,
    ...(fetchFn ? { fetchFn } : {}),
    ...(pollMs ? { pollMs } : {}),
  });

  const onAccept = useCallback(async (request: AttentionRequestV1) => {
    const before = currentViewport();
    leaving.current = before;
    let landed = false;
    try {
      const accepted = await offers.accept(request);
      if (!accepted.ok) return;
      /* Written after the server confirmed ownership, so a rejected device
         never stores a return point it will never use. */
      rememberReturnProject(browserStorage(), deviceId, request.id, before.project);
      const outcome = await runFocusHandoff(request, bus, timing ?? {});
      landed = outcome.resolution !== "lost";
      await offers.arrive(request, outcome.resolution);
    } finally {
      leaving.current = null;
      if (!landed) forgetReturnProject(browserStorage(), deviceId, request.id);
    }
  }, [offers, bus, deviceId, timing]);

  const onReturn = useCallback(async (request: AttentionRequestV1) => {
    const point = request.returnPoints.find((entry) => entry.deviceId === deviceId);
    if (point) {
      const restored = await restoreFocusPoint(point, readReturnProject(browserStorage(), deviceId, request.id), bus, timing ?? {});
      if (!restored) return;
    }
    await offers.goBack(request, "control");
    forgetReturnProject(browserStorage(), deviceId, request.id);
  }, [offers, bus, deviceId, timing]);

  const handlers = useMemo(() => ({
    onAcceptAttention: (request: AttentionRequestV1) => { void onAccept(request); },
    onPreviewAttention: (request: AttentionRequestV1) => { void offers.preview(request); },
    onDeclineAttention: (request: AttentionRequestV1) => { void offers.decline(request); },
    onDismissAttention: (request: AttentionRequestV1) => { void offers.dismiss(request); },
    onReturnAttention: (request: AttentionRequestV1) => { void onReturn(request); },
  }), [onAccept, onReturn, offers]);

  const offer = offers.offer;
  const live = Boolean(offer && offer.status !== "none" && offer.status !== "closed");
  if (!live && !offers.refusal) return null;

  /* The preview card's content, so "let me look first" shows something. Built
     here rather than in the row because only this side can see the board, which
     is where the anchor's own name comes from when the operator is already in
     the project that holds it. */
  const preview = offer && offer.status === "actionable" ? attentionPreviewFor(offer.request, bus.board()) : null;

  return (
    <RootOverlayHost
      mobile={mobile}
      usableHeight={usableHeight}
      state="idle"
      turns={NO_TURNS}
      attention={offer}
      attentionPreview={preview}
      attentionRefused={Boolean(offers.refusal)}
      attentionRefusedReason={offers.refusal?.reason ?? null}
      onDismissAttentionRefusal={offers.dismissRefusal}
      t={t}
      {...handlers}
    />
  );
}

const NO_TURNS = Object.freeze([]) as readonly never[];
