import { procBackend } from "@/lib/proc";
import type { ProcBackend } from "@/lib/proc";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { completedFileScan, currentFileScan } from "@/lib/scanner/scanCache";
import {
  createResourceCollector,
  ResourceCollectorFailureError,
  RESOURCE_FAILURE_STDERR_MAX_BYTES,
  type ResourceCollectorResult,
  type ResourceDegradedReason,
  type ResourceFailureCause,
  type ResourceFailureDiagnostic,
  type ResourceObservation,
} from "@/lib/resourceCollector";
import { descendantPids } from "@/lib/proc/memory";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { readTranscriptHosts, type TranscriptHost, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { agentRegistry } from "@/lib/agent/registry";
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
  cache: ResourceCacheAttribution;
  degradedReason?: ResourceDegradedReason;
  failure?: ResourceFailureDiagnostic;
};

export type ResourceCacheAttribution = Readonly<{
  status: "miss" | "memory" | "durable";
  collectorId?: string;
  generation?: number;
}>;

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
  __llvResourcesReaderVersion?: number;
  __llvResourceTargets?: Map<string, KillTargetRef>;
  __llvLastResourceTargets?: Array<{ target: string; ref: KillTargetRef }>;
  __llvResourceTargetsGeneration?: number;
  __llvResourceTargetEpoch?: number;
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
  rememberResourceTargets([...map].map(([target, ref]) => ({ target, ref })));
}

function rememberResourceTargets(sessions: Iterable<{ target: string; ref: KillTargetRef }>): void {
  globalStore.__llvLastResourceTargets = [...sessions].map(({ target, ref }) => ({ target, ref }));
}

/** Applies a served observation exactly once in generation order. A consumed
    target therefore cannot return through a late observation. */
export function applyResourceTargets(
  generation: number,
  sessions: Iterable<{ target: string; ref: KillTargetRef }>,
  collectionEpoch = globalStore.__llvResourceTargetEpoch ?? 0,
): void {
  if (collectionEpoch !== (globalStore.__llvResourceTargetEpoch ?? 0)) return;
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
  if (globalStore.__llvResourceTargets?.delete(target)) {
    globalStore.__llvResourceTargetEpoch = (globalStore.__llvResourceTargetEpoch ?? 0) + 1;
  }
}

/** The resources rail may list duplicate panes for cleanup. Only the host
    elected by the shared resolver receives the transcript path and its UI
    metadata, keeping observation aligned with path-addressed delivery. */
export function canonicalResourceEntry(
  snapshot: TranscriptHostSnapshot,
  paneHosts: TranscriptHost[],
  entriesByPath: Map<string, ResourceFileObservation>,
): ResourceFileObservation | null {
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
  readFiles(fresh: boolean): Promise<ResourceFileObservation[]>;
  readHosts(fresh: boolean, entries: ResourceFileObservation[], ppids: Map<number, number>): Promise<TranscriptHostSnapshot>;
  proc: Pick<ProcBackend, "systemMemory" | "ppidMap" | "processMemory">;
  captureAttachReferences(refs: ReadonlyArray<Pick<TmuxAttachReference, "tmuxServerPid" | "paneId" | "panePid">>): Map<string, TmuxAttachReference>;
}

const resourceSnapshotDependencies: ResourceSnapshotDependencies = {
  readFiles: readResourceFileSnapshot,
  readHosts: (fresh, entries, ppids) => readTranscriptHosts(fresh, entries as FileEntry[], ppids),
  proc: procBackend,
  captureAttachReferences: captureTmuxAttachReferences,
};

export type ResourceFileObservation = Readonly<Pick<FileEntry,
  "path" | "parent" | "title" | "project" | "activity" | "mtime" | "engine" | "pid" | "proc"
> & { conversationId?: string | null }>;
export type ResourceWorkerFileObservation = ResourceFileObservation & { conversationId: string | null };

