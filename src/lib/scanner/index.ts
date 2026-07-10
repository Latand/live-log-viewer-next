import type { FileEntry, ProjectCatalogEntry } from "../types";
import { tickFlows } from "../flows/engine";
import { notifyQuestion } from "../push";
import { tickTaskInbox } from "../tasks/inboxScanner";
import { resolveTarget } from "../tmux";
import { tickWorkflows } from "../workflows/engine";
import { activityVerdict } from "./activity";
import { ctxFor } from "./context";
import { discoverFiles, discoverFilesWithProjectCatalog } from "./discover";
import { entryEffort } from "./effort";
import { linkEntries } from "./links";
import { entryModels } from "./model";
import { outputHolders } from "./process";
import { goalFor, planFor } from "./plan";
import { pendingQuestionFor } from "./questions";
import { assignTranscriptPids } from "./transcripts";
import { waitingInputProbe } from "./waitingInput";

function applyProcessState(entry: FileEntry, holders: Map<string, number>) {
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
const YIELD_EVERY = 75;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function forEachEntryYielding(entries: FileEntry[], visit: (entry: FileEntry) => void): Promise<void> {
  for (let index = 0; index < entries.length; index += 1) {
    visit(entries[index]!);
    if ((index + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }
}

async function forEachEntryBatchYielding(
  entries: FileEntry[],
  visit: (entry: FileEntry) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < entries.length; start += YIELD_EVERY) {
    await Promise.all(entries.slice(start, start + YIELD_EVERY).map(visit));
    if (start + YIELD_EVERY < entries.length) await yieldToEventLoop();
  }
}

export interface FileScanOptions {
  persist?: boolean;
}

export async function listFiles(options: FileScanOptions = {}): Promise<FileEntry[]> {
  return (await listFilesInternal(false, undefined, options)).files;
}

export async function listFilesWithProjectCatalog(selectedProject?: string, options: FileScanOptions = {}): Promise<{ files: FileEntry[]; projectCatalog: ProjectCatalogEntry[] }> {
  return listFilesInternal(true, selectedProject, options);
}

async function listFilesInternal(
  includeProjectCatalog: boolean,
  selectedProject?: string,
  options: FileScanOptions = {},
): Promise<{ files: FileEntry[]; projectCatalog: ProjectCatalogEntry[] }> {
  const persist = options.persist === true;
  const scan = includeProjectCatalog
    ? await discoverFilesWithProjectCatalog(undefined, selectedProject, { persist })
    : { files: await discoverFiles(), projectCatalog: [] };
  const entries = scan.files;
  // The /proc fd scan is only needed to attribute background-task outputs to a
  // live pid. When the shortlist has no such entries, skip the scan entirely;
  // activity() only consults holders on the same claude-tasks/.output path.
  const needsHolders = entries.some((entry) => entry.root === "claude-tasks" && entry.path.endsWith(".output"));
  const holders = needsHolders ? outputHolders() : NO_HOLDERS;
  await forEachEntryYielding(entries, (entry) => {
    const verdict = activityVerdict(entry.root, entry.path, entry.mtime, entry.size);
    entry.activity = verdict.state;
    entry.activityReason = verdict.reason;
    const models = entryModels(entry);
    entry.model = models.display;
    entry.launchModel = models.launch;
  });
  await forEachEntryYielding(entries, (entry) => {
    applyProcessState(entry, holders);
  });
  assignTranscriptPids(entries);
  // After pid assignment: the claude effort source is the live process argv.
  await forEachEntryYielding(entries, (entry) => {
    entry.effort = entryEffort(entry);
  });
  await forEachEntryBatchYielding(entries, async (entry) => {
    const pending = pendingQuestionFor(entry);
    entry.pendingQuestion = pending && entry.pid !== null ? { ...pending, paneTarget: await resolveTarget(entry.pid) } : pending;
    const probe = await waitingInputProbe(entry);
    entry.waitingInput = probe.waiting;
    /* A stalled transcript whose pane sits at a plain composer was interrupted
       mid-turn (Esc leaves the turn open in the jsonl): the agent is idle, not
       blocked, so it must not wear the «interrupted or waiting for permission» state. */
    if (probe.atComposer && entry.activity === "stalled") {
      entry.activity = Date.now() / 1000 - entry.mtime < 900 ? "recent" : "idle";
      entry.activityReason = "pane_at_composer";
    }
    entry.plan = planFor(entry);
    entry.goal = goalFor(entry);
    entry.ctx = ctxFor(entry);
  });
  await linkEntries(entries, { persist });
  return { files: entries, projectCatalog: scan.projectCatalog };
}

/** Durable controllers run outside request handlers. Flow ordering remains
    stable: workflows observe the flow state from the same controller tick. */
export async function reconcileFileControllers(entries: FileEntry[]): Promise<void> {
  await linkEntries(entries, { persist: true });
  for (const entry of entries) if (entry.pendingQuestion || entry.waitingInput) void notifyQuestion(entry);
  await tickFlows(entries);
  await tickWorkflows(entries);
  tickTaskInbox(entries);
}
