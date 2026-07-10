"use client";

import { useEffect } from "react";

import { VIEW_SCHEMA_VERSION, type BrowserKind, type DeviceKind, type PresencePayloadV1 } from "@/lib/view/types";

import {
  mergeView,
  OVERVIEW_CONTEXT,
  OVERVIEW_SLICE,
  viewBus,
  type PresenceViewport,
  type RenderedViewState,
} from "./viewPresenceBus";

/* Exact cadence frozen by the architecture contract. */
const HEARTBEAT_MS = 10_000;
const INTERACTION_DEBOUNCE_MS = 500;
/* No more than two publishes a second: a 500 ms floor between any two POSTs. */
const MIN_GAP_MS = 500;
/* Capped exponential backoff for network/5xx failures — a failed publish must
   not re-fire at the 500 ms floor forever (that was a live 2 POSTs/sec error
   loop). Any accepted or 4xx-rejected response clears it. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const DEVICE_ID_KEY = "llvDeviceId";

export interface PresenceIdentity {
  viewSessionId: string;
  deviceId: string;
  device: PresencePayloadV1["device"];
}

/** Fresh, in-memory per document — a reload or a duplicated tab is a new view
    session, so two tabs never collide on one id (no recovery protocol needed). */
export function newViewSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "vs-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Stable per device, in localStorage — survives reloads so a device keeps one
    identity across its many view sessions. */
export function stableDeviceId(storage: Pick<Storage, "getItem" | "setItem"> | null): string {
  try {
    const existing = storage?.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
  } catch {
    /* private-mode storage throw — fall through to an ephemeral id */
  }
  const fresh = newViewSessionId();
  try {
    storage?.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    /* storage unavailable — the id stays ephemeral for this load */
  }
  return fresh;
}

export function detectBrowser(ua: string): BrowserKind {
  const s = ua.toLowerCase();
  if (s.includes("firefox") || s.includes("fxios")) return "firefox";
  /* Edge and other Chromium skins are not "chrome" for our purposes. */
  if (s.includes("edg/") || s.includes("opr/")) return "other";
  if (s.includes("crios") || s.includes("chrome") || s.includes("chromium")) return "chrome";
  /* Chrome's UA also contains "safari", so this must come after the chrome test. */
  if (s.includes("safari")) return "safari";
  return "other";
}

export function detectDeviceKind(ua: string, coarsePointer: boolean, width: number): DeviceKind {
  const s = ua.toLowerCase();
  if (s.includes("ipad") || (s.includes("tablet") && !s.includes("mobi")) || (coarsePointer && width >= 768 && width <= 1280)) return "tablet";
  if (s.includes("mobi") || s.includes("iphone") || s.includes("android") || (coarsePointer && width < 768)) return "mobile";
  return "desktop";
}

/** Build the exact wire body from the assembled view plus this document's
    identity and the current sequence counters. Pure — the publisher owns the
    counters, this only stamps them on. */
export function buildPresencePayload(
  view: RenderedViewState,
  identity: PresenceIdentity,
  sequence: number,
  inputSequence: number,
  visibility: "visible" | "hidden",
): PresencePayloadV1 {
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    viewSessionId: identity.viewSessionId,
    deviceId: identity.deviceId,
    device: identity.device,
    visibility,
    sequence,
    inputSequence,
    project: view.project,
    mode: view.mode,
    viewport: view.viewport,
    camera: view.camera,
    focusedPath: view.focusedPath,
    selectedPaths: view.selectedPaths,
    visiblePaths: view.visiblePaths,
    board: view.board,
  };
}

