"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Explicit, device-local intent (issue #712). It never leaves the device: no
   server state, no transcript, no presence field — a phone that wants its
   screen held awake is a property of that phone, not of the board. */
const STORAGE_KEY = "llvKeepAwake";

/**
 * Every state the operator can be in, each one truthful about whether a screen
 * wake-lock sentinel is actually held right now:
 *
 * - `unsupported` — the browser has no Screen Wake Lock API at all.
 * - `insecure`    — the API exists but the page is not a secure context, so a
 *                   request can only ever fail.
 * - `off`         — supported and available; the operator has not asked.
 * - `requesting`  — a request is in flight.
 * - `active`      — exactly one sentinel is held; the screen stays awake.
 * - `waiting`     — wanted, but the document is hidden, so nothing is held.
 * - `interrupted` — the system dropped the sentinel while the page was still
 *                   visible and the one bounded re-request did not stick.
 * - `blocked`     — the request was refused (permission / permissions policy).
 * - `failed`      — the request threw for any other reason.
 *
 * Only `active` means the screen is protected. Nothing else may imply it.
 */
export type WakeLockStatus =
  | "unsupported"
  | "insecure"
  | "off"
  | "requesting"
  | "active"
  | "waiting"
  | "interrupted"
  | "blocked"
  | "failed";

export interface WakeLockState {
  /** The operator's persisted intent, independent of whether it can be honoured. */
  enabled: boolean;
  status: WakeLockStatus;
}

/** The slice of `WakeLockSentinel` this controller uses. The real DOM sentinel
    satisfies it structurally; tests supply a stub. */
export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

/** Everything the controller touches outside itself, injected so the whole
    lifecycle runs deterministically in tests with no browser at all. */
export interface WakeLockEnvironment {
  /** `null` when the browser exposes no `navigator.wakeLock`. */
  request: ((type: "screen") => Promise<WakeLockSentinelLike>) | null;
  /** Screen Wake Lock is secure-context only. */
  secureContext: boolean;
  isVisible(): boolean;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}

export interface WakeLockController {
  getState(): WakeLockState;
  subscribe(listener: () => void): () => void;
  /** Read the persisted intent and honour it if the page is visible. */
  start(): void;
  /** Release the sentinel and stop honouring the intent (the intent persists). */
  stop(): void;
  setEnabled(next: boolean): void;
  /** Re-evaluate after `visibilitychange` / `pageshow`. */
  syncVisibility(): void;
}

function isDenied(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError";
}

/**
 * The single owner of the screen wake-lock sentinel.
 *
 * It holds **at most one** sentinel at any moment. A `generation` counter makes
 * that hold true even under races: a request that resolves after a disable, a
 * hide, or another request is stale, so its sentinel is released instead of
 * adopted rather than leaking a second lock the operator can never turn off.
 *
 * It deliberately does NOT retry forever. Safari drops the sentinel on its own
 * (webkit bug 254545); one re-request per visible stretch recovers the common
 * case, and after that the controller reports `interrupted` instead of spinning
 * on a lock the platform refuses to keep.
 */
