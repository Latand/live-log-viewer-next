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
import { rolledBack, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

export const SNAPSHOT_URL = "/api/runtime/snapshot";
export const STREAM_URL = "/api/runtime/stream";

/** Fired on `window` whenever the tab's SSE transport re-subscribes (connection
 *  returns to `live`). A draft's launch watch listens to reset its convergence
 *  window (issue #919): a reconnect means everything observed before it may be
 *  stale, so recovery timers restart instead of giving up. */
export const STREAM_RECONNECTED_EVENT = "llv:stream-reconnected";

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
/** Publish accumulated store changes at most once per display frame. */
const SUBSCRIBER_NOTIFY_MS = 16;

export interface RuntimeBusState {
  store: RuntimeStore;
  connection: ConnectionState;
  /** Timestamp (ms) of the last cursor-reset snapshot reload, else null. */
  resyncedAt: number | null;
  /** Timestamp (ms) of the last applied event or heartbeat, else null. */
  lastEventAt: number | null;
  /** False until start() runs with the flag on — the UI shows nothing live. */
  enabled: boolean;
  structuredHostsEnabled: boolean;
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

/** The deployment carries no runtime plane at all. Distinct from every other
 *  transport failure: reconnecting cannot fix it, and a bus that kept claiming
 *  authority would leave every conversation `unresolved` forever. */
class RuntimePlaneAbsentError extends Error {}

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
  /** Force a fresh snapshot into the store on demand (dead-host Re-check, §5):
      a recovered host flips its axis and the projection clears the banner.
      Resolves `true` when a snapshot was installed, `false` on a failed fetch so
      the caller can surface the failure. The live stream is left untouched. */
  refresh(): Promise<boolean>;
}

export function createRuntimeBus(deps: RuntimeBusDeps): RuntimeBus {
  let state: RuntimeBusState = {
    store: emptyStore(),
    connection: "offline",
    resyncedAt: null,
    lastEventAt: null,
    enabled: false,
    structuredHostsEnabled: false,
  };

  const listeners = new Set<() => void>();
  const filesListeners = new Set<(revision: number) => void>();
  let emitQueued = false;

  let source: EventSourceLike | null = null;
  let generation = 0; // bumps on every teardown so stale callbacks no-op
  let joining = false;
  let hasSnapshot = false; // a full snapshot has been installed at least once
  let planeAbsent = false; // this deployment serves no runtime plane at all
  let reconnectAttempts = 0;
  let firstFailureAt: number | null = null;

  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resyncedTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackEpoch = 0;
  let fallbackPollSerial = 0;
  let fallbackAppliedSerial = 0;

  function emit(): void {
    if (emitQueued || listeners.size === 0) return;
    emitQueued = true;
    deps.setTimeout(() => {
      emitQueued = false;
      for (const listener of listeners) listener();
    }, SUBSCRIBER_NOTIFY_MS);
  }

  function setState(patch: Partial<RuntimeBusState>): void {
    const previousConnection = state.connection;
    state = { ...state, ...patch };
    if (state.connection === "live" && previousConnection !== "live" && typeof window !== "undefined") {
      window.dispatchEvent(new Event(STREAM_RECONNECTED_EVENT));
    }
    emit();
  }

  function clearTimer(handle: ReturnType<typeof setTimeout> | null): null {
    if (handle) deps.clearTimeout(handle);
    return null;
  }

  function clearFallback(): void {
    fallbackEpoch += 1;
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

  function markOpen(): void {
    if (firstFailureAt === null && state.connection !== "live") setState({ connection: "live" });
    armHeartbeat();
  }

  function confirmHealthy(): void {
    reconnectAttempts = 0;
    firstFailureAt = null;
    markOpen();
  }

  /** Snapshot fetch that tells a plane-absent deployment (no runtime host in
      this deployment at all) apart from a declared host that is failing. */
  async function fetchSnapshot(): Promise<RuntimeSnapshot> {
    const res = await deps.fetch(SNAPSHOT_URL, { headers: { accept: "application/json" } });
    if (res.ok) return (await res.json()) as RuntimeSnapshot;
    if (res.status === 503) {
      let code: unknown = null;
      try {
        code = ((await res.json()) as { code?: unknown } | null)?.code ?? null;
      } catch {
        code = null;
      }
      if (code === RUNTIME_PLANE_ABSENT) throw new RuntimePlaneAbsentError("runtime plane absent");
    }
    throw new Error(`snapshot ${res.status}`);
  }

  /** Tear everything down and go inert. Shared by `stop()` and the plane-absent
      path so both leave exactly the same observable state. */
  function goInert(): void {
    closeSource();
    clearFallback();
    reconnectTimer = clearTimer(reconnectTimer);
    resyncedTimer = clearTimer(resyncedTimer);
    hasSnapshot = false;
    reconnectAttempts = 0;
    firstFailureAt = null;
    state = {
      store: emptyStore(),
      connection: "offline",
      resyncedAt: null,
      lastEventAt: null,
      enabled: false,
      structuredHostsEnabled: false,
    };
    emit();
  }

  /**
   * The runtime routes answered that this deployment has no runtime plane.
   * The UI flag ships on, so a tmux-only viewer lands here — and a bus that
   * stayed `enabled` with an empty store would make the plane authoritative
   * but blind, resolving every running conversation to `unresolved` (Send
   * disabled, Stop/kill/terminal hidden) for the life of the tab. Going inert
   * hands authority back to `file.proc`, i.e. the legacy path. Latched: the
   * answer is deployment configuration, not an outage, so remounting consumers
   * must not restart the join loop. A *declared* host that is merely down never
   * reaches here — that stays a reconnectable transport failure, and the
   * `unresolved` fail-safe keeps applying while its snapshot is outstanding.
   */
  function markPlaneAbsent(): void {
    planeAbsent = true;
    goInert();
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
      const snapshot = await fetchSnapshot();
      if (myGen !== generation) return; // superseded while awaiting
      hasSnapshot = true;
      setState({
        store: installSnapshot(snapshot),
        lastEventAt: deps.now(),
        structuredHostsEnabled: snapshot.structuredHostsEnabled === true,
      });
      if (afterCursorReset) noteResynced();
      openStream(snapshot.snapshotSeq);
    } catch (error) {
      if (error instanceof RuntimePlaneAbsentError) return markPlaneAbsent();
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
      markOpen();
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
      confirmHealthy();
    });
    es.addEventListener("fault", (ev) => {
      if (myGen !== generation) return;
      try {
        const fault = JSON.parse(ev.data) as { code?: unknown };
        if (fault.code !== "runtime-host-unavailable") return;
      } catch {
        return;
      }
      onTransportLost();
    });
    es.addEventListener("reset", () => {
      if (myGen !== generation) return;
      // Cursor older than retention: reload the snapshot, keep it visible.
      void join(true);
    });
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
      confirmHealthy();
      if (result.filesBumped) {
        for (const listener of filesListeners) listener(result.store.filesRevision);
      }
    } else if (result.outcome === "duplicate") {
      confirmHealthy();
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
   *  missing revisions (A3). Refresh the deployment gate before reopening so
   *  a tab converges after a server restart. */
  function resume(): void {
    if (!hasSnapshot) {
      void join(false);
      return;
    }
    void refreshGateAndResume();
  }

  async function refreshGateAndResume(): Promise<void> {
    const myGen = generation;
    try {
      const snapshot = await fetchSnapshot();
      if (myGen !== generation) return;
      setState({ structuredHostsEnabled: snapshot.structuredHostsEnabled === true });
      openStream(state.store.cursor);
    } catch (error) {
      if (error instanceof RuntimePlaneAbsentError) return markPlaneAbsent();
      if (myGen !== generation) return;
      onTransportLost();
    }
  }

  /** Bounded poll fallback: refresh the snapshot every 10s and periodically retry SSE. */
  function startFallback(): void {
    closeSource();
    clearFallback();
    const myEpoch = fallbackEpoch;
    setState({ connection: "degraded" });
    void pollFallback(myEpoch);
    fallbackTimer = deps.setInterval(() => void pollFallback(myEpoch), FALLBACK_POLL_MS);
    sseRetryTimer = deps.setTimeout(() => {
      sseRetryTimer = null;
      clearFallback();
      firstFailureAt = null;
      reconnectAttempts = 0;
      resume();
    }, SSE_RETRY_MS);
  }

  async function pollFallback(myEpoch: number): Promise<void> {
    const myPollSerial = ++fallbackPollSerial;
    try {
      const snapshot = await fetchSnapshot();
      if (
        myEpoch !== fallbackEpoch
        || snapshot.snapshotSeq < state.store.cursor
        || (snapshot.snapshotSeq === state.store.cursor && myPollSerial < fallbackAppliedSerial)
      ) return;
      fallbackAppliedSerial = Math.max(fallbackAppliedSerial, myPollSerial);
      const prevFiles = state.store.filesRevision;
      setState({
        store: installSnapshot(snapshot),
        lastEventAt: deps.now(),
        connection: "degraded",
        structuredHostsEnabled: snapshot.structuredHostsEnabled === true,
      });
      if (snapshot.filesRevision > prevFiles) {
        for (const listener of filesListeners) listener(snapshot.filesRevision);
      }
    } catch (error) {
      if (error instanceof RuntimePlaneAbsentError) return markPlaneAbsent();
      if (myEpoch !== fallbackEpoch) return;
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
      // A plane-absent deployment stays inert for the tab: every remounting
      // consumer calls start(), and re-joining would only re-learn the same
      // 503 while flipping authority back on in between.
      if (planeAbsent || state.enabled) return;
      setState({ enabled: true, connection: "reconnecting" });
      void join(false);
    },
    stop() {
      goInert();
    },
    async refresh() {
      const myGen = generation;
      try {
        const snapshot = await fetchSnapshot();
        // A newer generation already superseded us (reconnect/stop raced): the
        // fetch itself succeeded and fresher state is live, so report success.
        if (myGen !== generation) return true;
        // Monotonic install (same guard as pollFallback): a slow refresh
        // response that lost the race to live events or a newer snapshot must
        // never regress the cursor. The refresh itself succeeded — fresher
        // state than the response is already live — so still report success.
        if (snapshot.snapshotSeq < state.store.cursor) return true;
        hasSnapshot = true;
        // Refresh the structured-hosts rollback gate alongside the store — every
        // other snapshot-install path (join/resume/fallback) does, so a manual
        // dead-host Re-check must too, or a tab keeps a stale gate after a
        // rollback flip (issue #241 finding 1).
        setState({
          store: installSnapshot(snapshot),
          lastEventAt: deps.now(),
          structuredHostsEnabled: snapshot.structuredHostsEnabled === true,
        });
        return true;
      } catch (error) {
        if (error instanceof RuntimePlaneAbsentError) markPlaneAbsent();
        return false;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Landing-disabled flag + default singleton                          *
 * ------------------------------------------------------------------ */

/**
 * The runtime UI ships on: structured hosting is the default transport, and
 * its controls are what operators drive it with. `NEXT_PUBLIC_RUNTIME_UI=0` is
 * the build-time rollback (read through the same normalisation as the
 * server-side switches, so a quoted or padded value still rolls back); a
 * `llv_runtime_ui=1` localStorage override still turns the surface back on for
 * local UX evidence on an isolated dev port.
 *
 * Turning the surface on is not a claim that a runtime host exists — this value
 * is inlined at build time and cannot know. The bus resolves that at runtime and
 * goes inert on a plane-absent deployment (see `markPlaneAbsent`).
 */
let runtimeUiTestOverride: boolean | null = null;

export function isRuntimeUiEnabled(): boolean {
  if (runtimeUiTestOverride !== null) return runtimeUiTestOverride;
  // The literal member expression is what Next inlines at build time; keep it.
  if (!rolledBack(process.env.NEXT_PUBLIC_RUNTIME_UI)) return true;
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

/** Stop every timer/transport owned by the browser singleton and forget it. */
export function resetRuntimeBusForTests(): void {
  singleton?.stop();
  singleton = null;
}

/** Lifecycle-scoped switch for DOM tests that intentionally exercise legacy UI. */
export function setRuntimeUiEnabledForTests(enabled: boolean | null): void {
  resetRuntimeBusForTests();
  runtimeUiTestOverride = enabled;
}

/** Install one lifecycle-owned bus so component tests exercise the real hooks. */
export function setRuntimeBusForTests(bus: RuntimeBus | null): void {
  resetRuntimeBusForTests();
  singleton = bus;
  runtimeUiTestOverride = bus === null ? null : true;
}
