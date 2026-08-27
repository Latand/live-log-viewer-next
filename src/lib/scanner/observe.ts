import type { FileEntry } from "../types";
import { resolveTarget } from "../tmux";
import { ctxFor } from "./context";
import { lastAssistantMessageAtFor, lastTurnFor } from "./turnDuration";
import { discoverFiles } from "./discover";
import { entryEffort, entryEffortResult, entryFast } from "./effort";
import { linkEntries } from "./links";
import { entryModelsResult } from "./model";
import { outputHolders } from "./process";
import { goalFor, planFor } from "./plan";
import { pendingQuestionFor } from "./questions";
import { pendingWakeupFor } from "./wakeup";
import { assignTranscriptPids } from "./transcripts";
import { waitingInputProbe } from "./waitingInput";
import { activityVerdict, transcriptTurnResult } from "./activity";

/**
 * An inert mirror of the scanner enrichment pipeline for snapshot reads.
 *
 * ## Single flight and cancellation (#845)
 *
 * This walks the whole corpus. It is the read behind `operator_snapshot` and
 * `/api/agent/snapshot`, and it used to run once per CALLER: twenty concurrent
 * warm requests meant twenty full corpus walks racing each other, on a machine
 * already running the coordinator's own scan generation. Worse, nothing stopped:
 * a client that deadlined out at five seconds left its walk running to completion
 * against files nobody would read, and the next request started another.
 *
 * So it is single-flight, the way the file-scan coordinator is: concurrent callers
 * join one observation and each receives its own deep clone, because the snapshot
 * composer mutates the entries it is given (custom titles are overlaid onto them)
 * and two callers sharing one array would corrupt each other.
 *
 * Cancellation is reference-counted rather than per-caller. One caller walking away
 * must not cancel the observation the other nineteen are waiting on, and the last
 * caller walking away must not leave it running: when the joiner count reaches zero
 * the shared signal aborts, and the walk stops at its next batch boundary.
 */

