import type { FileEntry, ProjectCatalogEntry } from "../types";
import { agentRegistry, RegistryReadError } from "../agent/registry";
import { forEachCooperatively, yieldToRuntime } from "../cooperative";
import { tickFlows } from "../flows/engine";
import { tickPipelines } from "../pipelines/engine";
import { notifyQuestion } from "../push";
import { overlaySessionTitles, sessionProjectProjection } from "../session/titleProjection";
import { tickTaskInbox } from "../tasks/inboxScanner";
import { resolveTarget } from "../tmux";
import { tickWorkflows } from "../workflows/engine";
import { activityVerdict } from "./activity";
import { ctxFor } from "./context";
import { lastTurnFor } from "./turnDuration";
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
 *     stat each file, dedupe copied Codex rollouts, then apply the configurable
 *     recent-project and per-project scheme window.
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
const ASYNC_BATCH_SIZE = 16;

async function forEachEntryYielding(entries: FileEntry[], visit: (entry: FileEntry) => void): Promise<void> {
  await forEachCooperatively(entries, visit);
}

async function forEachEntryBatchYielding(
  entries: FileEntry[],
  visit: (entry: FileEntry) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < entries.length; start += ASYNC_BATCH_SIZE) {
    await Promise.all(entries.slice(start, start + ASYNC_BATCH_SIZE).map(visit));
    if (start + ASYNC_BATCH_SIZE < entries.length) await yieldToRuntime();
  }
}

export interface FileScanOptions {
  persist?: boolean;
  /** Persist parsed per-file summaries while keeping controller mutations out
      of request-owned scans. */
  persistIndex?: boolean;
  /** Deep-link target that must survive the recency cap: a transcript path,
      or a `conversation_*` id resolved to its current generation path. */
  pin?: string;
  /** Batch of transcript paths that must survive the recency cap. Used by
      operations that need one activity snapshot for a complete target set. */
  pins?: readonly string[];
}

export interface FileCatalogScan {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  pinOverlayPaths?: string[];
  complete: boolean;
}

/** Transcript paths a pin value requires in the feed. A conversation id is
    canonicalized through the registry's durable aliases and maps to its
    latest generation. A plain path also brings the registry-current
    generation of its owning conversation, so an archived `#f=` target always
    ships together with the successor the client must redirect to. An
    unreadable registry keeps a path pin as itself and drops an id pin. */
export function pinnedPathsFor(value: string | readonly string[] | undefined): ReadonlySet<string> {
  const values = typeof value === "string" ? [value] : value?.filter(Boolean) ?? [];
  if (!values.length) return new Set();
  try {
    const registry = agentRegistry();
    const snapshot = registry.snapshot();
    const paths = new Set<string>();
    const latestByKnownPath = new Map<string, string>();
    const conversationIdByKnownPath = new Map<string, `conversation_${string}`>();
    for (const conversation of Object.values(snapshot.conversations)) {
      const latest = conversation.generations.at(-1)?.path;
      if (!latest) continue;
      for (const generation of conversation.generations) {
        latestByKnownPath.set(generation.path, latest);
        conversationIdByKnownPath.set(generation.path, conversation.id);
      }
      for (const pathname of conversation.continuityPaths) {
        latestByKnownPath.set(pathname, latest);
        conversationIdByKnownPath.set(pathname, conversation.id);
      }
    }
    const children = new Map<string, `conversation_${string}`[]>();
    for (const edge of Object.values(snapshot.lineageEdges)) {
      const parent = registry.canonicalConversationId(edge.parentConversationId);
      const child = registry.canonicalConversationId(edge.childConversationId);
      const rows = children.get(parent) ?? [];
      if (!rows.includes(child)) rows.push(child);
      children.set(parent, rows);
    }
    const membersByContainer = new Map<string, `conversation_${string}`[]>();
    for (const memberships of Object.values(snapshot.memberships)) {
      for (const membership of memberships) {
        const key = `${membership.kind}:${membership.containerId}`;
        const rows = membersByContainer.get(key) ?? [];
        const member = registry.canonicalConversationId(membership.conversationId);
        if (!rows.includes(member)) rows.push(member);
        membersByContainer.set(key, rows);
      }
    }
    const addFamily = (seed: `conversation_${string}`) => {
      const queue = [registry.canonicalConversationId(seed)];
      const seen = new Set<string>();
      while (queue.length) {
        const conversationId = queue.shift()!;
        if (seen.has(conversationId)) continue;
        seen.add(conversationId);
        const conversation = snapshot.conversations[conversationId];
        const latest = conversation?.generations.at(-1)?.path;
        if (latest) paths.add(latest);
        const parent = snapshot.lineageEdges[conversationId]?.parentConversationId;
        if (parent) queue.push(registry.canonicalConversationId(parent));
        for (const child of children.get(conversationId) ?? []) queue.push(child);
        for (const membership of snapshot.memberships[conversationId] ?? []) {
          for (const member of membersByContainer.get(`${membership.kind}:${membership.containerId}`) ?? []) queue.push(member);
        }
      }
    };
    for (const pin of values) {
      if (pin.startsWith("conversation_")) {
        const canonical = registry.canonicalConversationId(pin as `conversation_${string}`) ?? pin;
        if (snapshot.conversations[canonical]) addFamily(canonical);
        continue;
      }
      paths.add(pin);
      const latest = latestByKnownPath.get(pin);
      if (latest) paths.add(latest);
      const owner = conversationIdByKnownPath.get(pin);
      if (owner) addFamily(owner);
    }
    return paths;
  } catch (error) {
    if (error instanceof RegistryReadError) return new Set(values.filter((pin) => !pin.startsWith("conversation_")));
    throw error;
  }
}

