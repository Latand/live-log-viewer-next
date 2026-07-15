import { procBackend } from "@/lib/proc";
import type { ProcBackend } from "@/lib/proc";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { completedFileScan, currentFileScan } from "@/lib/scanner/scanCache";
import { createResourceCollector, type ResourceCollector, type ResourceDegradedReason, type ResourceObservation } from "@/lib/resourceCollector";
import { descendantPids } from "@/lib/proc/memory";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { readTranscriptHosts, type TranscriptHost, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { captureTmuxAttachReferences, type TmuxAttachReference } from "@/lib/tmux";
import { statePath } from "@/lib/configDir";

import type { FileEntry, ResourceSession, ResourcesPayload } from "./types";

/**
 * System memory pressure + per-agent-session memory attribution, the data
 * behind the rail resources block and its cleanup list. Each tmux pane whose
 * process tree contains a claude/codex CLI is one session; the tree sum is
 * what actually frees up on kill-pane — the MCP children (`npm exec`, node
 * servers) hanging off the CLI usually outweigh the CLI itself.
 */

const CACHE_MS = 10_000;

type ResourceBuildPhase = "systemMemory" | "readFiles" | "readHosts" | "ppidMap" | "processMemory" | "attach" | "serialization";
type ResourceBuildPhases = Record<ResourceBuildPhase, number>;

export type ResourceBuildDiagnostic = {
  fresh: boolean;
  status: "complete" | "failed";
  durationMs: number;
  phases: ResourceBuildPhases;
};

export type ServedResourceDiagnostic = ResourceBuildDiagnostic & {
  generation: number;
  startedAt: string;
  completedAt: string;
  collectorId: string;
  degradedReason?: ResourceDegradedReason;
};

export type ResourcesRead = {
  payload: ResourcesPayload;
  diagnostic: ServedResourceDiagnostic;
};

function emptyResourceBuildPhases(): ResourceBuildPhases {
  return {
    systemMemory: 0,
    readFiles: 0,
    readHosts: 0,
    ppidMap: 0,
    processMemory: 0,
    attach: 0,
    serialization: 0,
  };
}

function measureResourcePhase<T>(phases: ResourceBuildPhases, phase: ResourceBuildPhase, work: () => T): T {
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    phases[phase] += performance.now() - startedAt;
  }
}

async function measureResourcePhaseAsync<T>(phases: ResourceBuildPhases, phase: ResourceBuildPhase, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    phases[phase] += performance.now() - startedAt;
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseResourcesFixture(raw: string): ResourcesPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid resources fixture: expected JSON");
  }
  const candidate = value as Partial<ResourcesPayload> | null;
  const system = candidate?.system;
  const validSystem = system === null || (
    typeof system === "object"
    && finiteNonNegative(system.ramTotal)
    && finiteNonNegative(system.ramAvailable)
    && finiteNonNegative(system.swapTotal)
    && finiteNonNegative(system.swapUsed)
    && typeof system.capturedAt === "string"
    && Number.isFinite(Date.parse(system.capturedAt))
  );
  if (!candidate || !validSystem || !Array.isArray(candidate.sessions) || candidate.sessions.length !== 0) {
    throw new Error("invalid resources fixture: expected system metrics and an empty sessions list");
  }
  return { system: system ?? null, sessions: [] };
}

function captureSystemMemory(proc: Pick<ProcBackend, "systemMemory"> = procBackend): ResourcesPayload["system"] {
  const system = proc.systemMemory();
  return system ? { ...system, capturedAt: new Date().toISOString() } : null;
}

/** What the kill path needs to take a snapshot session down safely: the
    stable `%N` pane id to address, and the pane pid to verify it against. */
export type KillTargetRef = TmuxAttachReference;

const globalStore = globalThis as unknown as {
  __llvResourcesReader?: ResourcesReader;
  __llvResourcesReaderFactory?: unknown;
  __llvResourceTargets?: Map<string, KillTargetRef>;
  __llvLastResourceTargets?: Array<{ target: string; ref: KillTargetRef }>;
  __llvResourceTargetsGeneration?: number;
  __llvLastResourceBuild?: ResourceBuildDiagnostic;
};