export function resourceWorkerFileSnapshot(
  entries: ResourceFileObservation[],
  conversationIdForPath: (pathname: string) => string | null,
): ResourceWorkerFileObservation[] {
  return entries.map((entry) => ({
    path: entry.path,
    parent: entry.parent,
    title: entry.title,
    project: entry.project,
    activity: entry.activity,
    mtime: entry.mtime,
    engine: entry.engine,
    pid: entry.pid,
    proc: entry.proc,
    conversationId: conversationIdForPath(entry.path) ?? entry.conversationId ?? null,
  }));
}

export async function readResourceFileSnapshot(fresh: boolean): Promise<ResourceWorkerFileObservation[]> {
  const scan = fresh ? await currentFileScan({ fresh: true }) : await completedFileScan();
  const registrySnapshot = agentRegistry().snapshot();
  const conversationIdByPath = new Map<string, string>();
  for (const conversation of Object.values(registrySnapshot.conversations)) {
    for (const generation of conversation.generations) conversationIdByPath.set(generation.path, conversation.id);
    for (const pathname of conversation.continuityPaths) conversationIdByPath.set(pathname, conversation.id);
  }
  overlaySessionTitles(scan.snapshot.files);
  return resourceWorkerFileSnapshot(scan.snapshot.files, (pathname) => conversationIdByPath.get(pathname) ?? null);
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
      rememberResourceTargets(killRefs);
    } else {
      rememberResourceTargets([]);
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

export type CollectedResources = {
  payload: ResourcesPayload;
  diagnostic: ResourceBuildDiagnostic;
  hostCount: number;
  treeCount: number;
  targets: Array<{ target: string; ref: KillTargetRef }>;
  targetEpoch?: number;
};

const RESOURCE_OBSERVE_TIMEOUT_MS = 30_000;
const RESOURCE_WORKER_TIMEOUT_MS = 29_500;
const RESOURCE_WORKER_CLOSE_TIMEOUT_MS = 1_000;
const RESOURCE_FILE_HANDOFF_TIMEOUT_MS = 500;
const RESOURCE_WORKER_FRAME_HEADROOM_BYTES = 64 * 1_024;
const RESOURCE_OBSERVATION_SCHEMA_VERSION = 1;
const RESOURCE_OBSERVATION_FILE = "resources-observation.json";
export const RESOURCE_OBSERVATION_MAX_BYTES = 16 * 1024 * 1024;
export const RESOURCE_WORKER_OUTPUT_MAX_BYTES = RESOURCE_OBSERVATION_MAX_BYTES + RESOURCE_WORKER_FRAME_HEADROOM_BYTES;
const RESOURCE_OBSERVATION_MAX_SESSIONS = 10_000;
const RESOURCE_OBSERVATION_MAX_TARGETS = 10_000;
const RESOURCE_READER_VERSION = 2;

type ResourceWorkerLimits = Partial<{
  inputTimeoutMs: number;
  timeoutMs: number;
  closeTimeoutMs: number;
  outputMaxBytes: number;
}>;

type ResourceWorkerLaunchOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  exists?: (pathname: string) => boolean;
};

export function resolveResourceWorkerLaunch(options: ResourceWorkerLaunchOptions = {}): {
  executable: string;
  workerPath: string;
} {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const sourceWorker = path.join(cwd, "src/lib/resourceCollector.worker.ts");
  if (env.LLV_RESOURCE_COLLECTOR_EXECUTABLE) {
    return { executable: env.LLV_RESOURCE_COLLECTOR_EXECUTABLE, workerPath: sourceWorker };
  }
  const bunContainer = "/usr/local/bin/bun-container";
  if (exists(bunContainer)) return { executable: bunContainer, workerPath: sourceWorker };
  const bundledWorker = path.join(cwd, ".next/server/resource-collector-worker.js");
  if (exists(bundledWorker)) {
    return { executable: options.execPath ?? process.execPath, workerPath: bundledWorker };
  }
  return { executable: "bun", workerPath: sourceWorker };
}