export async function listFiles(options: FileScanOptions = {}): Promise<FileEntry[]> {
  return (await listFilesInternal(false, undefined, options)).files;
}

export async function listFilesWithProjectCatalog(selectedProject?: string, options: FileScanOptions = {}): Promise<FileCatalogScan> {
  return listFilesInternal(true, selectedProject, options);
}

/* Transcript paths superseded by an account migration: every generation and
   continuity path of a conversation except its current one. Mirrors the
   `migratedTo` annotation in the files response — these entries are folded
   into their successor's card, so they rank below live transcripts when the
   recency cap is applied and leave the cap slots to live conversations. */
export function archivedTranscriptPaths(): ReadonlySet<string> {
  return sessionProjectProjection(true).archivedPaths;
}

async function listFilesInternal(
  includeProjectCatalog: boolean,
  selectedProject?: string,
  options: FileScanOptions = {},
): Promise<FileCatalogScan> {
  const persist = options.persist === true;
  const demote = archivedTranscriptPaths();
  const requestedPins = options.pins ? [...options.pins, ...(options.pin ? [options.pin] : [])] : options.pin;
  const pin = pinnedPathsFor(requestedPins);
  const scan = includeProjectCatalog
    ? await discoverFilesWithProjectCatalog(undefined, selectedProject, { persist, persistIndex: options.persistIndex, demote, pin })
    : { files: await discoverFiles(undefined, demote, pin), projectCatalog: [], complete: true };
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
    entry.lastTurn = lastTurnFor(entry);
    entry.pendingWakeup = pendingWakeupFor(entry);
  });
  await linkEntries(entries, { persist });
  const pinOverlayPaths = "pinOverlayPaths" in scan ? scan.pinOverlayPaths : undefined;
  return {
    files: entries,
    projectCatalog: scan.projectCatalog,
    ...(pinOverlayPaths?.length ? { pinOverlayPaths } : {}),
    complete: scan.complete,
  };
}

/** Durable controllers run outside request handlers. Flow ordering remains
    stable: workflows observe the flow state from the same controller tick. */
export async function reconcileFileControllers(entries: FileEntry[]): Promise<void> {
  await linkEntries(entries, { persist: true });
  await yieldToRuntime();
  // Custom session titles (issue #33) must reach push bodies too, so overlay
  // them before notifying — a rename shows the human name in notifications.
  overlaySessionTitles(entries);
  await forEachCooperatively(entries, (entry) => {
    if (entry.pendingQuestion || entry.waitingInput) void notifyQuestion(entry);
  });
  await tickFlows(entries);
  await yieldToRuntime();
  await tickPipelines(entries);
  await yieldToRuntime();
  await tickWorkflows(entries);
  await yieldToRuntime();
  tickTaskInbox(entries);
}
