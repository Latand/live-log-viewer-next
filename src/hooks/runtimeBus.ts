"use client";

/**
 * Runtime event bus client (issue #25, slice one).
 *
 * One singleton per tab joins `GET /api/runtime/snapshot` with a
 * cursor-resumable SSE stream (`GET /api/runtime/stream?after=<snapshotSeq>`)
 * and applies events through the strict-revision reducer in `runtimeModel`.
 * It owns the client connection state machine (`live` / `reconnecting` /
 * `degraded` / `offline` plus the transient `resynced` note) and reuses the
 * proven logBus transport ladder: SSE first, a bounded snapshot poll fallback
 * when SSE stays down, and a periodic SSE retry from the fallback.
 *
 * Deterministic tests drive {@link createRuntimeBus} with injected transport
 * and timers; the app uses {@link getRuntimeBus}, a lazily-created singleton
 * wired to the real globals and gated by the landing-disabled flag so nothing
 * connects until the backend routes exist and the flag is turned on.
 */

import {
  applyEvent,
  emptyStore,
  installSnapshot,
  type ConnectionState,
  type RuntimeEnvelope,
  type RuntimeSnapshot,
  type RuntimeStore,
} from "@/components/runtime/runtimeModel";

export const SNAPSHOT_URL = "/api/runtime/snapshot";
export const STREAM_URL = "/api/runtime/stream";

/** No heartbeat/traffic for this long means the transport is silently dead. */
const HEARTBEAT_TIMEOUT_MS = 20_000;
/** Reconnect backoff: base doubles up to the ceiling. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/** After this long stuck reconnecting, drop to the bounded poll fallback. */
const DEGRADE_AFTER_MS = 15_000;
/** Degraded fallback poll cadence (Sol: ten-second fallback poll). */
const FALLBACK_POLL_MS = 10_000;
/** From the fallback, retry a live SSE this often. */
const SSE_RETRY_MS = 60_000;
/** Served nothing for this long → offline (Fable: toast only after >60s). */
const OFFLINE_AFTER_MS = 60_000;
/** How long the transient "resynced" note stays up. */
const RESYNCED_NOTE_MS = 6_000;

export interface RuntimeBusState {
  store: RuntimeStore;
  connection: ConnectionState;
  /** Timestamp (ms) of the last cursor-reset snapshot reload, else null. */
  resyncedAt: number | null;
  /** Timestamp (ms) of the last applied event or heartbeat, else null. */
  lastEventAt: number | null;
  /** False until start() runs with the flag on — the UI shows nothing live. */
  enabled: boolean;
}

/** Minimal EventSource surface so tests can inject a fake. */
export interface EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: string; lastEventId?: string }) => void) | null;
  addEventListener(type: string, listener: (ev: { data: string; lastEventId?: string }) => void): void;
  close(): void;
}

/** A plain fetch-like function — narrower than `typeof fetch` (no `preconnect`)
 *  so tests can supply a simple mock. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeBusDeps {
  fetch: FetchLike;
  createEventSource: (url: string) => EventSourceLike;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

export interface RuntimeBus {
  getState(): RuntimeBusState;
  subscribe(listener: () => void): () => void;
  /** Notified with the new files revision every time a `files.revision` event
   *  is applied — useFiles debounces a pure GET off this. */
  subscribeFilesRevision(listener: (revision: number) => void): () => void;
  start(): void;
  stop(): void;
}