export function createWakeLockController(environment: WakeLockEnvironment): WakeLockController {
  const listeners = new Set<() => void>();
  /* The initial state deliberately matches the server render (`off`): the real
     capability is only knowable on the client, so `start()` publishes it. */
  let state: WakeLockState = { enabled: false, status: "off" };
  let sentinel: WakeLockSentinelLike | null = null;
  let onRelease: (() => void) | null = null;
  let generation = 0;
  /* Generation of the request currently in flight, `-1` when none. A second
     acquire() while an un-invalidated request is out would burn a redundant
     platform request whose sentinel is then immediately released. */
  let inFlight = -1;
  let started = false;
  /* One automatic re-request per visible stretch — the bound that keeps a
     platform that releases immediately from becoming a request loop. */
  let retriedWhileVisible = false;

  const available = environment.request !== null && environment.secureContext;

  const emit = (patch: Partial<WakeLockState>) => {
    const next = { ...state, ...patch };
    if (next.enabled === state.enabled && next.status === state.status) return;
    state = next;
    for (const listener of listeners) listener();
  };

  /** The honest status while no sentinel is held. */
  const idleStatus = (): WakeLockStatus => {
    if (environment.request === null) return "unsupported";
    if (!environment.secureContext) return "insecure";
    return state.enabled && started ? "waiting" : "off";
  };

  const readPersisted = (): boolean => {
    try {
      return environment.storage?.getItem(STORAGE_KEY) === "1";
    } catch {
      /* private-mode storage throw — treat as never asked */
      return false;
    }
  };

  const persist = (value: boolean) => {
    try {
      environment.storage?.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      /* storage unavailable — the choice still applies for this load */
    }
  };

  const detach = () => {
    if (sentinel && onRelease) sentinel.removeEventListener("release", onRelease);
    onRelease = null;
  };

  /** Drop whatever we hold and invalidate any in-flight request. */
  const releaseOwn = (status: WakeLockStatus) => {
    generation += 1;
    const held = sentinel;
    detach();
    sentinel = null;
    emit({ status });
    if (held) void Promise.resolve(held.release()).catch(() => {});
  };

  const handleRelease = (which: WakeLockSentinelLike) => {
    /* A stale sentinel's listener firing after we moved on changes nothing. */
    if (which !== sentinel) return;
    detach();
    sentinel = null;
    if (!started || !state.enabled || !environment.isVisible()) {
      emit({ status: idleStatus() });
      return;
    }
    if (!retriedWhileVisible) {
      retriedWhileVisible = true;
      acquire();
      return;
    }
    emit({ status: "interrupted" });
  };

  function acquire() {
    if (!started || !state.enabled) return;
    if (!available) {
      emit({ status: idleStatus() });
      return;
    }
    if (!environment.isVisible()) {
      emit({ status: "waiting" });
      return;
    }
    /* The one sentinel is already held — asking again would make it two. */
    if (sentinel) return;
    /* A live request for the current generation is already out. */
    if (inFlight === generation) return;
    const mine = ++generation;
    inFlight = mine;
    emit({ status: "requesting" });
    void environment.request!("screen").then(
      (next) => {
        if (inFlight === mine) inFlight = -1;
        if (mine !== generation) {
          /* Stale: something disabled, hid, or re-requested while this was in
             flight. Adopting it would leave a lock nobody owns. */
          void Promise.resolve(next.release()).catch(() => {});
          return;
        }
        sentinel = next;
        onRelease = () => handleRelease(next);
        next.addEventListener("release", onRelease);
        /* Safari can hand back a sentinel that is already released. */
        if (next.released === true) {
          handleRelease(next);
          return;
        }
        emit({ status: "active" });
      },
      (error) => {
        if (inFlight === mine) inFlight = -1;
        if (mine !== generation) return;
        emit({ status: isDenied(error) ? "blocked" : "failed" });
      },
    );
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      if (started) return;
      started = true;
      const persisted = readPersisted();
      emit({ enabled: persisted });
      emit({ status: idleStatus() });
      if (persisted) acquire();
    },
    stop() {
      if (!started) return;
      started = false;
      releaseOwn(idleStatus());
    },
    setEnabled(next) {
      if (next === state.enabled) return;
      emit({ enabled: next });
      persist(next);
      retriedWhileVisible = false;
      if (next) acquire();
      else releaseOwn(idleStatus());
    },
    syncVisibility() {
      if (!started) return;
      if (environment.isVisible()) {
        retriedWhileVisible = false;
        acquire();
        return;
      }
      if (!state.enabled) return;
      /* Hidden: drop our sentinel deliberately. Safari does it anyway, and an
         explicit release means the page can never come back holding two. */
      releaseOwn(idleStatus());
    },
  };
}

/** The real browser environment. Client-only — never call it during a render
    that can run on the server. */
export function browserWakeLockEnvironment(): WakeLockEnvironment {
  const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }).wakeLock;
  let storage: Pick<Storage, "getItem" | "setItem"> | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    request: wakeLock && typeof wakeLock.request === "function" ? (type) => wakeLock.request(type) : null,
    /* `isSecureContext` is missing on old engines; a missing flag with the API
       present is treated as secure and the request itself decides. */
    secureContext: typeof window.isSecureContext === "boolean" ? window.isSecureContext : true,
    isVisible: () => document.visibilityState !== "hidden",
    storage,
  };
}

export interface KeepAwakeApi extends WakeLockState {
  setEnabled: (next: boolean) => void;
}

/**
 * Mounts one wake-lock controller and keeps it in step with the page's
 * visibility. `visibilitychange` covers backgrounding; `pageshow` covers iOS
 * restoring a page from the back/forward cache, where no visibility event
 * fires and the sentinel is long gone.
 *
 * Exactly one component in the tree may call this — `KeepAwakeProvider` owns
 * that call and refuses to nest, so the app can never hold two sentinels.
 */
export function useScreenWakeLock(environment?: () => WakeLockEnvironment): KeepAwakeApi {
  const [state, setState] = useState<WakeLockState>({ enabled: false, status: "off" });
  const controllerRef = useRef<WakeLockController | null>(null);
  useEffect(() => {
    const controller = createWakeLockController(environment ? environment() : browserWakeLockEnvironment());
    controllerRef.current = controller;
    /* Subscribed before start(), so the first capability/intent publish — the
       one that turns the server-safe `off` into the real status — arrives here. */
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    const onVisibility = () => controller.syncVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    controller.start();
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      controller.stop();
      controllerRef.current = null;
    };
  }, [environment]);
  const setEnabled = useCallback((next: boolean) => controllerRef.current?.setEnabled(next), []);
  return { ...state, setEnabled };
}
