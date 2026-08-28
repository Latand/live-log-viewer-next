import { listFilesWithProjectCatalog, type FileCatalogScan, type FileScanOptions } from "@/lib/scanner";

import { collectFileScanInWorker, fileScanWorkerEnabled, fileScanWorkerLaunch } from "./fileScanWorker";

/**
 * Process-wide filesystem scan coordination (#287).
 *
 * Three independent producers used to own scan generations: the HTTP files
 * cache (10 s cadence), the flow/pipeline watchdog (30 s), and the account
 * controller (60 s). Each ran the raw scanner directly, so cold or invalidated
 * generations overlapped and multiplied corpus reads. This coordinator makes
 * one scan generation active per process: concurrent callers whose intents are
 * covered join the in-flight generation, and callers needing more (durable
 * persistence, fresh process observation) merge into exactly one trailing
 * generation that starts after the current one settles.
 *
 * Every caller receives its own deep clone of the completed snapshot, so a
 * controller mutating its reconciliation copy can never corrupt the snapshot
 * another consumer published or cached.
 */

export interface FileScanIntent {
  /** Durable lineage/state persistence must run inside the scan. */
  persist?: boolean;
  /** Process and pane observations must refresh before hydration. */
  fresh?: boolean;
  /** Whether an already-running covering generation may serve this caller
      (default true). Revision- and freshness-fenced callers pass false: their
      contract requires a scan that STARTED after the request, so they merge
      into the single trailing generation instead. */
  join?: boolean;
  /** The caller's runner carries private scan scope (a pinned path, a staged
      resource publisher) that other callers' runners cannot reproduce. An
      exclusive generation never merges with other pending callers and other
      callers never merge into it — it still holds the process-wide
      single-generation lease and queues behind the running scan. */
  exclusive?: boolean;
  /** This caller's lifetime. The shared generation stops after its final
      subscriber leaves; one cancelled joiner never interrupts the others. */
  signal?: AbortSignal | null;
}

interface ResolvedScanIntent {
  persist: boolean;
  fresh: boolean;
}

export type CoordinatedScanRunner = (intent: ResolvedScanIntent, signal: AbortSignal) => Promise<FileCatalogScan>;

interface ScanGeneration {
  generation: number;
  intent: ResolvedScanIntent;
  /** An exclusive generation's snapshot carries private scope (a pin overlay);
      joiners must never adopt it as the shared catalog. */
  exclusive: boolean;
  runner: CoordinatedScanRunner;
  controller: AbortController;
  subscribers: number;
  started: boolean;
  settled: boolean;
  promise: Promise<FileCatalogScan>;
  resolve: (snapshot: FileCatalogScan) => void;
  reject: (error: unknown) => void;
}

interface CoordinatorState {
  generation: number;
  inflight?: ScanGeneration;
  /** FIFO of generations waiting for the single-generation lease. At most one
      entry is shared (non-exclusive); every other entry owns a private scope. */
  queue: ScanGeneration[];
  startScheduled: boolean;
}

/* Next.js can instantiate this module more than once per process (dev hot
   reload, duplicate bundles); the state hangs off globalThis so every copy
   shares the same single-flight authority. */
const coordinatorHost = globalThis as typeof globalThis & {
  __llvFileScanCoordinator?: CoordinatorState;
};

function coordinatorState(): CoordinatorState {
  return coordinatorHost.__llvFileScanCoordinator ??= { generation: 0, queue: [], startScheduled: false };
}

function covers(running: ResolvedScanIntent, wanted: ResolvedScanIntent): boolean {
  return (running.persist || !wanted.persist) && (running.fresh || !wanted.fresh);
}

export function runFileCatalogScan(
  intent: ResolvedScanIntent,
  options: Omit<FileScanOptions, "persist" | "fresh"> = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<FileCatalogScan> {
  const scanOptions: FileScanOptions = {
    ...options,
    persist: intent.persist,
    ...(intent.fresh ? { fresh: true } : {}),
  };
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  const inProcess = (): Promise<FileCatalogScan> =>
    listFilesWithProjectCatalog(undefined, { ...scanOptions, signal }).then((snapshot) => {
      if (signal.aborted) throw abortError(signal.reason);
      return snapshot;
    });
  if (!fileScanWorkerEnabled()) return inProcess();
  /* A process whose root carries no worker artifact scans here instead. The
     published MCP runtime release is one such root, and the sidecar running
     from it still has to be able to read the corpus: spawning the absent
     artifact failed every read it served, which is what took the deployment
     gate's `board_snapshot` down with it (#790). Slower than the child, and
     the whole difference between a read that answers and one that cannot. */
  if (fileScanWorkerLaunch() === null) return inProcess();
  const { onResourceSnapshot, ...serializable } = scanOptions;
  return collectFileScanInWorker(serializable, onResourceSnapshot, { signal });
}

const defaultRunner: CoordinatedScanRunner = (intent, signal) => runFileCatalogScan(intent, {}, signal);

function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("file scan cancelled", "AbortError");
}

function generationFor(
  intent: ResolvedScanIntent,
  runner: CoordinatedScanRunner,
  exclusive: boolean,
): ScanGeneration {
  let resolve!: (snapshot: FileCatalogScan) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<FileCatalogScan>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  /* Every subscriber may leave before the runner observes its abort. Keep the
     shared rejection handled while each subscriber receives its private one. */
  void promise.catch(() => undefined);
  return {
    generation: 0,
    intent,
    runner,
    exclusive,
    controller: new AbortController(),
    subscribers: 0,
    started: false,
    settled: false,
    promise,
    resolve,
    reject,
  };
}