function collectedResources(
  payload: ResourcesPayload,
  diagnostic: ResourceBuildDiagnostic,
  targets: Array<{ target: string; ref: KillTargetRef }> = [],
  targetEpoch = globalStore.__llvResourceTargetEpoch ?? 0,
): CollectedResources {
  return {
    payload,
    diagnostic,
    hostCount: payload.sessions.length,
    treeCount: payload.sessions.reduce((total, session) => total + session.procCount, 0),
    targets,
    targetEpoch,
  };
}

type ResourceWorkerMessage =
  | { type: "observation"; payload: ResourcesPayload; diagnostic: ResourceBuildDiagnostic; targets: Array<{ target: string; ref: KillTargetRef }> }
  | { type: "failure"; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validResourceSystem(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || !exactKeys(value, ["ramTotal", "ramAvailable", "swapTotal", "swapUsed", "capturedAt"])) return false;
  return finiteNonNegative(value.ramTotal)
    && finiteNonNegative(value.ramAvailable)
    && finiteNonNegative(value.swapTotal)
    && finiteNonNegative(value.swapUsed)
    && typeof value.capturedAt === "string"
    && Number.isFinite(Date.parse(value.capturedAt));
}

function validResourceSession(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    "target", "panePid", "path", "engine", "title", "project", "activity", "lastActiveAt", "cwd", "rssBytes", "swapBytes", "procCount",
  ], ["hostConflict"])) return false;
  return typeof value.target === "string" && value.target.length > 0
    && Number.isSafeInteger(value.panePid) && (value.panePid as number) > 0
    && nullableString(value.path)
    && (value.engine === "claude" || value.engine === "codex" || value.engine === null)
    && nullableString(value.title)
    && nullableString(value.project)
    && (value.activity === "live" || value.activity === "recent" || value.activity === "stalled" || value.activity === "idle" || value.activity === null)
    && nullableString(value.lastActiveAt)
    && (value.lastActiveAt === null || Number.isFinite(Date.parse(value.lastActiveAt)))
    && nullableString(value.cwd)
    && finiteNonNegative(value.rssBytes)
    && finiteNonNegative(value.swapBytes)
    && Number.isSafeInteger(value.procCount) && (value.procCount as number) >= 0
    && (value.hostConflict === undefined || typeof value.hostConflict === "boolean");
}

function validResourcesPayload(value: unknown): value is ResourcesPayload {
  if (!record(value) || !exactKeys(value, ["system", "sessions"]) || !validResourceSystem(value.system) || !Array.isArray(value.sessions)) return false;
  return value.sessions.length <= RESOURCE_OBSERVATION_MAX_SESSIONS && value.sessions.every(validResourceSession);
}

function validResourceDiagnostic(value: unknown): value is ResourceBuildDiagnostic {
  if (!record(value) || !exactKeys(value, ["fresh", "status", "durationMs", "phases"]) || !record(value.phases)) return false;
  const phases = value.phases;
  const phaseNames: ResourceBuildPhase[] = ["systemMemory", "readFiles", "readHosts", "ppidMap", "processMemory", "attach", "serialization"];
  return typeof value.fresh === "boolean"
    && (value.status === "complete" || value.status === "failed")
    && finiteNonNegative(value.durationMs)
    && exactKeys(phases, phaseNames)
    && phaseNames.every((phase) => finiteNonNegative(phases[phase]));
}

function validKillTargetRef(value: unknown): value is KillTargetRef {
  if (!record(value) || !exactKeys(value, ["tmuxServerPid", "tmuxServerStartIdentity", "paneId", "panePid", "paneStartIdentity"])) return false;
  return Number.isSafeInteger(value.tmuxServerPid) && (value.tmuxServerPid as number) > 0
    && nullableString(value.tmuxServerStartIdentity)
    && typeof value.paneId === "string" && /^%\d+$/.test(value.paneId)
    && Number.isSafeInteger(value.panePid) && (value.panePid as number) > 0
    && nullableString(value.paneStartIdentity);
}