export function lastResourceBuildDiagnostic(): ResourceBuildDiagnostic | null {
  const diagnostic = globalStore.__llvLastResourceBuild;
  return diagnostic ? { ...diagnostic, phases: { ...diagnostic.phases } } : null;
}

/**
 * Server-held allowlist for the kill-target action: only pane targets present
 * in the last resources snapshot may be killed. A client-supplied arbitrary
 * target could name the user's own work pane, so it is refused. Each target
 * keeps the stable pane id and pane pid it had in the snapshot: display
 * coordinates renumber as windows close (`renumber-windows on`), so the kill
 * must address the pane by id and verify the pid still matches.
 */
export function noteSessionTargets(sessions: Iterable<{ target: string; ref: KillTargetRef }>): void {
  const map = new Map<string, KillTargetRef>();
  for (const { target, ref } of sessions) map.set(target, ref);
  globalStore.__llvResourceTargets = map;
  globalStore.__llvLastResourceTargets = [...map].map(([target, ref]) => ({ target, ref }));
}

/** Applies a served observation exactly once in generation order. A consumed
    target therefore cannot return through a late observation. */
export function applyResourceTargets(
  generation: number,
  sessions: Iterable<{ target: string; ref: KillTargetRef }>,
): void {
  if (generation <= (globalStore.__llvResourceTargetsGeneration ?? 0)) return;
  noteSessionTargets(sessions);
  globalStore.__llvResourceTargetsGeneration = generation;
}

/** Serializable target refs from the observation most recently derived in
    this runtime. Worker adapters return these to the viewer, which remains
    the only runtime that applies the kill allowlist. */
export function lastResourceTargetRefs(): Array<{ target: string; ref: KillTargetRef }> {
  return globalStore.__llvLastResourceTargets?.map(({ target, ref }) => ({ target, ref: { ...ref } })) ?? [];
}

/** Snapshot pane ref recorded for `target`, or null when it was never listed. */
export function allowedKillTarget(target: string): KillTargetRef | null {
  if (target === "") return null;
  return globalStore.__llvResourceTargets?.get(target) ?? null;
}

/** Drops `target` from the allowlist after a kill: the coordinates are free
    for tmux to reuse, so a repeated POST must not pass the gate again. */
export function consumeKillTarget(target: string): void {
  globalStore.__llvResourceTargets?.delete(target);
}

/** The resources rail may list duplicate panes for cleanup. Only the host
    elected by the shared resolver receives the transcript path and its UI
    metadata, keeping observation aligned with path-addressed delivery. */
export function canonicalResourceEntry(
  snapshot: TranscriptHostSnapshot,
  paneHosts: TranscriptHost[],
  entriesByPath: Map<string, FileEntry>,
): FileEntry | null {
  for (const candidate of paneHosts) {
    if (!candidate.primaryPath) continue;
    const canonical = snapshot.canonicalFor(candidate.primaryPath);
    if (canonical?.paneId === candidate.paneId && canonical.agentPid === candidate.agentPid) {
      return entriesByPath.get(candidate.primaryPath) ?? null;
    }
  }
  return null;
}