const YIELD_EVERY = 75;
const NO_HOLDERS: Map<string, number> = new Map();
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class ObservationCancelledError extends Error {
  constructor() {
    super("file observation cancelled");
    this.name = "ObservationCancelledError";
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ObservationCancelledError();
}

async function each(
  entries: FileEntry[],
  visit: (entry: FileEntry) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  for (let index = 0; index < entries.length; index += YIELD_EVERY) {
    /* The batch boundary is already the yield point, so it is also the only place
       an abort can be honoured without leaving an entry half-derived. */
    throwIfCancelled(signal);
    await Promise.all(entries.slice(index, index + YIELD_EVERY).map(visit));
    if (index + YIELD_EVERY < entries.length) await yieldToEventLoop();
  }
}

async function runObservation(signal?: AbortSignal): Promise<FileEntry[]> {
  throwIfCancelled(signal);
  const entries = await discoverFiles();
  const holders = entries.some((entry) => entry.root === "claude-tasks" && entry.path.endsWith(".output")) ? outputHolders() : NO_HOLDERS;
  await each(entries, (entry) => {
    const verdict = activityVerdict(entry.root, entry.path, entry.mtime, entry.size);
    entry.activity = verdict.state; entry.activityReason = verdict.reason; entry.derivationComplete = verdict.complete;
    if (entry.path.endsWith(".jsonl") && (entry.engine === "claude" || entry.engine === "codex" || entry.engine === "openclaw")) {
      const authoritative = transcriptTurnResult(entry.path, entry.size, entry.mtime * 1000, entry.engine);
      entry.derivationComplete &&= authoritative.complete;
      if (authoritative.complete) entry.authoritativeTurn = authoritative.turn;
    }
    const models = entryModelsResult(entry);
    entry.model = models.value.display;
    entry.launchModel = models.value.launch;
    entry.derivationComplete &&= models.complete;
    const effort = entryEffortResult(entry);
    entry.effort = effort.value;
    entry.derivationComplete &&= effort.complete;
    if (entry.root === "claude-tasks" && entry.path.endsWith(".output")) {
      const holder = holders.get(entry.path) ?? null; entry.pid = holder; entry.proc = holder === null ? "done" : "running";
      if (holder !== null) { entry.activity = "live"; entry.activityReason = "output_held"; }
    }
  }, signal);
  assignTranscriptPids(entries);
  await each(entries, (entry) => { entry.effort = entryEffort(entry); entry.fast = entryFast(entry); }, signal);
  await each(entries, async (entry) => {
    const pending = pendingQuestionFor(entry);
    entry.pendingQuestion = pending && entry.pid !== null ? { ...pending, paneTarget: await resolveTarget(entry.pid) } : pending;
    const probe = await waitingInputProbe(entry); entry.waitingInput = probe.waiting; entry.rateLimit = probe.rateLimit;
    if (probe.atComposer && entry.activity === "stalled") { entry.activity = Date.now() / 1000 - entry.mtime < 900 ? "recent" : "idle"; entry.activityReason = "pane_at_composer"; }
    entry.plan = planFor(entry); entry.goal = goalFor(entry); entry.ctx = ctxFor(entry);
    entry.lastTurn = lastTurnFor(entry);
    entry.lastAssistantMessageAt = lastAssistantMessageAtFor(entry);
    entry.pendingWakeup = pendingWakeupFor(entry);
  }, signal);
  throwIfCancelled(signal);
  await linkEntries(entries, { persist: false });
  return entries;
}

interface SharedObservation {
  promise: Promise<FileEntry[]>;
  controller: AbortController;
  joiners: number;
}

/* Next.js can instantiate this module more than once per process; the in-flight
   observation hangs off globalThis so every copy shares one walk. */
const observationHost = globalThis as typeof globalThis & {
  __llvFileObservation?: SharedObservation;
  __llvFileObservationGenerations?: number;
};

/** Diagnostics and tests: whether a walk is currently shared. */
export function fileObservationInFlight(): boolean {
  return observationHost.__llvFileObservation !== undefined;
}

/** How many corpus walks this process has STARTED. The number twenty concurrent
    callers produce is the whole point of the single-flight, so it is measurable
    rather than inferred from a stopwatch. */
export function fileObservationGenerations(): number {
  return observationHost.__llvFileObservationGenerations ?? 0;
}

export function resetFileObservationForTests(): void {
  observationHost.__llvFileObservation = undefined;
  observationHost.__llvFileObservationGenerations = 0;
}

/** Reject as soon as THIS caller is cancelled, without waiting for the shared walk. */
function raceCancellation<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ObservationCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(new ObservationCancelledError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => { signal.removeEventListener("abort", onAbort); });
  });
}

export async function observeFiles(options: { signal?: AbortSignal | null } = {}): Promise<FileEntry[]> {
  let shared = observationHost.__llvFileObservation;
  if (!shared) {
    const controller = new AbortController();
    observationHost.__llvFileObservationGenerations = (observationHost.__llvFileObservationGenerations ?? 0) + 1;
    const created: SharedObservation = { controller, joiners: 0, promise: undefined as unknown as Promise<FileEntry[]> };
    created.promise = runObservation(controller.signal).finally(() => {
      if (observationHost.__llvFileObservation === created) observationHost.__llvFileObservation = undefined;
    });
    /* Nothing may be left holding an unhandled rejection when every joiner has
       already been told about it through its own `await`. */
    void created.promise.catch(() => undefined);
    observationHost.__llvFileObservation = created;
    shared = created;
  }
  const observation = shared;
  observation.joiners += 1;
  try {
    const entries = await raceCancellation(observation.promise, options.signal);
    /* A private deep clone per caller, for the same reason the file-scan coordinator
       hands one out: the snapshot composer overlays titles onto these entries. */
    return structuredClone(entries);
  } finally {
    observation.joiners -= 1;
    /* The last caller out turns off the lights. A walk nobody is waiting for is
       exactly the orphan this exists to prevent. */
    if (observation.joiners <= 0 && observationHost.__llvFileObservation === observation) {
      observation.controller.abort(new ObservationCancelledError());
      observationHost.__llvFileObservation = undefined;
    }
  }
}
