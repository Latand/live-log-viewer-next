import type { FileEntry } from "../types";
import { resolveTarget } from "../tmux";
import { ctxFor } from "./context";
import { lastTurnFor } from "./turnDuration";
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

const YIELD_EVERY = 75;
const NO_HOLDERS: Map<string, number> = new Map();
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function each(entries: FileEntry[], visit: (entry: FileEntry) => void | Promise<void>): Promise<void> {
  for (let index = 0; index < entries.length; index += YIELD_EVERY) {
    await Promise.all(entries.slice(index, index + YIELD_EVERY).map(visit));
    if (index + YIELD_EVERY < entries.length) await yieldToEventLoop();
  }
}

/** An inert mirror of the scanner enrichment pipeline for snapshot reads. */
export async function observeFiles(): Promise<FileEntry[]> {
  const entries = await discoverFiles();
  const holders = entries.some((entry) => entry.root === "claude-tasks" && entry.path.endsWith(".output")) ? outputHolders() : NO_HOLDERS;
  await each(entries, (entry) => {
    const verdict = activityVerdict(entry.root, entry.path, entry.mtime, entry.size);
    entry.activity = verdict.state; entry.activityReason = verdict.reason; entry.derivationComplete = verdict.complete;
    if (entry.path.endsWith(".jsonl") && (entry.engine === "claude" || entry.engine === "codex")) {
      const authoritative = transcriptTurnResult(entry.path, entry.size, entry.mtime * 1000, entry.engine === "codex");
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
  });
  assignTranscriptPids(entries);
  await each(entries, (entry) => { entry.effort = entryEffort(entry); entry.fast = entryFast(entry); });
  await each(entries, async (entry) => {
    const pending = pendingQuestionFor(entry);
    entry.pendingQuestion = pending && entry.pid !== null ? { ...pending, paneTarget: await resolveTarget(entry.pid) } : pending;
    const probe = await waitingInputProbe(entry); entry.waitingInput = probe.waiting; entry.rateLimit = probe.rateLimit;
    if (probe.atComposer && entry.activity === "stalled") { entry.activity = Date.now() / 1000 - entry.mtime < 900 ? "recent" : "idle"; entry.activityReason = "pane_at_composer"; }
    entry.plan = planFor(entry); entry.goal = goalFor(entry); entry.ctx = ctxFor(entry);
    entry.lastTurn = lastTurnFor(entry);
    entry.pendingWakeup = pendingWakeupFor(entry);
  });
  await linkEntries(entries, { persist: false });
  return entries;
}
