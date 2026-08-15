import fs from "node:fs";
import path from "node:path";

import { agentRegistry, conversationLookupFromSnapshot } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { canonicalProject } from "@/lib/projects/aliases";
import { discoverFullTranscriptInventory } from "@/lib/scanner/discover";
import { projectFromSlug } from "@/lib/scanner/describe";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { acquireWakatimeSchedulerLease, type WakatimeSchedulerLease } from "@/lib/wakatime/lease";
import { readProductionWakatimeCredential } from "@/lib/wakatime/sync";

import {
  runWorktimeCatchupPass,
  type HistoricalDayScan,
  type WorktimeCatchupDependencies,
} from "./controller";
import {
  scanHistoricalDayFromInventory,
  type HistoricalInventoryEntry,
  type HistoricalTranscriptRead,
} from "./historical";
import { mutateWorktimeState, readWorktimeState, worktimeStatePath } from "./store";
import { fetchWakatimeEditorEvidence } from "./wakatimeEditor";

const CATCHUP_INTERVAL_MS = 15 * 60_000;
const EDITOR_REQUEST_TIMEOUT_MS = 10_000;
const PROJECT_PATTERN = /^-?[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;

interface TimerHandle {
  unref?(): unknown;
}

interface WorktimeRuntimeDependencies extends WorktimeCatchupDependencies {
  acquireLease(): WakatimeSchedulerLease | null;
  scheduleInterval(callback: () => void, delayMs: number): TimerHandle;
  scheduleTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface WorktimeController {
  tick(): Promise<void>;
  stop(): void;
}

function readStableTranscript(entry: Pick<HistoricalInventoryEntry, "path" | "size" | "mtime">): HistoricalTranscriptRead {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(entry.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()
      || typeof entry.size !== "number" || before.size !== entry.size
      || typeof entry.mtime !== "number" || before.mtimeMs / 1_000 !== entry.mtime) {
      return { complete: false, records: [] };
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { complete: false, records: [] };
    const records: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return { complete: false, records: [] };
      records.push(value as Record<string, unknown>);
    }
    return { complete: true, records };
  } catch {
    return { complete: false, records: [] };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function transcriptCwd(records: HistoricalTranscriptRead["records"]): string | null {
  for (const item of records) {
    const payload = recordValue(item.payload);
    const cwd = typeof item.cwd === "string" ? item.cwd : typeof payload?.cwd === "string" ? payload.cwd : null;
    if (cwd?.trim()) return cwd;
  }
  return null;
}

function claudeFallbackProject(rootPath: string, pathname: string): string | null {
  const relative = path.relative(rootPath, pathname);
  const slug = relative.split(path.sep)[0];
  return slug && slug !== ".." ? projectFromSlug(slug) : null;
}

export async function scanProductionHistoricalDay(day: string): Promise<HistoricalDayScan> {
  const inventory = await discoverFullTranscriptInventory();
  if (!inventory.complete) return { complete: false, reason: "inventory-incomplete", occurrences: [] };
  const transcripts = new Map<string, HistoricalTranscriptRead>();
  for (const entry of inventory.files) {
    const transcript = readStableTranscript(entry);
    if (!transcript.complete) {
      return { complete: false, reason: "transcript-tail-incomplete", occurrences: [] };
    }
    transcripts.set(entry.path, transcript);
  }
  const registry = agentRegistry().readOnlySnapshot();
  const lookup = conversationLookupFromSnapshot(registry);
  const relevant: HistoricalInventoryEntry[] = inventory.files.map((entry) => {
    const conversation = lookup.conversationForPath(entry.path);
    const generation = conversation?.generations.find((candidate) => candidate.path === entry.path)
      ?? conversation?.generations.at(-1);
    const cwd = generation?.launchProfile.cwd.trim() || transcriptCwd(transcripts.get(entry.path)?.records ?? []);
    const attribution = resolveProjectAttribution({
      projectOwnership: conversation?.projectOwnership,
      cwd,
      launchProfileProject: generation?.launchProfile.project,
      fallbackProject: entry.root === "claude-projects"
        ? claudeFallbackProject(entry.rootPath, entry.path)
        : null,
    });
    const unresolved = !attribution.project || attribution.project === UNRESOLVED_PROJECT;
    return {
      ...entry,
      project: unresolved ? "" : attribution.project!,
      ...(unresolved ? { projectUnresolved: true as const } : {}),
      ...(conversation?.projectOwnership ? { projectOwnership: conversation.projectOwnership } : {}),
      cwd,
      ...(attribution.source ? { projectSource: attribution.source } : {}),
      derivationComplete: true,
    };
  });
  return scanHistoricalDayFromInventory(
    day,
    { complete: true, files: relevant },
    registry,
    (entry) => transcripts.get(entry.path) ?? { complete: false, records: [] },
  );
}

function projectPriority(environment: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const configured = environment.LLV_WORKTIME_PROJECT_PRIORITY ?? "";
  return [...new Set(configured
    .split(",")
    .map((project) => project.trim())
    .filter((project) => PROJECT_PATTERN.test(project))
    .map(canonicalProject))];
}

async function fetchProductionEditorEvidence(day: string) {
  const credential = readProductionWakatimeCredential();
  if (!credential) throw new Error("WakaTime credential is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EDITOR_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await fetchWakatimeEditorEvidence(day, credential.value, (url, init) => (
      fetch(url, { ...init, signal: controller.signal })
    ));
  } finally {
    clearTimeout(timeout);
  }
}

function productionDependencies(): WorktimeRuntimeDependencies {
  return {
    now: Date.now,
    readState: () => readWorktimeState(),
    scanHistoricalDay: scanProductionHistoricalDay,
    fetchEditorEvidence: fetchProductionEditorEvidence,
    mutate: (operation) => mutateWorktimeState(undefined, Date.now(), operation),
    projectPriority: projectPriority(),
    stateExists: () => fs.existsSync(worktimeStatePath()),
    acquireLease: () => acquireWakatimeSchedulerLease(statePath("worktime-scheduler-owner.json")),
    scheduleInterval: (callback, delayMs) => setInterval(callback, delayMs),
    scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function createWorktimeController(dependencies: WorktimeRuntimeDependencies): WorktimeController {
  let stopped = false;
  let running: Promise<void> | null = null;
  let trailing = false;
  let lease: WakatimeSchedulerLease | null = null;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (lease && !lease.isHeld()) {
      lease.release();
      lease = null;
    }
    lease ??= dependencies.acquireLease();
    if (!lease?.isHeld()) return Promise.resolve();
    if (running) {
      trailing = true;
      return running;
    }
    running = runWorktimeCatchupPass(dependencies).catch(() => {
      console.error("[worktime] catchup_failed");
    });
    const current = running;
    void current.finally(() => {
      running = null;
      if (trailing && !stopped) {
        trailing = false;
        void tick();
      }
    });
    return current;
  };
  const initial = dependencies.scheduleTimeout(() => { void tick(); }, 0);
  initial.unref?.();
  const interval = dependencies.scheduleInterval(() => { void tick(); }, CATCHUP_INTERVAL_MS);
  interval.unref?.();
  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      trailing = false;
      dependencies.clearTimer(initial);
      dependencies.clearTimer(interval);
      const release = () => {
        lease?.release();
        lease = null;
      };
      if (running) void running.finally(release);
      else release();
    },
  };
}

const singleton = globalThis as typeof globalThis & { __llvWorktimeController?: WorktimeController };

export function startWorktimeController(dependencies: WorktimeRuntimeDependencies = productionDependencies()): void {
  if (singleton.__llvWorktimeController) return;
  singleton.__llvWorktimeController = createWorktimeController(dependencies);
}
