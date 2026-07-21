import { listFilesWithProjectCatalog, type FileCatalogScan } from "@/lib/scanner";

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
}

interface ResolvedScanIntent {
  persist: boolean;
  fresh: boolean;
}

export type CoordinatedScanRunner = (intent: ResolvedScanIntent) => Promise<FileCatalogScan>;

interface InflightGeneration {
  generation: number;
  intent: ResolvedScanIntent;
  promise: Promise<FileCatalogScan>;
}

interface PendingGeneration {
  intent: ResolvedScanIntent;
  runner: CoordinatedScanRunner;
  promise: Promise<FileCatalogScan>;
  resolve: (snapshot: FileCatalogScan) => void;
  reject: (error: unknown) => void;
}

interface CoordinatorState {
  generation: number;
  inflight?: InflightGeneration;
  pending?: PendingGeneration;
  startScheduled: boolean;
}

/* Next.js can instantiate this module more than once per process (dev hot
   reload, duplicate bundles); the state hangs off globalThis so every copy
   shares the same single-flight authority. */
const coordinatorHost = globalThis as typeof globalThis & {
  __llvFileScanCoordinator?: CoordinatorState;
};

function coordinatorState(): CoordinatorState {
  return coordinatorHost.__llvFileScanCoordinator ??= { generation: 0, startScheduled: false };
}

function covers(running: ResolvedScanIntent, wanted: ResolvedScanIntent): boolean {
  return (running.persist || !wanted.persist) && (running.fresh || !wanted.fresh);
}

const defaultRunner: CoordinatedScanRunner = (intent) => listFilesWithProjectCatalog(undefined, {
  persist: intent.persist,
  ...(intent.fresh ? { fresh: true } : {}),
});

function startGeneration(state: CoordinatorState, intent: ResolvedScanIntent, runner: CoordinatedScanRunner): InflightGeneration {
  state.generation += 1;
  let scan: Promise<FileCatalogScan>;
  try {
    scan = Promise.resolve(runner(intent));
  } catch (error) {
    scan = Promise.reject(error);
  }
  const inflight: InflightGeneration = {
    generation: state.generation,
    intent,
    promise: scan.finally(() => {
      if (state.inflight === inflight) state.inflight = undefined;
      scheduleStart(state);
    }),
  };
  state.inflight = inflight;
  return inflight;
}

/* Truly simultaneous requests merge inside one microtask turn, so a burst of
   HTTP, pipeline, and account callers produces one scanner invocation with the
   union of their intents rather than a leader scan plus a trailing one. */
function scheduleStart(state: CoordinatorState): void {
  if (state.startScheduled) return;
  state.startScheduled = true;
  queueMicrotask(() => {
    state.startScheduled = false;
    if (state.inflight || !state.pending) return;
    const pending = state.pending;
    state.pending = undefined;
    startGeneration(state, pending.intent, pending.runner).promise.then(pending.resolve, pending.reject);
  });
}

function enqueue(state: CoordinatorState, intent: ResolvedScanIntent, runner: CoordinatedScanRunner): Promise<FileCatalogScan> {
  const pending = state.pending;
  if (pending) {
    pending.intent = {
      persist: pending.intent.persist || intent.persist,
      fresh: pending.intent.fresh || intent.fresh,
    };
    return pending.promise;
  }
  let resolve!: (snapshot: FileCatalogScan) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<FileCatalogScan>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  state.pending = { intent, runner, promise, resolve, reject };
  scheduleStart(state);
  return promise;
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
  const wanted: ResolvedScanIntent = { persist: intent.persist === true, fresh: intent.fresh === true };
  const inflight = state.inflight;
  const snapshot = inflight && intent.join !== false && covers(inflight.intent, wanted)
    ? await inflight.promise
    : await enqueue(state, wanted, runner);
  return structuredClone(snapshot);
}

/** Controller-facing seam: pipeline and account reconciliation consume the
    shared generation with durable persistence and keep ownership of their
    mutation phases; they never fan out extra scanner invocations. */
export function coordinatedControllerScan(): Promise<FileCatalogScan> {
  return coordinatedFileScan({ persist: true });
}

export function resetFileScanCoordinatorForTests(): void {
  coordinatorHost.__llvFileScanCoordinator = undefined;
}