export function conflictingResourceHost(snapshot: TranscriptHostSnapshot, host: TranscriptHost): boolean {
  return snapshot.conflicts?.some((conflict) => conflict.paneIds.includes(host.paneId)) ?? false;
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export interface ResourceSnapshotDependencies {
  readFiles(fresh: boolean): Promise<FileEntry[]>;
  readHosts(fresh: boolean, entries: FileEntry[], ppids: Map<number, number>): Promise<TranscriptHostSnapshot>;
  proc: Pick<ProcBackend, "systemMemory" | "ppidMap" | "processMemory">;
  captureAttachReferences(refs: ReadonlyArray<Pick<TmuxAttachReference, "tmuxServerPid" | "paneId" | "panePid">>): Map<string, TmuxAttachReference>;
}

const resourceSnapshotDependencies: ResourceSnapshotDependencies = {
  readFiles: readResourceFileSnapshot,
  readHosts: readTranscriptHosts,
  proc: procBackend,
  captureAttachReferences: captureTmuxAttachReferences,
};

export async function readResourceFileSnapshot(fresh: boolean): Promise<FileEntry[]> {
  const scan = fresh ? await currentFileScan({ fresh: true }) : await completedFileScan();
  return scan.snapshot.files;
}

/** `fresh` advances the shared file scan and skips the pane/agent-process
    memos. A rebuild triggered right after a kill must use one newer corpus for
    host ownership, metadata, and the kill allowlist. */
export async function buildResourceSnapshot(
  fresh: boolean,
  dependencies: ResourceSnapshotDependencies = resourceSnapshotDependencies,
): Promise<ResourcesPayload> {
  const startedAt = performance.now();
  const phases = emptyResourceBuildPhases();
  try {
    const system = measureResourcePhase(phases, "systemMemory", () => captureSystemMemory(dependencies.proc));
    const files = await measureResourcePhaseAsync(phases, "readFiles", () => dependencies.readFiles(fresh));
    const ppids = measureResourcePhase(phases, "ppidMap", () => dependencies.proc.ppidMap());
    const hosts = await measureResourcePhaseAsync(phases, "readHosts", () => dependencies.readHosts(fresh, files, ppids));
    const sessions: ResourceSession[] = [];
    if (hosts.hosts.length > 0) {
      overlaySessionTitles(files);
      const byPath = new Map(files.map((entry) => [entry.path, entry]));
      const byPane = new Map<string, TranscriptHost[]>();
      for (const host of hosts.hosts) {
        const paneHosts = byPane.get(host.paneId);
        if (paneHosts) paneHosts.push(host);
        else byPane.set(host.paneId, [host]);
      }

      /* Trees first, memory second: one processMemory() batch over the union
         keeps the portable backend at a single `ps` spawn for all panes. */
      const paneTrees: Array<{ host: TranscriptHost; tree: number[]; paneHosts: TranscriptHost[] }> = [];
      const treePids = new Set<number>();
      for (const paneHosts of byPane.values()) {
        const host = paneHosts[0]!;
        const tree = descendantPids(host.panePid, ppids);
        paneTrees.push({ host, tree, paneHosts });
        for (const pid of tree) treePids.add(pid);
      }
      const memory = measureResourcePhase(phases, "processMemory", () => dependencies.proc.processMemory(treePids));

      const killRefs: Array<{ target: string; ref: KillTargetRef }> = [];
      measureResourcePhase(phases, "attach", () => {
        const attachRefs = dependencies.captureAttachReferences(paneTrees.map(({ host }) => ({
          tmuxServerPid: host.tmuxServerPid,
          panePid: host.panePid,
          paneId: host.paneId,
        })));
        for (const { host, tree, paneHosts } of paneTrees) {
          let rssBytes = 0;
          let swapBytes = 0;
          for (const pid of tree) {
            const mem = memory.get(pid);
            if (!mem) continue;
            rssBytes += mem.rssBytes;
            swapBytes += mem.swapBytes;
          }
          /* The resolver elects one canonical host for every transcript. A
             duplicate pane stays visible for cleanup, though it carries no path
             and cannot disagree with path-addressed delivery. */
          const entry = canonicalResourceEntry(hosts, paneHosts, byPath);
          sessions.push({
            target: host.display,
            panePid: host.panePid,
            path: entry?.path ?? null,
            engine: host.engine,
            hostConflict: conflictingResourceHost(hosts, host),
            title: entry?.title ?? null,
            project: entry?.project || null,
            activity: entry?.activity ?? null,
            lastActiveAt: entry ? isoFromUnix(entry.mtime) : null,
            cwd: host.cwd,
            rssBytes,
            swapBytes,
            procCount: tree.length,
          });
          const ref = attachRefs.get(host.paneId);
          if (ref) killRefs.push({ target: host.display, ref });
        }
      });
      sessions.sort((a, b) => b.rssBytes + b.swapBytes - (a.rssBytes + a.swapBytes));
      noteSessionTargets(killRefs);
    } else {
      noteSessionTargets([]);
    }

    globalStore.__llvLastResourceBuild = { fresh, status: "complete", durationMs: performance.now() - startedAt, phases };
    return { system, sessions };
  } catch (error) {
    globalStore.__llvLastResourceBuild = { fresh, status: "failed", durationMs: performance.now() - startedAt, phases };
    throw error;
  }
}

export interface ResourcesReader {
  read(fresh?: boolean): Promise<ResourcesRead>;
}

type CollectedResources = {
  payload: ResourcesPayload;
  diagnostic: ResourceBuildDiagnostic;
  hostCount: number;
  treeCount: number;
  targets: Array<{ target: string; ref: KillTargetRef }>;
};

const RESOURCE_OBSERVE_TIMEOUT_MS = 30_000;
const RESOURCE_WORKER_TIMEOUT_MS = 29_500;
const RESOURCE_WORKER_CLOSE_TIMEOUT_MS = 1_000;
const RESOURCE_WORKER_OUTPUT_MAX_BYTES = 1_024 * 1_024;
const RESOURCE_OBSERVATION_SCHEMA_VERSION = 1;
const RESOURCE_OBSERVATION_FILE = "resources-observation.json";
const RESOURCE_OBSERVATION_MAX_BYTES = 16 * 1024 * 1024;
const RESOURCE_OBSERVATION_MAX_SESSIONS = 10_000;
const RESOURCE_OBSERVATION_MAX_TARGETS = 10_000;

function collectedResources(
  payload: ResourcesPayload,
  diagnostic: ResourceBuildDiagnostic,
  targets: Array<{ target: string; ref: KillTargetRef }> = [],
): CollectedResources {
  return {
    payload,
    diagnostic,
    hostCount: payload.sessions.length,
    treeCount: payload.sessions.reduce((total, session) => total + session.procCount, 0),
    targets,
  };
}

type ResourceWorkerMessage =
  | { type: "observation"; payload: ResourcesPayload; diagnostic: ResourceBuildDiagnostic; targets: Array<{ target: string; ref: KillTargetRef }> }
  | { type: "failure"; error: string };

function persistedObservation(): ResourceObservation<CollectedResources> | null {
  try {
    const filename = statePath(RESOURCE_OBSERVATION_FILE);
    const size = statSync(filename).size;
    if (size <= 0 || size > RESOURCE_OBSERVATION_MAX_BYTES) return null;
    const candidate = JSON.parse(readFileSync(filename, "utf8")) as { version?: unknown; observation?: unknown };
    const observation = candidate.observation as Partial<ResourceObservation<CollectedResources>> | undefined;
    if (candidate.version !== RESOURCE_OBSERVATION_SCHEMA_VERSION || !observation
      || !Number.isSafeInteger(observation.generation) || (observation.generation ?? -1) < 0
      || !finiteNonNegative(observation.startedAt) || !finiteNonNegative(observation.completedAt)
      || observation.completedAt < observation.startedAt
      || typeof observation.collectorId !== "string" || observation.collectorId.length === 0 || observation.collectorId.length > 256
      || !observation.value || !observation.value.payload || !Array.isArray(observation.value.payload.sessions)
      || observation.value.payload.sessions.length > RESOURCE_OBSERVATION_MAX_SESSIONS
      || !Array.isArray(observation.value.targets) || observation.value.targets.length > RESOURCE_OBSERVATION_MAX_TARGETS
      || !observation.value.targets.every(({ target, ref }) => typeof target === "string" && target.length > 0
        && typeof ref === "object" && ref !== null && Number.isSafeInteger(ref.tmuxServerPid)
        && Number.isSafeInteger(ref.panePid) && typeof ref.paneId === "string" && ref.paneId.startsWith("%"))) return null;
    return observation as ResourceObservation<CollectedResources>;
  } catch {
    return null;
  }
}

function persistObservation(observation: ResourceObservation<CollectedResources>): void {
  const filename = statePath(RESOURCE_OBSERVATION_FILE);
  let temporary: string | undefined;
  try {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify({ version: RESOURCE_OBSERVATION_SCHEMA_VERSION, observation }) + "\n", { mode: 0o600 });
    renameSync(temporary, filename);
    chmodSync(filename, 0o600);
  } catch (error) {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* temporary write never completed */ }
    }
    console.error(`[resources] observation persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One bounded worker owns one observation. Terminating after either outcome
    prevents a crashed or wedged collection from surviving a request timeout. */
async function collectResourcesInWorker(): Promise<CollectedResources> {
  /* The production image ships src/ and Bun. A process adapter keeps the
     worker independent from Next's route bundle and works when Next itself is
     hosted by Node. The explicit in-process flag remains the rollback path. */
  const executable = process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE
    ?? (existsSync("/usr/local/bin/bun-container") ? "/usr/local/bin/bun-container" : "bun");
  const worker = spawn(executable, [path.join(process.cwd(), "src/lib/resourceCollector.worker.ts")], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise<CollectedResources>((resolve, reject) => {
    const pid = worker.pid;
    const expectedIdentity = typeof pid === "number" ? procBackend.processIdentity(pid) : null;
    let outcome: (() => void) | null = null;
    let closed = false;
    let outputBytes = 0;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const sameWorker = () => typeof pid === "number"
      && (expectedIdentity === null || procBackend.processIdentity(pid) === expectedIdentity);
    const terminate = () => {
      if (worker.exitCode !== null || worker.signalCode !== null || !sameWorker()) return;
      worker.kill("SIGTERM");
      closeTimer = setTimeout(() => {
        if (!closed && sameWorker()) worker.kill("SIGKILL");
      }, RESOURCE_WORKER_CLOSE_TIMEOUT_MS);
    };
    const finish = (next: () => void) => {
      if (outcome) return;
      outcome = next;
      clearTimeout(timeout);
      terminate();
    };
    const timeout = setTimeout(() => finish(() => reject(new Error("resource collector worker timed out"))), RESOURCE_WORKER_TIMEOUT_MS);
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      if (closeTimer) clearTimeout(closeTimer);
      if (outcome) {
        outcome();
        return;
      }
      reject(new Error(`resource collector worker closed before observation (${signal ?? code ?? "unknown"})`));
    });
    let output = "";
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > RESOURCE_WORKER_OUTPUT_MAX_BYTES) {
        finish(() => reject(new Error("resource collector worker exceeded stdout limit")));
        return;
      }
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const raw = output.slice(0, newline);
      output = output.slice(newline + 1);
      let message: ResourceWorkerMessage;
      try {
        message = JSON.parse(raw) as ResourceWorkerMessage;
      } catch {
        finish(() => reject(new Error("resource collector worker emitted invalid JSON")));
        return;
      }
      if (message.type === "failure") {
        finish(() => reject(new Error(message.error)));
        return;
      }
      finish(() => {
        resolve(collectedResources(message.payload, message.diagnostic, message.targets));
      });
    });
    worker.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > RESOURCE_WORKER_OUTPUT_MAX_BYTES) {
        finish(() => reject(new Error("resource collector worker exceeded output limit")));
      }
    });
    worker.stdin.end("{\"type\":\"collect\"}\n");
  });
}

function fallbackRead(
  payload: ResourcesPayload,
  reason: ResourceDegradedReason,
  collectorId: string,
): ResourcesRead {
  const capturedAt = new Date().toISOString();
  return {
    payload,
    diagnostic: {
      fresh: true,
      status: "failed",
      durationMs: 0,
      phases: emptyResourceBuildPhases(),
      generation: 0,
      startedAt: capturedAt,
      completedAt: capturedAt,
      collectorId,
      degradedReason: reason,
    },
  };
}

function resourceReadFromObservation(
  observation: Awaited<ReturnType<ResourceCollector<CollectedResources>["observe"]>>,
  captureSystem: () => ResourcesPayload["system"],
  fresh: boolean,
  collectorId: string,
  persist = false,
): ResourcesRead {
  if (!observation) {
    return fallbackRead({ system: captureSystem(), sessions: [] }, "collector-busy", collectorId);
  }
  const { payload, diagnostic } = observation.value;
  applyResourceTargets(observation.generation, observation.value.targets);
  if (persist && !observation.degradedReason) persistObservation(observation);
  return {
    payload: fresh ? payload : { ...payload, system: captureSystem() },
    diagnostic: {
      ...diagnostic,
      generation: observation.generation,
      startedAt: new Date(observation.startedAt).toISOString(),
      completedAt: new Date(observation.completedAt).toISOString(),
      collectorId: observation.collectorId,
      ...(observation.degradedReason ? { degradedReason: observation.degradedReason } : {}),
    },
  };
}

export function createResourcesReader(
  build: (fresh: boolean) => Promise<ResourcesPayload>,
  captureSystem: () => ResourcesPayload["system"],
  now: () => number = Date.now,
  diagnosticForBuild: () => ResourceBuildDiagnostic | null = lastResourceBuildDiagnostic,
  options: { inProcess?: boolean; initial?: ResourceObservation<CollectedResources> | null; persist?: boolean } = {},
): ResourcesReader {
  const inProcess = options.inProcess ?? process.env.LLV_RESOURCE_COLLECTOR_IN_PROCESS === "1";
  const collectorId = inProcess
    ? `in-process:${process.pid}`
    : `worker:${process.pid}`;
  const collector = createResourceCollector<CollectedResources>({
    collectorId,
    now,
    initial: options.initial,
    collect: inProcess ? async () => {
      const payload = await build(true);
      const diagnostic = diagnosticForBuild();
      if (!diagnostic) throw new Error("resource build completed without diagnostics");
      return collectedResources(payload, diagnostic, lastResourceTargetRefs());
    } : collectResourcesInWorker,
  });

  return {
    async read(fresh = false): Promise<ResourcesRead> {
      const latest = collector.latest();
      if (!fresh && latest) {
        if (now() - latest.completedAt >= CACHE_MS) {
          /* The completed file snapshot remains the response while a bounded
             current scan revalidates in the collector. Its rejection is held
             by the collector, so polling never leaks an unhandled rejection. */
          void collector.observe(collector.fence(), 0);
        }
        return resourceReadFromObservation(latest, captureSystem, false, collectorId, options.persist);
      }
      const fence = collector.fence();
      const observation = await collector.observe(fence, RESOURCE_OBSERVE_TIMEOUT_MS);
      return resourceReadFromObservation(observation, captureSystem, fresh, collectorId, options.persist);
    },
  };
}

function resourcesReader(): ResourcesReader {
  const factory = resourcesReader;
  let reader = globalStore.__llvResourcesReader;
  if (globalStore.__llvResourcesReaderFactory !== factory || !reader) {
    globalStore.__llvResourcesReaderFactory = factory;
    reader = createResourcesReader(
      buildResourceSnapshot,
      () => captureSystemMemory(),
      Date.now,
      lastResourceBuildDiagnostic,
      { initial: persistedObservation(), persist: true },
    );
    globalStore.__llvResourcesReader = reader;
  }
  return reader;
}

export function resetResourcesForTests(): void {
  globalStore.__llvResourcesReader = undefined;
  globalStore.__llvResourcesReaderFactory = undefined;
  globalStore.__llvResourceTargets = undefined;
  globalStore.__llvLastResourceTargets = undefined;
  globalStore.__llvResourceTargetsGeneration = undefined;
  globalStore.__llvLastResourceBuild = undefined;
}

/** Snapshot for GET /api/resources, cached briefly so UI polling stays cheap.
    `fresh` forces a rebuild — used right after a kill so the freed memory and
    the shorter session list show up immediately. */
export async function readResources(fresh = false): Promise<ResourcesPayload> {
  const fixturePath = process.env.LLV_RESOURCES_FIXTURE;
  if (fixturePath) {
    noteSessionTargets([]);
    return parseResourcesFixture(readFileSync(fixturePath, "utf8"));
  }
  return (await resourcesReader().read(fresh)).payload;
}

export async function readResourcesWithDiagnostic(fresh = false): Promise<ResourcesRead> {
  const fixturePath = process.env.LLV_RESOURCES_FIXTURE;
  if (fixturePath) {
    noteSessionTargets([]);
    return fallbackRead(parseResourcesFixture(readFileSync(fixturePath, "utf8")), "collector-busy", "fixture");
  }
  return resourcesReader().read(fresh);
}