function validResourceTarget(value: unknown): value is { target: string; ref: KillTargetRef } {
  return record(value)
    && exactKeys(value, ["target", "ref"])
    && typeof value.target === "string"
    && value.target.length > 0
    && validKillTargetRef(value.ref);
}

function resourceTargetsMatchPayload(
  payload: ResourcesPayload,
  targets: Array<{ target: string; ref: KillTargetRef }>,
): boolean {
  const sessionsByTarget = new Map<string, ResourceSession>();
  for (const session of payload.sessions) {
    if (sessionsByTarget.has(session.target)) return false;
    sessionsByTarget.set(session.target, session);
  }
  const seen = new Set<string>();
  return targets.every(({ target, ref }) => {
    if (seen.has(target)) return false;
    seen.add(target);
    return sessionsByTarget.get(target)?.panePid === ref.panePid;
  });
}

function validCollectedResources(value: unknown): value is CollectedResources {
  if (!record(value) || !exactKeys(value, ["payload", "diagnostic", "hostCount", "treeCount", "targets"], ["targetEpoch"])
    || !validResourcesPayload(value.payload)
    || !validResourceDiagnostic(value.diagnostic)
    || !Number.isSafeInteger(value.hostCount) || (value.hostCount as number) < 0
    || !Number.isSafeInteger(value.treeCount) || (value.treeCount as number) < 0
    || (value.targetEpoch !== undefined && (!Number.isSafeInteger(value.targetEpoch) || (value.targetEpoch as number) < 0))
    || !Array.isArray(value.targets)
    || value.targets.length > RESOURCE_OBSERVATION_MAX_TARGETS
    || !value.targets.every(validResourceTarget)) return false;
  return value.diagnostic.status === "complete"
    && resourceTargetsMatchPayload(value.payload, value.targets)
    && value.hostCount === value.payload.sessions.length
    && value.treeCount === value.payload.sessions.reduce((total, session) => total + session.procCount, 0);
}

function resourceWorkerMessage(value: unknown): ResourceWorkerMessage | null {
  if (!record(value)) return null;
  const candidate = value;
  if (candidate.type === "failure") {
    return exactKeys(candidate, ["type", "error"])
      && typeof candidate.error === "string"
      && candidate.error.length <= 4_096
      ? candidate as ResourceWorkerMessage
      : null;
  }
  if (candidate.type !== "observation" || !exactKeys(candidate, ["type", "payload", "diagnostic", "targets"])
    || !validResourcesPayload(candidate.payload)
    || !validResourceDiagnostic(candidate.diagnostic)
    || !Array.isArray(candidate.targets)
    || candidate.targets.length > RESOURCE_OBSERVATION_MAX_TARGETS
    || !candidate.targets.every(validResourceTarget)) return null;
  if (candidate.diagnostic.status !== "complete" || !resourceTargetsMatchPayload(candidate.payload, candidate.targets)) return null;
  return candidate as ResourceWorkerMessage;
}

export function parsePersistedResourceObservation(raw: string): ResourceObservation<CollectedResources> | null {
  if (Buffer.byteLength(raw) <= 0 || Buffer.byteLength(raw) > RESOURCE_OBSERVATION_MAX_BYTES) return null;
  try {
    const candidate = JSON.parse(raw) as unknown;
    if (!record(candidate) || !exactKeys(candidate, ["version", "observation"])
      || candidate.version !== RESOURCE_OBSERVATION_SCHEMA_VERSION
      || !record(candidate.observation)) return null;
    const observation = candidate.observation;
    if (!exactKeys(observation, ["generation", "startedAt", "completedAt", "collectorId", "value"], ["degradedReason"])
      || !Number.isSafeInteger(observation.generation) || (observation.generation as number) < 0
      || !finiteNonNegative(observation.startedAt) || !finiteNonNegative(observation.completedAt)
      || observation.completedAt < observation.startedAt
      || typeof observation.collectorId !== "string" || observation.collectorId.length === 0 || observation.collectorId.length > 256
      || (observation.degradedReason !== undefined
        && observation.degradedReason !== "collector-busy"
        && observation.degradedReason !== "timeout"
        && observation.degradedReason !== "collector-crash")
      || !validCollectedResources(observation.value)) return null;
    return observation as ResourceObservation<CollectedResources>;
  } catch {
    return null;
  }
}

