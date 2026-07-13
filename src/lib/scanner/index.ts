import type { FileEntry, ProjectCatalogEntry } from "../types";
import { agentRegistry, RegistryReadError } from "../agent/registry";
import { tickFlows } from "../flows/engine";
import { tickPipelines } from "../pipelines/engine";
import { notifyQuestion } from "../push";
import { overlaySessionTitles } from "../session/titleProjection";
import { tickTaskInbox } from "../tasks/inboxScanner";
import { resolveTarget } from "../tmux";
import { tickWorkflows } from "../workflows/engine";
import { activityVerdict } from "./activity";
import { ctxFor } from "./context";
import { discoverFiles, discoverFilesWithProjectCatalog } from "./discover";
import { entryEffort, entryFast } from "./effort";
import { linkEntries } from "./links";
import { entryModels } from "./model";
import { outputHolders } from "./process";
import { goalFor, planFor } from "./plan";
import { pendingQuestionFor } from "./questions";
import { pendingWakeupFor } from "./wakeup";
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
 *     stat each file, dedupe copied Codex rollouts, reserve each project's
 *     recent entries, then fill the FILE_CAP target by global mtime.
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
  /** Deep-link target that must survive the recency cap: a transcript path,
      or a `conversation_*` id resolved to its current generation path. */
  pin?: string;
}

/** Transcript paths a pin value requires in the feed. A conversation id is
    canonicalized through the registry's durable aliases and maps to its
    latest generation. A plain path also brings the registry-current
    generation of its owning conversation, so an archived `#f=` target always
    ships together with the successor the client must redirect to. An
    unreadable registry keeps a path pin as itself and drops an id pin. */
export function pinnedPathsFor(pin: string | undefined): ReadonlySet<string> {
  if (!pin) return new Set();
  try {
    const registry = agentRegistry();
    const snapshot = registry.snapshot();
    if (pin.startsWith("conversation_")) {
      const canonical = registry.canonicalConversationId(pin as `conversation_${string}`) ?? pin;
      const latest = snapshot.conversations[canonical]?.generations.at(-1)?.path;
      return new Set(latest ? [latest] : []);
    }
    const owner = Object.values(snapshot.conversations).find((conversation) =>
      conversation.generations.some((generation) => generation.path === pin) || conversation.continuityPaths.includes(pin));
    const latest = owner?.generations.at(-1)?.path;
    return new Set(latest && latest !== pin ? [pin, latest] : [pin]);
  } catch (error) {
    if (error instanceof RegistryReadError) return new Set(pin.startsWith("conversation_") ? [] : [pin]);
    throw error;
  }
}

export async function listFiles(options: FileScanOptions = {}): Promise<FileEntry[]> {
  return (await listFilesInternal(false, undefined, options)).files;
}

export async function listFilesWithProjectCatalog(selectedProject?: string, options: FileScanOptions = {}): Promise<{ files: FileEntry[]; projectCatalog: ProjectCatalogEntry[] }> {
  return listFilesInternal(true, selectedProject, options);
}

/* Transcript paths superseded by an account migration: every generation and
   continuity path of a conversation except its current one. Mirrors the
   `migratedTo` annotation in the files response — these entries are folded
   into their successor's card, so they rank below live transcripts when the
   recency cap is applied and leave the cap slots to live conversations. */
export function archivedTranscriptPaths(): ReadonlySet<string> {
  const archived = new Set<string>();
  let snapshot: ReturnType<ReturnType<typeof agentRegistry>["snapshot"]>;
  try {
    snapshot = agentRegistry().snapshot();
  } catch (error) {
    /* Demotion only shapes the recency ranking. When the registry is
       corrupt or unsupported, discovery proceeds with an empty demotion set
       and timeline/spawn/tasks/tmux stay available. Mirrors the board
       route's RegistryReadError handling. */
    if (error instanceof RegistryReadError) return archived;
    throw error;
  }
  for (const conversation of Object.values(snapshot.conversations)) {
    const latest = conversation.generations.at(-1);
    if (!latest) continue;
    for (const generation of conversation.generations) if (generation.path !== latest.path) archived.add(generation.path);
    for (const pathname of conversation.continuityPaths) if (pathname !== latest.path) archived.add(pathname);
  }
  return archived;
}

async function listFilesInternal(
  includeProjectCatalog: boolean,
  selectedProject?: string,
  options: FileScanOptions = {},
): Promise<{ files: FileEntry[]; projectCatalog: ProjectCatalogEntry[] }> {
  const persist = options.persist === true;
  const demote = archivedTranscriptPaths();
  const scan = includeProjectCatalog
    ? await discoverFilesWithProjectCatalog(undefined, selectedProject, { persist, demote, pin: pinnedPathsFor(options.pin) })
    : { files: await discoverFiles(undefined, demote), projectCatalog: [] };
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
    entry.fast = entryFast(entry);
  });
  await forEachEntryBatchYielding(entries, async (entry) => {
    const pending = pendingQuestionFor(entry);
    entry.pendingQuestion = pending && entry.pid !== null ? { ...pending, paneTarget: await resolveTarget(entry.pid) } : pending;
    const probe = await waitingInputProbe(entry);
    entry.waitingInput = probe.waiting;
    entry.rateLimit = probe.rateLimit;
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
    entry.pendingWakeup = pendingWakeupFor(entry);
  });
  await linkEntries(entries, { persist });
  return { files: entries, projectCatalog: scan.projectCatalog };
}

/** Durable controllers run outside request handlers. Flow ordering remains
    stable: workflows observe the flow state from the same controller tick. */
export async function reconcileFileControllers(entries: FileEntry[]): Promise<void> {
  await linkEntries(entries, { persist: true });
  // Custom session titles (issue #33) must reach push bodies too, so overlay
  // them before notifying — a rename shows the human name in notifications.
  overlaySessionTitles(entries);
  for (const entry of entries) if (entry.pendingQuestion || entry.waitingInput) void notifyQuestion(entry);
  await tickFlows(entries);
  await tickPipelines(entries);
  await tickWorkflows(entries);
  tickTaskInbox(entries);
}
