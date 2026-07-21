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
  /** The caller's runner carries private scan scope (a pinned path, a staged
      resource publisher) that other callers' runners cannot reproduce. An
      exclusive generation never merges with other pending callers and other
      callers never merge into it — it still holds the process-wide
      single-generation lease and queues behind the running scan. */
  exclusive?: boolean;
}

interface ResolvedScanIntent {
  persist: boolean;
  fresh: boolean;
}

export type CoordinatedScanRunner = (intent: ResolvedScanIntent) => Promise<FileCatalogScan>;

interface InflightGeneration {
  generation: number;
  intent: ResolvedScanIntent;
  /** An exclusive generation's snapshot carries private scope (a pin overlay);
      joiners must never adopt it as the shared catalog. */
  exclusive: boolean;
  promise: Promise<FileCatalogScan>;
}

interface PendingGeneration {
  intent: ResolvedScanIntent;
  runner: CoordinatedScanRunner;
  exclusive: boolean;
  promise: Promise<FileCatalogScan>;
  resolve: (snapshot: FileCatalogScan) => void;
  reject: (error: unknown) => void;
}

interface CoordinatorState {
  generation: number;
  inflight?: InflightGeneration;
  /** FIFO of generations waiting for the single-generation lease. At most one
      entry is shared (non-exclusive); every other entry owns a private scope. */
  queue: PendingGeneration[];
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

const defaultRunner: CoordinatedScanRunner = (intent) => listFilesWithProjectCatalog(undefined, {
  persist: intent.persist,
  ...(intent.fresh ? { fresh: true } : {}),
});

function startGeneration(
  state: CoordinatorState,
  intent: ResolvedScanIntent,
  runner: CoordinatedScanRunner,
  exclusive: boolean,
): InflightGeneration {
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
    exclusive,
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
    if (state.inflight) return;
    const pending = state.queue.shift();
    if (!pending) return;
    startGeneration(state, pending.intent, pending.runner, pending.exclusive).promise.then(pending.resolve, pending.reject);
  });
}

function enqueue(
  state: CoordinatorState,
  intent: ResolvedScanIntent,
  runner: CoordinatedScanRunner,
  exclusive: boolean,
): Promise<FileCatalogScan> {
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
      return shared.promise;
    }
  }
  let resolve!: (snapshot: FileCatalogScan) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<FileCatalogScan>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  state.queue.push({ intent, runner, exclusive, promise, resolve, reject });
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
  const exclusive = intent.exclusive === true;
  const inflight = state.inflight;
  const snapshot = !exclusive && inflight && !inflight.exclusive && intent.join !== false && covers(inflight.intent, wanted)
    ? await inflight.promise
    : await enqueue(state, wanted, runner, exclusive);
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