export function createRuntimeBus(deps: RuntimeBusDeps): RuntimeBus {
  let state: RuntimeBusState = {
    store: emptyStore(),
    connection: "offline",
    resyncedAt: null,
    lastEventAt: null,
    enabled: false,
  };

  const listeners = new Set<() => void>();
  const filesListeners = new Set<(revision: number) => void>();

  let source: EventSourceLike | null = null;
  let generation = 0; // bumps on every teardown so stale callbacks no-op
  let joining = false;
  let hasSnapshot = false; // a full snapshot has been installed at least once
  let reconnectAttempts = 0;
  let firstFailureAt: number | null = null;

  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resyncedTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function setState(patch: Partial<RuntimeBusState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function clearTimer(handle: ReturnType<typeof setTimeout> | null): null {
    if (handle) deps.clearTimeout(handle);
    return null;
  }

  function clearFallback(): void {
    if (fallbackTimer) deps.clearInterval(fallbackTimer);
    fallbackTimer = null;
    sseRetryTimer = clearTimer(sseRetryTimer);
  }

  function closeSource(): void {
    generation += 1;
    heartbeatTimer = clearTimer(heartbeatTimer);
    if (source) {
      try {
        source.close();
      } catch {
        /* ignore */
      }
    }
    source = null;
  }

  function armHeartbeat(): void {
    heartbeatTimer = clearTimer(heartbeatTimer);
    heartbeatTimer = deps.setTimeout(() => {
      // No traffic within the window: treat the transport as lost.
      onTransportLost();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  function markLive(): void {
    reconnectAttempts = 0;
    firstFailureAt = null;
    if (state.connection !== "live") setState({ connection: "live" });
    armHeartbeat();
  }

  function noteResynced(): void {
    setState({ resyncedAt: deps.now() });
    resyncedTimer = clearTimer(resyncedTimer);
    resyncedTimer = deps.setTimeout(() => {
      resyncedTimer = null;
      setState({ resyncedAt: null });
    }, RESYNCED_NOTE_MS);
  }

  /** Fetch a fresh snapshot and (re)open the stream from its seq. */
  async function join(afterCursorReset: boolean): Promise<void> {
    if (joining) return;
    joining = true;
    const myGen = generation;
    try {
      const res = await deps.fetch(SNAPSHOT_URL, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const snapshot = (await res.json()) as RuntimeSnapshot;
      if (myGen !== generation) return; // superseded while awaiting
      hasSnapshot = true;
      setState({ store: installSnapshot(snapshot), lastEventAt: deps.now() });
      if (afterCursorReset) noteResynced();
      openStream(snapshot.snapshotSeq);
    } catch {
      if (myGen !== generation) return;
      onTransportLost();
    } finally {
      joining = false;
    }
  }

  function openStream(afterSeq: number): void {
    closeSource();
    const myGen = generation;
    const url = `${STREAM_URL}?after=${encodeURIComponent(String(afterSeq))}`;
    let es: EventSourceLike;
    try {
      es = deps.createEventSource(url);
    } catch {
      onTransportLost();
      return;
    }
    source = es;

    es.onopen = () => {
      if (myGen !== generation) return;
      markLive();
    };
    es.onmessage = (ev) => {
      if (myGen !== generation) return;
      handleEnvelope(ev.data);
    };
    es.onerror = () => {
      if (myGen !== generation) return;
      onTransportLost();
    };
    // Named control frames (heartbeat carries no event id, reset closes the stream).
    es.addEventListener("heartbeat", () => {
      if (myGen !== generation) return;
      setState({ lastEventAt: deps.now() });
      markLive();
    });
    es.addEventListener("reset", () => {
      if (myGen !== generation) return;
      // Cursor older than retention: reload the snapshot, keep it visible.
      void join(true);
    });
    armHeartbeat();
  }

  function handleEnvelope(data: string): void {
    let env: RuntimeEnvelope;
    try {
      env = JSON.parse(data) as RuntimeEnvelope;
    } catch {
      return;
    }
    setState({ lastEventAt: deps.now() });
    const result = applyEvent(state.store, env);
    if (result.outcome === "applied") {
      setState({ store: result.store });
      markLive();
      if (result.filesBumped) {
        for (const listener of filesListeners) listener(result.store.filesRevision);
      }
    } else if (result.outcome === "duplicate") {
      markLive();
    } else {
      // Revision gap: the reducer never mutated. Resnapshot to converge.
      void join(true);
    }
  }

  /** Any transport failure funnels here: escalate reconnecting → degraded → offline. */
  function onTransportLost(): void {
    closeSource();
    const now = deps.now();
    if (firstFailureAt === null) firstFailureAt = now;
    const downFor = now - firstFailureAt;

    if (downFor >= DEGRADE_AFTER_MS) {
      startFallback();
      return;
    }
    setState({ connection: "reconnecting" });
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    reconnectTimer = clearTimer(reconnectTimer);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = null;
      resume();
    }, delay);
  }

  /** Resume the live stream: reopen from the cursor so the server replays only
   *  missing revisions (A3). Fall back to a full snapshot if we never had one,
   *  or if the cursor turns out to predate retention (server sends `reset`). */
  function resume(): void {
    if (hasSnapshot) openStream(state.store.cursor);
    else void join(false);
  }

  /** Bounded poll fallback: refresh the snapshot every 10s and periodically retry SSE. */
  function startFallback(): void {
    closeSource();
    clearFallback();
    setState({ connection: "degraded" });
    void pollFallback();
    fallbackTimer = deps.setInterval(() => void pollFallback(), FALLBACK_POLL_MS);
    sseRetryTimer = deps.setTimeout(() => {
      sseRetryTimer = null;
      clearFallback();
      firstFailureAt = null;
      reconnectAttempts = 0;
      resume();
    }, SSE_RETRY_MS);
  }

  async function pollFallback(): Promise<void> {
    try {
      const res = await deps.fetch(SNAPSHOT_URL, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const snapshot = (await res.json()) as RuntimeSnapshot;
      const prevFiles = state.store.filesRevision;
      setState({ store: installSnapshot(snapshot), lastEventAt: deps.now(), connection: "degraded" });
      if (snapshot.filesRevision > prevFiles) {
        for (const listener of filesListeners) listener(snapshot.filesRevision);
      }
    } catch {
      // Still down. If nothing has been served for long enough, go offline.
      const last = state.lastEventAt;
      if (last !== null && deps.now() - last >= OFFLINE_AFTER_MS && state.connection !== "offline") {
        setState({ connection: "offline" });
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeFilesRevision(listener) {
      filesListeners.add(listener);
      return () => filesListeners.delete(listener);
    },
    start() {
      if (state.enabled) return;
      setState({ enabled: true, connection: "reconnecting" });
      void join(false);
    },
    stop() {
      closeSource();
      clearFallback();
      reconnectTimer = clearTimer(reconnectTimer);
      resyncedTimer = clearTimer(resyncedTimer);
      hasSnapshot = false;
      reconnectAttempts = 0;
      firstFailureAt = null;
      state = { store: emptyStore(), connection: "offline", resyncedAt: null, lastEventAt: null, enabled: false };
      emit();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Landing-disabled flag + default singleton                          *
 * ------------------------------------------------------------------ */

/**
 * Slice-one ships disabled by default (Sol phase 1: "runtime-host, journal,
 * routes, and UI ship disabled"). The flag turns on via the build-time env or,
 * for local UX evidence on an isolated dev port, a `llv_runtime_ui=1`
 * localStorage override.
 */
export function isRuntimeUiEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_RUNTIME_UI === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("llv_runtime_ui") === "1";
  } catch {
    return false;
  }
}

let singleton: RuntimeBus | null = null;

function browserDeps(): RuntimeBusDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    createEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

/** The tab-wide runtime bus. Lazily created; inert until start() runs. */
export function getRuntimeBus(): RuntimeBus {
  if (!singleton) singleton = createRuntimeBus(browserDeps());
  return singleton;
}