function startGeneration(
  state: CoordinatorState,
  pending: ScanGeneration,
): ScanGeneration {
  state.generation += 1;
  pending.generation = state.generation;
  pending.started = true;
  state.inflight = pending;
  let scan: Promise<FileCatalogScan>;
  try {
    scan = Promise.resolve(pending.runner(pending.intent, pending.controller.signal));
  } catch (error) {
    scan = Promise.reject(error);
  }
  void scan.then(
    (snapshot) => {
      pending.settled = true;
      pending.resolve(snapshot);
    },
    (error) => {
      pending.settled = true;
      pending.reject(error);
    },
  ).finally(() => {
      if (state.inflight === pending) state.inflight = undefined;
      scheduleStart(state);
    });
  return pending;
}

/* Truly simultaneous requests merge inside one microtask turn, so a burst of
   HTTP, pipeline, and account callers produces one scanner invocation with the
   union of their intents rather than a leader scan plus a trailing one. */
function scheduleStart(state: CoordinatorState): void {
  if (state.startScheduled) return;
  state.startScheduled = true;
  queueMicrotask(() => {
    state.startScheduled = false;
    if (state.inflight) return;
    const pending = state.queue.shift();
    if (!pending) return;
    startGeneration(state, pending);
  });
}

function enqueue(
  state: CoordinatorState,
  intent: ResolvedScanIntent,
  runner: CoordinatedScanRunner,
  exclusive: boolean,
): ScanGeneration {
  if (!exclusive) {
    /* Only the shared pending generation accepts extra callers: an exclusive
       pending runs a runner whose scope (pin, staged publisher) would not
       satisfy them, and merging INTO an exclusive one would widen its scan
       past what its owner requested. */
    const shared = state.queue.find((pending) => !pending.exclusive);
    if (shared) {
      shared.intent = {
        persist: shared.intent.persist || intent.persist,
        fresh: shared.intent.fresh || intent.fresh,
      };
      return shared;
    }
  }
  const pending = generationFor(intent, runner, exclusive);
  state.queue.push(pending);
  scheduleStart(state);
  return pending;
}

function abandonGeneration(state: CoordinatorState, generation: ScanGeneration): void {
  if (generation.settled || generation.subscribers > 0) return;
  generation.controller.abort(abortError());
  if (generation.started) return;
  const queued = state.queue.indexOf(generation);
  if (queued >= 0) state.queue.splice(queued, 1);
  generation.settled = true;
  generation.reject(abortError());
}

function subscribe(
  state: CoordinatorState,
  generation: ScanGeneration,
  signal?: AbortSignal | null,
): Promise<FileCatalogScan> {
  if (signal?.aborted) {
    abandonGeneration(state, generation);
    return Promise.reject(abortError(signal.reason));
  }
  generation.subscribers += 1;
  return new Promise<FileCatalogScan>((resolve, reject) => {
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      signal?.removeEventListener("abort", onAbort);
      generation.subscribers -= 1;
      abandonGeneration(state, generation);
    };
    const onAbort = () => {
      release();
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    generation.promise.then(
      (snapshot) => {
        if (!active) return;
        release();
        resolve(structuredClone(snapshot));
      },
      (error) => {
        if (!active) return;
        release();
        reject(error);
      },
    );
  });
}

/**
 * Join or start the process-wide scan generation satisfying `intent`. The
 * resolved snapshot is a private deep clone owned by the caller.
 */
export async function coordinatedFileScan(
  intent: FileScanIntent = {},
  runner: CoordinatedScanRunner = defaultRunner,
): Promise<FileCatalogScan> {
  const state = coordinatorState();
  if (intent.signal?.aborted) throw abortError(intent.signal.reason);
  const wanted: ResolvedScanIntent = { persist: intent.persist === true, fresh: intent.fresh === true };
  const exclusive = intent.exclusive === true;
  const inflight = state.inflight;
  const generation = !exclusive
    && inflight
    && !inflight.controller.signal.aborted
    && !inflight.exclusive
    && intent.join !== false
    && covers(inflight.intent, wanted)
    ? inflight
    : enqueue(state, wanted, runner, exclusive);
  return subscribe(state, generation, intent.signal);
}

/** Controller-facing seam: pipeline and account reconciliation consume the
    shared generation with durable persistence and keep ownership of their
    mutation phases; they never fan out extra scanner invocations. */
export function coordinatedControllerScan(): Promise<FileCatalogScan> {
  return coordinatedFileScan({ persist: true });
}

export function fileScanCoordinatorStatus(): { inFlight: boolean; queued: number; subscribers: number } {
  const state = coordinatorState();
  return {
    inFlight: state.inflight !== undefined,
    queued: state.queue.length,
    subscribers: (state.inflight?.subscribers ?? 0)
      + state.queue.reduce((total, generation) => total + generation.subscribers, 0),
  };
}

export function resetFileScanCoordinatorForTests(): void {
  const state = coordinatorHost.__llvFileScanCoordinator;
  if (state) {
    state.inflight?.controller.abort(abortError());
    for (const pending of state.queue) {
      pending.controller.abort(abortError());
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(abortError());
      }
    }
  }
  coordinatorHost.__llvFileScanCoordinator = undefined;
}