export interface PresenceScheduler {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The slice of `fetch`'s Response the publisher needs: `ok`/`status` to classify
    the outcome, plus the body handles so it can be consumed/cancelled — without
    `keepalive` an undrained body pins the socket. The real `fetch` Response
    satisfies this structurally; tests supply a stub. */
export interface PresenceResponse {
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
}

export interface PresencePublisherOptions {
  identity: PresenceIdentity;
  fetcher: (input: string, init: RequestInit) => Promise<PresenceResponse>;
  scheduler: PresenceScheduler;
  beacon?: (url: string, body: string) => boolean;
  endpoint?: string;
}

/** Free the response body so a non-keepalive connection can be reused: cancel the
    stream if present, else read it to completion; never throw. */
async function drainBody(res: PresenceResponse): Promise<void> {
  try {
    if (res.body && typeof res.body.cancel === "function") {
      await res.body.cancel();
      return;
    }
    if (typeof res.text === "function") await res.text();
  } catch {
    /* already consumed, locked, or unavailable — nothing to free */
  }
}

export interface PresencePublisher {
  setView(view: RenderedViewState): void;
  setVisibility(visibility: "visible" | "hidden"): void;
  markInteraction(): void;
  /** Republish now without counting as user input (reconnect, resize). */
  poke(): void;
  start(): void;
  stop(): void;
  /** Best-effort final publish on pagehide — marks the session hidden. */
  sendBeacon(): void;
}

/**
 * The single presence state machine: it owns the monotonic `sequence` /
 * `inputSequence` counters, debounces view changes to at most one POST per
 * 500 ms, heartbeats every 10 s, flushes immediately on visibility changes, and
 * retries a failed POST on the next tick without losing a sequence. Timers and
 * the fetcher are injected so the whole thing runs under a fake clock in tests.
 */
export function createPresencePublisher(options: PresencePublisherOptions): PresencePublisher {
  const { identity, fetcher, scheduler, beacon, endpoint = "/api/view/presence" } = options;
  let sequence = 0;
  let inputSequence = 0;
  let pendingInteraction = false;
  let view: RenderedViewState = mergeView(OVERVIEW_CONTEXT, OVERVIEW_SLICE, { width: 1, height: 1, dpr: 1 });
  let visibility: "visible" | "hidden" = "visible";
  let started = false;
  let needsFlush = false;
  let inflight = false;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let debounceTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  /* Backoff window after a network/5xx failure. `retryDelay` is the current
     step (0 = healthy); `retryUntil` is the absolute time before which no flush
     may fire, so a heartbeat or interaction during an outage is coalesced into
     the backoff instead of shortening it. */
  let retryDelay = 0;
  let retryUntil = 0;

  const backOff = () => {
    retryDelay = retryDelay === 0 ? RETRY_BASE_MS : Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryUntil = scheduler.now() + retryDelay;
    needsFlush = true;
  };
  const clearBackoff = () => {
    retryDelay = 0;
    retryUntil = 0;
  };

  const scheduleFlush = (immediate: boolean) => {
    if (!started) return;
    const base = immediate ? 0 : INTERACTION_DEBOUNCE_MS;
    const now = scheduler.now();
    const wait = Math.max(base, MIN_GAP_MS - (now - lastSentAt), retryUntil - now, 0);
    if (debounceTimer !== null) scheduler.clearTimer(debounceTimer);
    debounceTimer = scheduler.setTimer(() => {
      debounceTimer = null;
      void doFlush();
    }, wait);
  };

  const requestFlush = (immediate: boolean) => {
    needsFlush = true;
    scheduleFlush(immediate);
  };

  const doFlush = async () => {
    if (!needsFlush || inflight) return;
    needsFlush = false;
    const seq = ++sequence;
    if (pendingInteraction) {
      inputSequence += 1;
      pendingInteraction = false;
    }
    const payload = buildPresencePayload(view, identity, seq, inputSequence, visibility);
    inflight = true;
    lastSentAt = scheduler.now();
    try {
      /* No `keepalive`: routine heartbeats every 10 s exhaust Chrome's shared
         64 KB keepalive quota within minutes and then every POST throws. The
         final unload publish uses navigator.sendBeacon (see sendBeacon()). */
      const res = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      await drainBody(res);
      if (res.ok) {
        clearBackoff();
      } else if (res.status >= 400 && res.status < 500) {
        /* Deterministic rejection (e.g. a payload the validator refuses):
           retrying the identical body loops forever. Drop this flush and clear
           backoff — the counters stay, so the next view change publishes a
           fresh, different payload. */
        clearBackoff();
      } else {
        /* 5xx: server transient — back off. */
        backOff();
      }
    } catch {
      /* Network error: keep the counters and back off, don't hammer. */
      backOff();
    } finally {
      inflight = false;
      if (needsFlush) scheduleFlush(false);
    }
  };

  /* The heartbeat is visibility-agnostic: a hidden tab keeps publishing its
     last-known slice (marked `visibility:"hidden"`) so the server can retain it
     as a background view. Chrome throttles chained timers in hidden tabs, so
     this can only slow — the client publishes the honest hidden state and the
     backend (Terra) owns how long a last-known-hidden session stays fresh; the
     two coordinate solely through the `visibility` field on the DTO. */
  const armHeartbeat = () => {
    if (heartbeatTimer !== null) scheduler.clearTimer(heartbeatTimer);
    heartbeatTimer = scheduler.setTimer(() => {
      requestFlush(true);
      armHeartbeat();
    }, HEARTBEAT_MS);
  };

  return {
    setView(next) {
      if (JSON.stringify(next) === JSON.stringify(view)) return;
      view = next;
      requestFlush(false);
    },
    setVisibility(next) {
      if (next === visibility) return;
      visibility = next;
      /* A tab going hidden/visible is worth an immediate, honest update. */
      requestFlush(true);
    },
    markInteraction() {
      pendingInteraction = true;
      requestFlush(false);
    },
    poke() {
      requestFlush(true);
    },
    start() {
      if (started) return;
      started = true;
      armHeartbeat();
      requestFlush(true);
    },
    stop() {
      started = false;
      if (debounceTimer !== null) scheduler.clearTimer(debounceTimer);
      if (heartbeatTimer !== null) scheduler.clearTimer(heartbeatTimer);
      debounceTimer = null;
      heartbeatTimer = null;
      needsFlush = false;
      clearBackoff();
    },
    sendBeacon() {
      if (!beacon) return;
      const payload = buildPresencePayload(view, identity, ++sequence, inputSequence, "hidden");
      try {
        beacon(endpoint, JSON.stringify(payload));
      } catch {
        /* beacon unavailable — nothing more we can do on unload */
      }
    },
  };
}

const INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

function windowViewport(): PresenceViewport {
  return { width: window.innerWidth || 1, height: window.innerHeight || 1, dpr: window.devicePixelRatio || 1 };
}

/**
 * Mounts the one presence publisher for the whole app (in Viewer). It resolves
 * this document's identity, subscribes to the view bus, wires interaction /
 * visibility / online / resize / pagehide, and drives the publisher. It renders
 * nothing and adds no visible pixels — presence is invisible plumbing.
 */
export function useViewPresence(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const identity: PresenceIdentity = {
      viewSessionId: newViewSessionId(),
      deviceId: stableDeviceId(storage),
      device: {
        kind: detectDeviceKind(navigator.userAgent, coarse, window.innerWidth || 1),
        browser: detectBrowser(navigator.userAgent),
      },
    };
    const publisher = createPresencePublisher({
      identity,
      fetcher: (input, init) => fetch(input, init),
      beacon:
        typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
          ? (url, body) => navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))
          : undefined,
      scheduler: {
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });

    const push = () => publisher.setView(mergeView(viewBus.getContext(), viewBus.getSlice(), windowViewport()));
    const unsubscribe = viewBus.subscribe(push);
    const onInteract = () => publisher.markInteraction();
    for (const event of INTERACTION_EVENTS) window.addEventListener(event, onInteract, { passive: true });
    const onVisibility = () => publisher.setVisibility(document.visibilityState === "hidden" ? "hidden" : "visible");
    document.addEventListener("visibilitychange", onVisibility);
    const onOnline = () => publisher.poke();
    window.addEventListener("online", onOnline);
    const onResize = () => push();
    window.addEventListener("resize", onResize);
    const onHide = () => publisher.sendBeacon();
    window.addEventListener("pagehide", onHide);

    publisher.setVisibility(document.visibilityState === "hidden" ? "hidden" : "visible");
    push();
    publisher.start();

    return () => {
      unsubscribe();
      for (const event of INTERACTION_EVENTS) window.removeEventListener(event, onInteract);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pagehide", onHide);
      publisher.stop();
    };
  }, []);
}