function persistedObservation(): ResourceObservation<CollectedResources> | null {
  try {
    const filename = statePath(RESOURCE_OBSERVATION_FILE);
    const size = statSync(filename).size;
    if (size <= 0 || size > RESOURCE_OBSERVATION_MAX_BYTES) return null;
    return parsePersistedResourceObservation(readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
}

function persistObservation(observation: ResourceObservation<CollectedResources>): boolean {
  const filename = statePath(RESOURCE_OBSERVATION_FILE);
  let temporary: string | undefined;
  try {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const serialized = JSON.stringify({ version: RESOURCE_OBSERVATION_SCHEMA_VERSION, observation }) + "\n";
    if (Buffer.byteLength(serialized) > RESOURCE_OBSERVATION_MAX_BYTES) throw new Error("resource observation exceeded durable size limit");
    writeFileSync(temporary, serialized, { mode: 0o600 });
    renameSync(temporary, filename);
    chmodSync(filename, 0o600);
    return true;
  } catch (error) {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* temporary write never completed */ }
    }
    console.error(`[resources] observation persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function validateDurableResourceObservation(observation: ResourceObservation<CollectedResources>): void {
  const serialized = JSON.stringify({ version: RESOURCE_OBSERVATION_SCHEMA_VERSION, observation }) + "\n";
  if (Buffer.byteLength(serialized) > RESOURCE_OBSERVATION_MAX_BYTES) {
    throw new ResourceCollectorFailureError(
      "collector-crash",
      "observation-limit",
      "resource observation exceeded durable size limit",
    );
  }
}

/** One bounded worker owns one observation. Terminating after either outcome
    prevents a crashed or wedged collection from surviving a request timeout. */
async function collectResourcesInWorker(
  fresh: boolean,
  readFiles: (fresh: boolean) => Promise<ResourceWorkerFileObservation[]> = readResourceFileSnapshot,
  limits: ResourceWorkerLimits = {},
  targetEpoch = globalStore.__llvResourceTargetEpoch ?? 0,
): Promise<CollectedResources> {
  const launch = resolveResourceWorkerLaunch();
  const filesTask = readFiles(fresh);
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  const files = await Promise.race([
    filesTask,
    new Promise<ResourceWorkerFileObservation[]>((_, reject) => {
      inputTimer = setTimeout(() => reject(new ResourceCollectorFailureError(
        "timeout",
        "file-handoff-timeout",
        "resource collector file handoff timed out",
      )), limits.inputTimeoutMs ?? RESOURCE_FILE_HANDOFF_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (inputTimer) clearTimeout(inputTimer);
  });
  const request = JSON.stringify({ type: "collect", fresh, files }) + "\n";
  const outputMaxBytes = limits.outputMaxBytes ?? RESOURCE_WORKER_OUTPUT_MAX_BYTES;
  const timeoutMs = limits.timeoutMs ?? RESOURCE_WORKER_TIMEOUT_MS;
  const closeTimeoutMs = limits.closeTimeoutMs ?? RESOURCE_WORKER_CLOSE_TIMEOUT_MS;
  if (Buffer.byteLength(request) > RESOURCE_WORKER_OUTPUT_MAX_BYTES) {
    throw new ResourceCollectorFailureError(
      "collector-crash",
      "worker-input",
      "resource collector input exceeded transport limit",
    );
  }
  const worker = spawn(launch.executable, [launch.workerPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise<CollectedResources>((resolve, reject) => {
    const pid = worker.pid;
    const expectedIdentity = typeof pid === "number" ? procBackend.processIdentity(pid) : null;
    let outcome: (() => void) | null = null;
    let outputBytes = 0;
    let stderrTail = "";
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupStarted = false;
    let leaderExited = false;
    const workerFailure = (
      reason: ResourceDegradedReason,
      cause: ResourceFailureCause,
      message: string,
      error?: unknown,
    ) => new ResourceCollectorFailureError(reason, cause, message, { cause: error, stderr: stderrTail });
    const sameWorker = () => typeof pid === "number"
      && (expectedIdentity === null || procBackend.processIdentity(pid) === expectedIdentity);
    const workerGroupExists = () => {
      if (typeof pid !== "number") return false;
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const signalWorkerGroup = (signal: NodeJS.Signals): boolean => {
      if (typeof pid !== "number") return false;
      if (!leaderExited && !sameWorker()) return false;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH" && !leaderExited) worker.kill(signal);
      }
      return true;
    };
    const terminate = () => {
      if (cleanupStarted || !signalWorkerGroup("SIGTERM")) return;
      cleanupStarted = true;
      closeTimer = setTimeout(() => {
        if (workerGroupExists()) signalWorkerGroup("SIGKILL");
      }, closeTimeoutMs);
    };
    const finish = (next: () => void) => {
      if (outcome) return;
      outcome = next;
      clearTimeout(timeout);
      terminate();
    };
    const timeout = setTimeout(() => finish(() => reject(workerFailure(
      "timeout",
      "worker-timeout",
      "resource collector worker timed out",
    ))), timeoutMs);
    worker.once("error", (error) => finish(() => reject(workerFailure(
      "collector-crash",
      "worker-spawn",
      "resource collector worker failed to start",
      error,
    ))));
    worker.once("exit", () => {
      leaderExited = true;
      clearTimeout(timeout);
      terminate();
    });
    worker.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (!outcome) {
        outcome = () => reject(workerFailure(
          "collector-crash",
          "worker-exit",
          `resource collector worker closed before observation (${signal ?? code ?? "unknown"})`,
        ));
        terminate();
      }
      if (closeTimer && !workerGroupExists()) clearTimeout(closeTimer);
      outcome();
    });
    let output = "";
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > outputMaxBytes) {
        finish(() => reject(workerFailure(
          "collector-crash",
          "worker-output-limit",
          "resource collector worker exceeded stdout limit",
        )));
        return;
      }
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const raw = output.slice(0, newline);
      output = output.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish(() => reject(workerFailure(
          "collector-crash",
          "worker-output-invalid",
          "resource collector worker emitted invalid JSON",
        )));
        return;
      }
      const message = resourceWorkerMessage(parsed);
      if (!message) {
        finish(() => reject(workerFailure(
          "collector-crash",
          "worker-output-invalid",
          "resource collector worker emitted an invalid message",
        )));
        return;
      }
      if (message.type === "observation" && message.diagnostic.fresh !== fresh) {
        finish(() => reject(workerFailure(
          "collector-crash",
          "worker-output-invalid",
          "resource collector worker returned mismatched freshness",
        )));
        return;
      }
      if (message.type === "failure") {
        finish(() => reject(workerFailure(
          "collector-crash",
          "worker-failure",
          "resource collector worker reported a failure",
          new Error(message.error),
        )));
        return;
      }
      finish(() => {
        resolve(collectedResources(message.payload, message.diagnostic, message.targets, targetEpoch));
      });
    });
    worker.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-(RESOURCE_FAILURE_STDERR_MAX_BYTES * 2));
      if (outputBytes > outputMaxBytes) {
        finish(() => reject(workerFailure(
          "collector-crash",
          "worker-output-limit",
          "resource collector worker exceeded output limit",
        )));
      }
    });
    worker.stdin.once("error", (error) => finish(() => reject(workerFailure(
      "collector-crash",
      "worker-input",
      "resource collector worker input failed",
      error,
    ))));
    worker.stdin.end(request);
  });
}

function fixtureRead(payload: ResourcesPayload, fresh: boolean): ResourcesRead {
  const capturedAt = Date.now();
  return {
    payload,
    diagnostic: {
      fresh,
      status: "complete",
      durationMs: 0,
      phases: emptyResourceBuildPhases(),
      generation: 0,
      startedAt: new Date(capturedAt).toISOString(),
      completedAt: new Date(capturedAt).toISOString(),
      collectorId: "fixture",
      cache: { status: "miss" },
    },
  };
}

function resourceCacheAttribution(
  observation: ResourceObservation<CollectedResources> | null,
  collectorId: string,
  servedFromCache: boolean,
): ResourceCacheAttribution {
  if (!observation || !servedFromCache) return { status: "miss" };
  return {
    status: observation.collectorId === collectorId ? "memory" : "durable",
    collectorId: observation.collectorId,
    generation: observation.generation,
  };
}

function resourceReadFromResult(
  result: ResourceCollectorResult<CollectedResources>,
  captureSystem: () => ResourcesPayload["system"],
  fresh: boolean,
  servedFromCache = false,
): ResourcesRead {
  const { observation, failure } = result;
  const cache = resourceCacheAttribution(observation, result.collectorId, servedFromCache || failure !== undefined);
  if (!observation) {
    if (!failure) throw new Error("resource collector returned no observation or failure");
    return {
      payload: { system: captureSystem(), sessions: [] },
      diagnostic: {
        fresh,
        status: "failed",
        durationMs: Math.max(0, result.completedAt - result.startedAt),
        phases: emptyResourceBuildPhases(),
        generation: result.generation,
        startedAt: new Date(result.startedAt).toISOString(),
        completedAt: new Date(result.completedAt).toISOString(),
        collectorId: result.collectorId,
        cache,
        degradedReason: failure.reason,
        failure: failure.diagnostic,
      },
    };
  }
  const { payload, diagnostic } = observation.value;
  if (!failure && observation.collectorId === result.collectorId && observation.value.targetEpoch !== undefined) {
    applyResourceTargets(observation.generation, observation.value.targets, observation.value.targetEpoch);
  }
  if (failure) {
    return {
      payload: fresh ? payload : { ...payload, system: captureSystem() },
      diagnostic: {
        fresh,
        status: "failed",
        durationMs: Math.max(0, result.completedAt - result.startedAt),
        phases: emptyResourceBuildPhases(),
        generation: result.generation,
        startedAt: new Date(result.startedAt).toISOString(),
        completedAt: new Date(result.completedAt).toISOString(),
        collectorId: result.collectorId,
        cache,
        degradedReason: failure.reason,
        failure: failure.diagnostic,
      },
    };
  }
  return {
    payload: fresh ? payload : { ...payload, system: captureSystem() },
    diagnostic: {
      ...diagnostic,
      fresh,
      generation: observation.generation,
      startedAt: new Date(observation.startedAt).toISOString(),
      completedAt: new Date(observation.completedAt).toISOString(),
      collectorId: result.collectorId,
      cache,
    },
  };
}

export function createResourcesReader(
  build: (fresh: boolean) => Promise<ResourcesPayload>,
  captureSystem: () => ResourcesPayload["system"],
  now: () => number = Date.now,
  diagnosticForBuild: () => ResourceBuildDiagnostic | null = lastResourceBuildDiagnostic,
  options: {
    inProcess?: boolean;
    collectorId?: string;
    initial?: ResourceObservation<CollectedResources> | null;
    persist?: (observation: ResourceObservation<CollectedResources>) => boolean;
    readFiles?: (fresh: boolean) => Promise<ResourceWorkerFileObservation[]>;
    workerLimits?: ResourceWorkerLimits;
  } = {},
): ResourcesReader {
  const inProcess = options.inProcess ?? process.env.LLV_RESOURCE_COLLECTOR_IN_PROCESS === "1";
  const collectorId = options.collectorId ?? (inProcess
    ? `in-process:${process.pid}:${crypto.randomUUID()}`
    : `worker:${process.pid}:${crypto.randomUUID()}`);
  const collector = createResourceCollector<CollectedResources, boolean>({
    collectorId,
    now,
    initial: options.initial,
    validateObservation: validateDurableResourceObservation,
    collect: inProcess ? async (fresh = false) => {
      const targetEpoch = globalStore.__llvResourceTargetEpoch ?? 0;
      const payload = await build(fresh);
      const diagnostic = diagnosticForBuild();
      if (!diagnostic) throw new Error("resource build completed without diagnostics");
      return collectedResources(payload, diagnostic, lastResourceTargetRefs(), targetEpoch);
    } : (fresh = false) => collectResourcesInWorker(fresh, options.readFiles, options.workerLimits),
  });
  let lastPersistedGeneration = options.initial?.generation ?? 0;
  const persist = (observation: ResourceObservation<CollectedResources>) => {
    if (observation.degradedReason || observation.generation <= lastPersistedGeneration) return;
    const succeeded = options.persist?.(observation) ?? true;
    if (succeeded) lastPersistedGeneration = observation.generation;
  };
  let freshFlight: Promise<ResourcesRead> | null = null;

  const readOnce = async (fresh: boolean): Promise<ResourcesRead> => {
    const latest = collector.latest();
    if (!fresh && latest) {
      if (now() - latest.completedAt >= CACHE_MS) {
        /* The completed file snapshot remains the response while a bounded
           current scan revalidates in the collector. Its rejection is held
           by the collector, so polling never leaks an unhandled rejection. */
        void collector.observe(latest.generation, 0, false);
      }
      persist(latest);
      return resourceReadFromResult({
        observation: latest,
        generation: latest.generation,
        startedAt: latest.startedAt,
        completedAt: latest.completedAt,
        collectorId,
      }, captureSystem, false, true);
    }
    const fence = fresh ? collector.fence() : -1;
    const result = await collector.observe(fence, RESOURCE_OBSERVE_TIMEOUT_MS, fresh);
    if (result.observation && !result.failure) persist(result.observation);
    return resourceReadFromResult(result, captureSystem, fresh);
  };

  return {
    async read(fresh = false): Promise<ResourcesRead> {
      if (!fresh) return readOnce(false);
      if (freshFlight) return freshFlight;
      const task = readOnce(true);
      freshFlight = task;
      try {
        return await task;
      } finally {
        if (freshFlight === task) freshFlight = null;
      }
    },
  };
}

function resourcesReader(): ResourcesReader {
  let reader = globalStore.__llvResourcesReader;
  if (globalStore.__llvResourcesReaderVersion !== RESOURCE_READER_VERSION || !reader) {
    globalStore.__llvResourcesReaderVersion = RESOURCE_READER_VERSION;
    reader = createResourcesReader(
      buildResourceSnapshot,
      () => captureSystemMemory(),
      Date.now,
      lastResourceBuildDiagnostic,
      { initial: persistedObservation(), persist: persistObservation },
    );
    globalStore.__llvResourcesReader = reader;
  }
  return reader;
}

export function resetResourcesForTests(): void {
  globalStore.__llvResourcesReader = undefined;
  globalStore.__llvResourcesReaderVersion = undefined;
  globalStore.__llvResourceTargets = undefined;
  globalStore.__llvLastResourceTargets = undefined;
  globalStore.__llvResourceTargetsGeneration = undefined;
  globalStore.__llvResourceTargetEpoch = undefined;
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
    return fixtureRead(parseResourcesFixture(readFileSync(fixturePath, "utf8")), fresh);
  }
  return resourcesReader().read(fresh);
}
