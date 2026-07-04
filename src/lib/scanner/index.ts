import type { FileEntry } from "../types";
import { notifyQuestion } from "../push";
import { resolveTarget } from "../tmux";
import { activityVerdict } from "./activity";
import { tickFlows } from "../flows/engine";
import { ctxFor } from "./context";
import { discoverFiles } from "./discover";
import { entryEffort } from "./effort";
import { numberValue, readJson } from "./json";
import { linkEntries } from "./links";
import { entryModel } from "./model";
import { outputHolders, pidAlive } from "./process";
import { goalFor, planFor } from "./plan";
import { pendingQuestionFor } from "./questions";
import { assignTranscriptPids } from "./transcripts";
import { waitingInputFor } from "./waitingInput";

function applyProcessState(entry: FileEntry, holders: Map<string, number>, job: Record<string, unknown> | null) {
  if (entry.root === "codex-jobs") {
    if (!job) return;
    const pid = numberValue(job.pid);
    entry.pid = pid;
    if (job.status === "running") {
      if (pid !== null && pidAlive(pid)) {
        entry.proc = "running";
        entry.activity = "live";
        entry.activityReason = "job_pid_alive";
      } else {
        entry.proc = "killed";
        if (entry.activity === "live") {
          entry.activity = Date.now() / 1000 - entry.mtime < 900 ? "recent" : "idle";
          entry.activityReason = "job_pid_dead";
        }
      }
      return;
    }
    entry.proc = "done";
    return;
  }
  if (entry.root === "claude-tasks" && entry.path.endsWith(".output")) {
    const holder = holders.get(entry.path) ?? null;
    entry.pid = holder;
    entry.proc = holder === null ? "done" : "running";
    if (holder !== null) {
      entry.activity = "live";
      entry.activityReason = "output_held";
    }
  }
}

/**
 * TODO(codex): full pipeline port of `list_files` from the prototype
 * (the original single-file Python prototype):
 *
 *  1. discover.ts  — walk ROOTS, filter EXTS, skip `tool-results/` and
 *     everything in claude-tasks that is not `<slug>/<sid>/tasks/*.output`,
 *     skip a-prefixed task outputs that mirror subagents/agent-<id>.jsonl,
 *     stat each file, sort by mtime desc, cap at FILE_CAP.
 *  2. describe.ts  — project/title/kind/engine/fmt per root (port `describe`,
 *     `_scan_jsonl_title`, `_project_from_slug`), size-keyed cache.
 *  3. activity.ts  — port `_tail_records`, `_jsonl_turn_state`, `_activity`
 *     (age gate: files quiet >30 min are idle without reading).
 *  4. model.ts     — port `_entry_model` + `_short_model`.
 *  5. links.ts     — port `_link_entries` (parent links + bg-task command
 *     recovery + project inheritance from root ancestor).
 *
 * Steps 3-5 run only on the capped shortlist.
 */
const NO_HOLDERS: Map<string, number> = new Map();

export async function listFiles(): Promise<FileEntry[]> {
  const entries = discoverFiles();
  // The /proc fd scan is only needed to attribute background-task outputs to a
  // live pid. When the shortlist has no such entries, skip the scan entirely;
  // activity() only consults holders on the same claude-tasks/.output path.
  const needsHolders = entries.some((entry) => entry.root === "claude-tasks" && entry.path.endsWith(".output"));
  const holders = needsHolders ? outputHolders() : NO_HOLDERS;
  const jobs = new Map<string, Record<string, unknown> | null>();
  for (const entry of entries) {
    const job = entry.root === "codex-jobs" ? readJson(entry.path.replace(/\.log$/, ".json")) : null;
    jobs.set(entry.path, job);
    const verdict = activityVerdict(entry.root, entry.path, entry.mtime, entry.size, job);
    entry.activity = verdict.state;
    entry.activityReason = verdict.reason;
    entry.model = entryModel(entry);
  }
  for (const entry of entries) {
    applyProcessState(entry, holders, jobs.get(entry.path) ?? null);
  }
  assignTranscriptPids(entries);
  // After pid assignment: the claude effort source is the live process argv.
  for (const entry of entries) entry.effort = entryEffort(entry);
  await Promise.all(entries.map(async (entry) => {
    const pending = pendingQuestionFor(entry);
    entry.pendingQuestion = pending && entry.pid !== null ? { ...pending, paneTarget: await resolveTarget(entry.pid) } : pending;
    entry.waitingInput = await waitingInputFor(entry);
    entry.plan = planFor(entry);
    entry.goal = goalFor(entry);
    entry.ctx = ctxFor(entry);
  }));
  for (const entry of entries) {
    if (entry.pendingQuestion || entry.waitingInput) void notifyQuestion(entry);
  }
  linkEntries(entries);
  await tickFlows(entries);
  return entries;
}
