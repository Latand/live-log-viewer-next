import { procBackend } from "@/lib/proc";
import type { ProcBackend } from "@/lib/proc";
import crypto from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { completedFileScan, currentResourceFileScan } from "@/lib/scanner/scanCache";
import {
  createResourceCollector,
  createResourceDiagnosticTail,
  ResourceCollectorFailureError,
  type ResourceCollectorResult,
  type ResourceDegradedReason,
  type ResourceFailureCause,
  type ResourceFailureDiagnostic,
  type ResourceObservation,
} from "@/lib/resourceCollector";
import { descendantPids } from "@/lib/proc/memory";
import { overlayResourceSessionTitles } from "@/lib/session/titleProjection";
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

export function resourceDiagnosticHeader(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("resource diagnostic cannot be serialized");
  return json.replace(/[\u007f-\uffff]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

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
  readFiles: async (fresh) => {
    const files = await readResourceFileSnapshot(fresh);
    overlayResourceSessionTitles(files as FileEntry[]);
    return files;
  },
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
  const scan = fresh ? await currentResourceFileScan() : await completedFileScan();
  return resourceWorkerFileSnapshot(scan.snapshot.files, () => null);
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
/** Exact path discovery stays bounded through high-pressure scheduler turns. */
const RESOURCE_FILE_HANDOFF_TIMEOUT_MS = 5_000;
const RESOURCE_WORKER_CLOSE_TIMEOUT_MS = 1_000;
const RESOURCE_OBSERVE_HEADROOM_MS = 500;
const RESOURCE_WORKER_TIMEOUT_MS = RESOURCE_OBSERVE_TIMEOUT_MS
  - RESOURCE_FILE_HANDOFF_TIMEOUT_MS
  - RESOURCE_WORKER_CLOSE_TIMEOUT_MS
  - RESOURCE_OBSERVE_HEADROOM_MS;
const RESOURCE_WORKER_FRAME_HEADROOM_BYTES = 64 * 1_024;
const RESOURCE_OBSERVATION_SCHEMA_VERSION = 1;
const RESOURCE_OBSERVATION_FILE = "resources-observation.json";
export const RESOURCE_OBSERVATION_MAX_BYTES = 16 * 1024 * 1024;
export const RESOURCE_WORKER_OUTPUT_MAX_BYTES = RESOURCE_OBSERVATION_MAX_BYTES + RESOURCE_WORKER_FRAME_HEADROOM_BYTES;
const RESOURCE_WORKER_SUPERVISOR_EXIT_GRACE_MS = 50;
const RESOURCE_WORKER_SUPERVISOR = `
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" });
let finished = false;
let terminationRequested = false;
const finish = (code, signal) => {
  if (finished) return;
  finished = true;
  setTimeout(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  }, terminationRequested
    ? ${RESOURCE_WORKER_SUPERVISOR_EXIT_GRACE_MS}
    : ${Math.ceil(RESOURCE_WORKER_SUPERVISOR_EXIT_GRACE_MS / 2)});
};
child.once("error", () => finish(127, null));
child.once("exit", finish);
process.on("SIGTERM", () => { terminationRequested = true; });
process.on("SIGINT", () => { terminationRequested = true; });
`;
/** The worker runs as PID 1 in a private namespace. Its brief TERM grace lets
    child handlers finish while the kernel retains authority over every fork. */
const RESOURCE_WORKER_PID_NAMESPACE_ENTRYPOINT = `
token="$1"
shift
read host_pid _ < /proc/self/stat
printf '%s %s %s\n' "$token" "$host_pid" "$(readlink /proc/self/ns/pid)"
exec "$@"
`;
const RESOURCE_OBSERVATION_MAX_SESSIONS = 10_000;
const RESOURCE_OBSERVATION_MAX_TARGETS = 10_000;
const RESOURCE_READER_VERSION = 3;

function resourceWorkerExecutableCanBeSupervised(executable: string): boolean {
  try {
    const stat = statSync(executable);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

type ResourceWorkerLimits = Partial<{
  observeTimeoutMs: number;
  inputTimeoutMs: number;
  timeoutMs: number;
  closeTimeoutMs: number;
  cleanupTimeoutMs: number;
  headroomMs: number;
  outputMaxBytes: number;
}>;

type ResourceWorkerNamespaceReference = Readonly<{
  members(): number[] | null;
  close(): void;
}>;

type ResourceWorkerProcessRuntime = Readonly<{
  kernelContainment?: "proven" | "unavailable";
  pidAlive(pid: number): boolean;
  processIdentity(pid: number): string | null;
  processExited?(pid: number): boolean;
  descendants(pid: number): number[];
  processGroupId(pid: number): number | null;
  processGroupMembers(groupId: number): number[];
  namespaceMembers?(owner: string): number[] | null;
  processNamespaceId?(pid: number): string | null;
  processNamespacePid?(pid: number): number | null;
  openNamespaceReference?(pid: number, namespaceId: string): ResourceWorkerNamespaceReference | null;
  signal(pid: number, signal: NodeJS.Signals | 0): void;
}>;

function linuxWorkerDescendants(root: number): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([root]);
  const pending = [root];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    descendants.push(pid);
    let children: string;
    try {
      children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    } catch {
      continue;
    }
    for (const raw of children.trim().split(/\s+/)) {
      const child = Number(raw);
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue;
      seen.add(child);
      pending.push(child);
    }
  }
  return descendants;
}

function workerDescendants(root: number): number[] {
  if (procBackend.name === "linux") return linuxWorkerDescendants(root);
  return descendantPids(root, procBackend.ppidMap());
}

function linuxProcessGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const group = Number(stat.slice(close + 2).trim().split(/\s+/)[2]);
    return Number.isInteger(group) && group > 0 ? group : null;
  } catch {
    return null;
  }
}

function portableProcessGroupId(pid: number): number | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  });
  const group = Number(result.status === 0 ? result.stdout.trim() : "");
  return Number.isInteger(group) && group > 0 ? group : null;
}

function linuxProcessGroupMembers(groupId: number): number[] {
  const members: number[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return members;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (linuxProcessGroupId(pid) === groupId) members.push(pid);
  }
  return members;
}

function portableProcessGroupMembers(groupId: number): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  const members: number[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match && Number(match[2]) === groupId) members.push(Number(match[1]));
  }
  return members;
}

const RESOURCE_WORKER_OWNER_ENV = "LLV_RESOURCE_COLLECTOR_OWNER";

function linuxWorkerNamespaceMembers(owner: string): number[] | null {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return null;
  }
  const marker = `${RESOURCE_WORKER_OWNER_ENV}=${owner}`;
  const members: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let environment: string;
    try {
      environment = readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      continue;
    }
    if (!environment.split("\0").includes(marker)) continue;
    const identity = procBackend.processIdentity(pid);
    if (identity === null) continue;
    try {
      environment = readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      continue;
    }
    if (environment.split("\0").includes(marker)
      && procBackend.processIdentity(pid) === identity) members.push(pid);
  }
  return members;
}

function portableWorkerNamespaceMembers(owner: string): number[] | null {
  const marker = `${RESOURCE_WORKER_OWNER_ENV}=${owner}`;
  const result = spawnSync("ps", ["eww", "-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const members: number[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+/.exec(line);
    if (match && line.includes(marker)) members.push(Number(match[1]));
  }
  return members;
}

function linuxProcessNamespaceId(pid: number): string | null {
  try {
    const namespaceId = readlinkSync(`/proc/${pid}/ns/pid`);
    return /^pid:\[\d+\]$/.test(namespaceId) ? namespaceId : null;
  } catch {
    return null;
  }
}

function linuxProcessNamespacePid(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const line = status.split("\n").find((candidate) => candidate.startsWith("NSpid:"));
    const namespacePid = Number(line?.trim().split(/\s+/).at(-1));
    return Number.isInteger(namespacePid) && namespacePid > 0 ? namespacePid : null;
  } catch {
    return null;
  }
}

function linuxProcessExited(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/, 1)[0];
    return state === "Z" || state === "X" || state === "x";
  } catch {
    return false;
  }
}

function openLinuxProcessNamespaceReference(pid: number, namespaceId: string): ResourceWorkerNamespaceReference | null {
  let fd: number;
  try {
    fd = openSync(`/proc/${pid}/ns/pid`, "r");
  } catch {
    return null;
  }
  try {
    if (readlinkSync(`/proc/self/fd/${fd}`) !== namespaceId) {
      closeSync(fd);
      return null;
    }
    const namespace = fstatSync(fd, { bigint: true });
    let closed = false;
    return {
      members: () => {
        let names: string[];
        try {
          names = readdirSync("/proc");
        } catch {
          return null;
        }
        const members: number[] = [];
        for (const name of names) {
          const member = Number(name);
          if (!Number.isInteger(member) || member <= 0) continue;
          try {
            const candidate = statSync(`/proc/${member}/ns/pid`, { bigint: true });
            if (candidate.dev === namespace.dev && candidate.ino === namespace.ino) members.push(member);
          } catch {
            // Processes may exit between the /proc directory scan and namespace inspection.
          }
        }
        return members;
      },
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  } catch {
    closeSync(fd);
    return null;
  }
}

const defaultResourceWorkerProcessRuntime: ResourceWorkerProcessRuntime = {
  pidAlive: (pid) => procBackend.pidAlive(pid),
  processIdentity: (pid) => procBackend.processIdentity(pid),
  processExited: (pid) => procBackend.name === "linux" && linuxProcessExited(pid),
  descendants: workerDescendants,
  processGroupId: (pid) => procBackend.name === "linux" ? linuxProcessGroupId(pid) : portableProcessGroupId(pid),
  processGroupMembers: (groupId) => procBackend.name === "linux"
    ? linuxProcessGroupMembers(groupId)
    : portableProcessGroupMembers(groupId),
  namespaceMembers: (owner) => procBackend.name === "linux"
    ? linuxWorkerNamespaceMembers(owner)
    : portableWorkerNamespaceMembers(owner),
  processNamespaceId: (pid) => procBackend.name === "linux" ? linuxProcessNamespaceId(pid) : null,
  processNamespacePid: (pid) => procBackend.name === "linux" ? linuxProcessNamespacePid(pid) : null,
  openNamespaceReference: (pid, namespaceId) => procBackend.name === "linux"
    ? openLinuxProcessNamespaceReference(pid, namespaceId)
    : null,
  signal: (pid, signal) => process.kill(pid, signal),
};

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
  const bundledWorker = path.join(cwd, ".next/server/resource-collector-worker.js");
  const sourceWorkerExists = exists(sourceWorker);
  const bundledWorkerExists = exists(bundledWorker);
  const availableWorker = sourceWorkerExists || !bundledWorkerExists ? sourceWorker : bundledWorker;
  if (env.LLV_RESOURCE_COLLECTOR_EXECUTABLE) {
    return {
      executable: env.LLV_RESOURCE_COLLECTOR_EXECUTABLE,
      workerPath: bundledWorkerExists ? bundledWorker : availableWorker,
    };
  }
  const bunContainer = "/usr/local/bin/bun-container";
  if (sourceWorkerExists && exists(bunContainer)) return { executable: bunContainer, workerPath: sourceWorker };
  if (bundledWorkerExists) {
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
  processRuntime: ResourceWorkerProcessRuntime = defaultResourceWorkerProcessRuntime,
): Promise<CollectedResources> {
  const launch = resolveResourceWorkerLaunch();
  const observeTimeoutMs = limits.observeTimeoutMs ?? RESOURCE_OBSERVE_TIMEOUT_MS;
  const inputTimeoutMs = limits.inputTimeoutMs ?? RESOURCE_FILE_HANDOFF_TIMEOUT_MS;
  const closeTimeoutMs = limits.closeTimeoutMs ?? RESOURCE_WORKER_CLOSE_TIMEOUT_MS;
  const memberCleanupPhaseMs = Math.max(0, Math.min(100, Math.floor(closeTimeoutMs * 0.75)));
  const headroomMs = limits.headroomMs ?? RESOURCE_OBSERVE_HEADROOM_MS;
  const cleanupAbsenceConfirmationMs = Math.min(25, Math.max(5, closeTimeoutMs));
  const cleanupTimeoutMs = Math.max(
    closeTimeoutMs + cleanupAbsenceConfirmationMs + 5,
    limits.cleanupTimeoutMs ?? closeTimeoutMs + Math.floor(headroomMs / 2),
  );
  const successCleanupTimeoutMs = Math.max(
    cleanupTimeoutMs,
    closeTimeoutMs + cleanupAbsenceConfirmationMs + RESOURCE_WORKER_SUPERVISOR_EXIT_GRACE_MS,
  );
  const settlementHeadroomMs = Math.max(
    Math.min(250, Math.ceil(observeTimeoutMs * 0.2)),
    RESOURCE_WORKER_SUPERVISOR_EXIT_GRACE_MS + cleanupAbsenceConfirmationMs + Math.max(
      0,
      headroomMs - Math.max(0, successCleanupTimeoutMs - closeTimeoutMs),
    ),
  );
  const workerBudgetMs = Math.max(
    0,
    observeTimeoutMs - inputTimeoutMs - successCleanupTimeoutMs - settlementHeadroomMs,
  );
  const timeoutMs = Math.min(limits.timeoutMs ?? RESOURCE_WORKER_TIMEOUT_MS, workerBudgetMs);
  const filesTask = readFiles(fresh);
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  const files = await Promise.race([
    filesTask,
    new Promise<ResourceWorkerFileObservation[]>((_, reject) => {
      inputTimer = setTimeout(() => reject(new ResourceCollectorFailureError(
        "timeout",
        "file-handoff-timeout",
        "resource collector file handoff timed out",
      )), inputTimeoutMs);
    }),
  ]).finally(() => {
    if (inputTimer) clearTimeout(inputTimer);
  });
  const request = JSON.stringify({ type: "collect", fresh, files }) + "\n";
  const outputMaxBytes = limits.outputMaxBytes ?? RESOURCE_WORKER_OUTPUT_MAX_BYTES;
  if (Buffer.byteLength(request) > RESOURCE_WORKER_OUTPUT_MAX_BYTES) {
    throw new ResourceCollectorFailureError(
      "collector-crash",
      "worker-input",
      "resource collector input exceeded transport limit",
    );
  }
  const superviseWorker = processRuntime === defaultResourceWorkerProcessRuntime
    && resourceWorkerExecutableCanBeSupervised(launch.executable);
  const workerOwner = crypto.randomUUID();
  const workerExecutable = superviseWorker ? process.execPath : launch.executable;
  const workerArguments = superviseWorker
    ? ["-e", RESOURCE_WORKER_SUPERVISOR, launch.executable, launch.workerPath]
    : [launch.workerPath];
  const namespaceExecutable = ["/usr/bin/unshare", "/bin/unshare"].find(existsSync);
  const invalidAbsoluteExecutable = launch.executable.includes(path.sep)
    && !resourceWorkerExecutableCanBeSupervised(launch.executable);
  const containmentRequested = processRuntime === defaultResourceWorkerProcessRuntime
    && process.platform === "linux"
    && namespaceExecutable !== undefined
    && !invalidAbsoluteExecutable;
  const containmentToken = crypto.randomUUID();
  const worker = spawn(
    containmentRequested ? namespaceExecutable : workerExecutable,
    containmentRequested
      ? [
          "--user",
          "--map-root-user",
          "--pid",
          "--fork",
          "/bin/sh",
          "-c",
          RESOURCE_WORKER_PID_NAMESPACE_ENTRYPOINT,
          "llv-resource-worker",
          containmentToken,
          workerExecutable,
          ...workerArguments,
        ]
      : workerArguments,
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, [RESOURCE_WORKER_OWNER_ENV]: workerOwner },
    },
  );
  return new Promise<CollectedResources>((resolve, reject) => {
    const pid = worker.pid;
    const expectedIdentity = typeof pid === "number" ? processRuntime.processIdentity(pid) : null;
    const groupEstablished = typeof pid === "number"
      && expectedIdentity !== null
      && processRuntime.processGroupId(pid) === pid
      && processRuntime.processIdentity(pid) === expectedIdentity;
    type WorkerOutcome =
      | { type: "success"; value: CollectedResources }
      | {
          type: "failure";
          reason: ResourceDegradedReason;
          cause: ResourceFailureCause;
          message: string;
          error?: unknown;
        };
    let outcome: WorkerOutcome | null = null;
    let exitFailure: Extract<WorkerOutcome, { type: "failure" }> | null = null;
    let outputBytes = 0;
    const stderrTail = createResourceDiagnosticTail();
    const stderrDecoder = new StringDecoder("utf8");
    const ownedProcesses = new Map<number, string>();
    if (typeof pid === "number" && expectedIdentity !== null) ownedProcesses.set(pid, expectedIdentity);
    const ownershipTimers: Array<ReturnType<typeof setTimeout>> = [];
    let rootCleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupPoll: ReturnType<typeof setTimeout> | undefined;
    let cleanupAbsentSince: number | null = null;
    let cleanupStarted = false;
    let cleanupComplete = false;
    let cleanupIssue: unknown;
    let cleanupFailure: Error | null = null;
    let cleanupVerificationFailed = false;
    let namespaceScanComplete = processRuntime.namespaceMembers === undefined;
    let containmentNamespaceId: string | null = null;
    let containmentRootPid: number | null = null;
    let containmentRootIdentity: string | null = null;
    let containmentReference: ResourceWorkerNamespaceReference | null = null;
    let containmentRootRetired = false;
    const injectedContainmentProven = processRuntime !== defaultResourceWorkerProcessRuntime
      && processRuntime.kernelContainment !== "unavailable";
    let containmentScanComplete = injectedContainmentProven;
    let containmentMembershipEmpty = injectedContainmentProven;
    let containmentProven = injectedContainmentProven;
    let groupContinuityLost = false;
    let groupSignalSent = false;
    let leaderExited = false;
    let workerClosed = false;
    let streamsDetached = false;
    let stderrEnded = false;
    let settled = false;
    const workerFailure = (
      reason: ResourceDegradedReason,
      cause: ResourceFailureCause,
      message: string,
      error?: unknown,
    ) => new ResourceCollectorFailureError(reason, cause, message, {
      cause: error,
      stderr: stderrTail.value(),
      secondaryCauses: cleanupFailure ? [cleanupFailure] : [],
    });
    const rememberCleanupIssue = (error: unknown) => {
      cleanupIssue ??= error;
    };
    const failCleanupVerification = (message: string) => {
      cleanupVerificationFailed = true;
      rememberCleanupIssue(new Error(message));
    };
    const processExitVerified = (ownedPid: number, identity: string): boolean => {
      const currentIdentity = processRuntime.processIdentity(ownedPid);
      if (currentIdentity === null) return !processRuntime.pidAlive(ownedPid);
      if (currentIdentity !== identity || !processRuntime.processExited?.(ownedPid)) return false;
      const confirmedIdentity = processRuntime.processIdentity(ownedPid);
      return confirmedIdentity === currentIdentity
        || (confirmedIdentity === null && !processRuntime.pidAlive(ownedPid));
    };
    const finishStderr = () => {
      if (stderrEnded) return;
      stderrEnded = true;
      stderrTail.append(stderrDecoder.end());
    };
    const clearOwnershipTimers = () => {
      for (const timer of ownershipTimers) clearTimeout(timer);
      ownershipTimers.length = 0;
    };
    const retainLiveContainmentMembers = (): boolean => {
      if (!containmentProven || containmentNamespaceId === null || containmentReference === null) {
        return false;
      }
      let members: number[] | null;
      try {
        if (!containmentRootRetired && containmentRootPid !== null && containmentRootIdentity !== null) {
          const currentRootIdentity = processRuntime.processIdentity(containmentRootPid);
          if (currentRootIdentity === containmentRootIdentity) {
            if (processExitVerified(containmentRootPid, containmentRootIdentity)) {
              containmentRootRetired = true;
            } else {
              const namespaceId = processRuntime.processNamespaceId?.(containmentRootPid);
              const namespacePid = processRuntime.processNamespacePid?.(containmentRootPid);
              const confirmedIdentity = processRuntime.processIdentity(containmentRootPid);
              if (confirmedIdentity !== currentRootIdentity) containmentRootRetired = true;
              else if (namespaceId !== containmentNamespaceId || namespacePid !== 1) {
                failCleanupVerification("resource collector PID namespace root identity changed");
              }
            }
          } else if (currentRootIdentity !== null) {
            containmentRootRetired = true;
            failCleanupVerification("resource collector PID namespace root identity was recycled");
          } else if (!processRuntime.pidAlive(containmentRootPid)) {
            containmentRootRetired = true;
          }
        }
        members = containmentReference.members();
      } catch (error) {
        containmentScanComplete = false;
        containmentMembershipEmpty = false;
        rememberCleanupIssue(error);
        return false;
      }
      containmentScanComplete = members !== null;
      containmentMembershipEmpty = members?.length === 0;
      if (members === null) {
        rememberCleanupIssue(new Error("resource collector PID namespace could not be inspected"));
        return false;
      }
      let discovered = false;
      for (const member of members) {
        const identity = processRuntime.processIdentity(member);
        if (identity === null
          || processRuntime.processNamespaceId?.(member) !== containmentNamespaceId
          || processRuntime.processIdentity(member) !== identity) continue;
        const prior = ownedProcesses.get(member);
        if (prior !== undefined && prior !== identity) {
          failCleanupVerification("resource collector PID namespace member identity was recycled");
          continue;
        }
        if (prior === undefined) {
          ownedProcesses.set(member, identity);
          discovered = true;
        }
      }
      return discovered;
    };
    const retainLiveGroupMembers = () => {
      if (containmentNamespaceId !== null || !groupEstablished || groupContinuityLost || groupSignalSent || leaderExited
        || typeof pid !== "number" || expectedIdentity === null) return;
      if (processRuntime.processIdentity(pid) !== expectedIdentity) {
        groupContinuityLost = true;
        failCleanupVerification("resource collector worker group leader identity changed");
        return;
      }
      let members: number[];
      try {
        members = processRuntime.processGroupMembers(pid);
      } catch (error) {
        groupContinuityLost = true;
        failCleanupVerification("resource collector worker group membership could not be inspected");
        rememberCleanupIssue(error);
        return;
      }
      if (!members.includes(pid)) {
        groupContinuityLost = true;
        failCleanupVerification("resource collector worker group continuity was lost");
        return;
      }
      const observed: Array<readonly [number, string]> = [];
      for (const member of members) {
        const identity = processRuntime.processIdentity(member);
        if (identity === null || processRuntime.processGroupId(member) !== pid
          || processRuntime.processIdentity(member) !== identity) {
          continue;
        }
        observed.push([member, identity]);
      }
      if (processRuntime.processIdentity(pid) !== expectedIdentity) {
        groupContinuityLost = true;
        failCleanupVerification("resource collector worker group leader identity changed");
        return;
      }
      for (const [member, identity] of observed) {
        const prior = ownedProcesses.get(member);
        if (prior !== undefined && prior !== identity) {
          groupContinuityLost = true;
          failCleanupVerification("resource collector worker group member identity changed");
          return;
        }
        ownedProcesses.set(member, identity);
      }
    };
    const retainLiveNamespaceMembers = (): boolean => {
      if (!processRuntime.namespaceMembers) return false;
      let members: number[] | null;
      try {
        members = processRuntime.namespaceMembers(workerOwner);
      } catch (error) {
        namespaceScanComplete = false;
        rememberCleanupIssue(error);
        return false;
      }
      namespaceScanComplete = members !== null;
      if (members === null) {
        rememberCleanupIssue(new Error("resource collector worker namespace could not be inspected"));
        return false;
      }
      let discovered = false;
      for (const member of members) {
        const identity = processRuntime.processIdentity(member);
        if (identity === null || processRuntime.processIdentity(member) !== identity) continue;
        const prior = ownedProcesses.get(member);
        if (prior !== undefined && prior !== identity) {
          failCleanupVerification("resource collector namespace member identity was recycled");
          continue;
        }
        if (prior === undefined) {
          ownedProcesses.set(member, identity);
          discovered = true;
        }
      }
      return discovered;
    };
    const refreshOwnedProcesses = (includeNamespace = true): boolean => {
      let discovered = false;
      const pending = [...ownedProcesses.keys()];
      const inspected = new Set<number>();
      while (pending.length > 0) {
        const root = pending.pop()!;
        if (inspected.has(root)) continue;
        inspected.add(root);
        const rootIdentity = ownedProcesses.get(root);
        if (rootIdentity === undefined || processRuntime.processIdentity(root) !== rootIdentity) continue;
        let descendants: number[];
        try {
          descendants = processRuntime.descendants(root);
        } catch (error) {
          rememberCleanupIssue(error);
          continue;
        }
        if (processRuntime.processIdentity(root) !== rootIdentity) continue;
        for (const descendant of descendants) {
          if (descendant === root) continue;
          const identity = processRuntime.processIdentity(descendant);
          if (identity === null
            || processRuntime.processIdentity(root) !== rootIdentity
            || processRuntime.processIdentity(descendant) !== identity) continue;
          const prior = ownedProcesses.get(descendant);
          if (prior !== undefined && prior !== identity) {
            failCleanupVerification("resource collector descendant identity was recycled");
            continue;
          }
          if (prior === undefined) {
            ownedProcesses.set(descendant, identity);
            discovered = true;
          }
          pending.push(descendant);
        }
      }
      retainLiveGroupMembers();
      const containmentDiscovered = retainLiveContainmentMembers();
      const namespaceDiscovered = includeNamespace && containmentNamespaceId === null
        ? retainLiveNamespaceMembers()
        : false;
      return namespaceDiscovered || containmentDiscovered || discovered;
    };
    const ownedProcessState = () => {
      const active: number[] = [];
      let uncertain = false;
      for (const [ownedPid, identity] of ownedProcesses) {
        const currentIdentity = processRuntime.processIdentity(ownedPid);
        if (currentIdentity === identity) {
          if (processExitVerified(ownedPid, identity)) continue;
          const confirmedIdentity = processRuntime.processIdentity(ownedPid);
          if (confirmedIdentity === identity) active.push(ownedPid);
          else if (confirmedIdentity === null && processRuntime.pidAlive(ownedPid)) uncertain = true;
          else if (confirmedIdentity !== null && containmentNamespaceId !== null) {
            failCleanupVerification("resource collector contained process identity was recycled");
          }
          continue;
        }
        if (currentIdentity === null && processRuntime.pidAlive(ownedPid)) uncertain = true;
        else if (currentIdentity !== null && containmentNamespaceId !== null) {
          failCleanupVerification("resource collector contained process identity was recycled");
        }
      }
      return { active, uncertain };
    };
    const probeWorkerGroup = (): "absent" | "present" | "denied" | "unknown" => {
      if (typeof pid !== "number") return "absent";
      try {
        processRuntime.signal(-pid, 0);
        return "present";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          if (!groupSignalSent) groupContinuityLost = true;
          return "absent";
        }
        if (code === "EPERM") return "denied";
        rememberCleanupIssue(error);
        return "unknown";
      }
    };
    const workerGroupOwned = (): boolean => {
      if (!groupEstablished || groupContinuityLost || typeof pid !== "number" || expectedIdentity === null) return false;
      for (const [member, identity] of ownedProcesses) {
        if (processRuntime.processIdentity(member) === identity
          && processRuntime.processGroupId(member) === pid
          && processRuntime.processIdentity(member) === identity) return true;
      }
      return false;
    };
    const signalOwnedCleanup = (
      signal: NodeJS.Signals,
      includeNamespace = true,
      containmentPhase: "members" | "root" | "all" = "all",
    ) => {
      refreshOwnedProcesses(includeNamespace);
      if (containmentNamespaceId !== null && containmentRootPid !== null && containmentRootIdentity !== null) {
        const containmentMembers = ownedProcessState().active.filter((ownedPid) => ownedPid !== containmentRootPid
          && processRuntime.processNamespaceId?.(ownedPid) === containmentNamespaceId);
        const containmentMemberSet = new Set(containmentMembers);
        let containmentTargets = signal === "SIGTERM" ? containmentMembers : [];
        if (signal === "SIGTERM" && containmentPhase === "members") {
          containmentTargets = containmentMembers.filter((ownedPid) => {
            const identity = ownedProcesses.get(ownedPid);
            if (identity === undefined || processRuntime.processIdentity(ownedPid) !== identity) return false;
            let descendants: number[];
            try {
              descendants = processRuntime.descendants(ownedPid);
            } catch (error) {
              rememberCleanupIssue(error);
              return false;
            }
            if (processRuntime.processIdentity(ownedPid) !== identity) return false;
            return !descendants.some((descendant) => descendant !== ownedPid
              && containmentMemberSet.has(descendant));
          });
        }
        for (const ownedPid of containmentTargets) {
          const identity = ownedProcesses.get(ownedPid);
          if (identity === undefined) continue;
          const currentIdentity = processRuntime.processIdentity(ownedPid);
          if (currentIdentity === null) continue;
          if (currentIdentity !== identity
            || processRuntime.processNamespaceId?.(ownedPid) !== containmentNamespaceId
            || processRuntime.processIdentity(ownedPid) !== currentIdentity) {
            failCleanupVerification("resource collector PID namespace member identity changed before cleanup");
            continue;
          }
          try {
            processRuntime.signal(ownedPid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") rememberCleanupIssue(error);
          }
        }
        if (containmentPhase === "members") return;
        const signalWorkerWrapper = () => {
          if (typeof pid !== "number" || expectedIdentity === null || pid === containmentRootPid) return;
          const wrapperIdentity = processRuntime.processIdentity(pid);
          if (wrapperIdentity === null) return;
          if (wrapperIdentity !== expectedIdentity || processRuntime.processIdentity(pid) !== wrapperIdentity) {
            failCleanupVerification("resource collector worker wrapper identity changed before cleanup");
            return;
          }
          if (processExitVerified(pid, expectedIdentity)) return;
          try {
            processRuntime.signal(pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") rememberCleanupIssue(error);
          }
        };
        if (containmentRootRetired) {
          signalWorkerWrapper();
          return;
        }
        const currentIdentity = processRuntime.processIdentity(containmentRootPid);
        if (currentIdentity === null) {
          if (!processRuntime.pidAlive(containmentRootPid)) containmentRootRetired = true;
          signalWorkerWrapper();
          return;
        }
        if (processExitVerified(containmentRootPid, containmentRootIdentity)) {
          containmentRootRetired = true;
          signalWorkerWrapper();
          return;
        }
        if (currentIdentity !== containmentRootIdentity) {
          containmentRootRetired = true;
          failCleanupVerification("resource collector PID namespace root identity changed before cleanup");
          signalWorkerWrapper();
          return;
        }
        if (processRuntime.processNamespaceId?.(containmentRootPid) !== containmentNamespaceId
          || processRuntime.processNamespacePid?.(containmentRootPid) !== 1
          || processRuntime.processIdentity(containmentRootPid) !== currentIdentity) {
          failCleanupVerification("resource collector PID namespace root identity changed before cleanup");
          signalWorkerWrapper();
          return;
        }
        try {
          processRuntime.signal(containmentRootPid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") rememberCleanupIssue(error);
        }
        signalWorkerWrapper();
        return;
      }
      const state = ownedProcessState();
      const group = probeWorkerGroup();
      if (group === "present") {
        if (workerGroupOwned()) {
          try {
            processRuntime.signal(-pid!, signal);
            groupSignalSent = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") rememberCleanupIssue(error);
          }
        } else {
          if (groupSignalSent) {
            rememberCleanupIssue(new Error("resource collector worker group ownership could not be verified"));
          } else {
            failCleanupVerification("resource collector worker group ownership could not be verified");
          }
        }
      }
      for (const ownedPid of state.active) {
        const identity = ownedProcesses.get(ownedPid);
        if (identity === undefined || processRuntime.processIdentity(ownedPid) !== identity) {
          if (!groupSignalSent) {
            failCleanupVerification("resource collector worker identity changed before individual cleanup");
          }
          continue;
        }
        try {
          processRuntime.signal(ownedPid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") rememberCleanupIssue(error);
        }
      }
    };
    const cleanupIsAbsent = (): boolean => {
      const state = ownedProcessState();
      const wrapperExited = typeof pid === "number" && expectedIdentity !== null
        && processExitVerified(pid, expectedIdentity);
      let group = probeWorkerGroup();
      if (containmentNamespaceId !== null
        && containmentMembershipEmpty
        && wrapperExited
        && group === "present") {
        group = "absent";
      }
      const processChecksAbsent = namespaceScanComplete
        && group === "absent"
        && state.active.length === 0
        && !state.uncertain;
      const absent = processChecksAbsent && containmentScanComplete && containmentMembershipEmpty;
      if (processChecksAbsent && !containmentProven && cleanupFailure === null) {
        cleanupVerificationFailed = true;
        cleanupFailure = new Error("resource collector kernel containment could not be established");
        return true;
      }
      if (absent && cleanupVerificationFailed && cleanupFailure === null) {
        cleanupFailure = new Error(
          "resource collector worker cleanup ownership verification failed",
          cleanupIssue === undefined ? undefined : { cause: cleanupIssue },
        );
      }
      return absent;
    };
    const releaseWorkerHandles = () => {
      if (streamsDetached) return;
      streamsDetached = true;
      try {
        containmentReference?.close();
      } catch (error) {
        rememberCleanupIssue(error);
        cleanupFailure ??= new Error("resource collector PID namespace reference could not be closed", { cause: error });
      }
      containmentReference = null;
      finishStderr();
      worker.removeAllListeners();
      for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
        stream.removeAllListeners();
        stream.destroy();
        (stream as typeof stream & { unref?: () => void }).unref?.();
      }
      worker.unref();
    };
    const acceptContainmentHandshake = (line: string): boolean => {
      if (!containmentRequested || !line.startsWith(`${containmentToken} `)) return false;
      const [token, rawRootPid, namespaceId, ...extra] = line.split(" ");
      const rootPid = Number(rawRootPid);
      if (line.length > 512 || token !== containmentToken || !Number.isInteger(rootPid) || rootPid <= 0
        || !/^pid:\[\d+\]$/.test(namespaceId) || extra.length > 0
        || !processRuntime.openNamespaceReference || !processRuntime.processNamespaceId
        || !processRuntime.processNamespacePid) {
        failCleanupVerification("resource collector PID namespace handshake was invalid");
        return true;
      }
      const rootIdentity = processRuntime.processIdentity(rootPid);
      const liveRootIsValid = rootIdentity !== null
        && processRuntime.processNamespaceId(rootPid) === namespaceId
        && processRuntime.processNamespacePid(rootPid) === 1
        && processRuntime.processIdentity(rootPid) === rootIdentity;
      const reference = liveRootIsValid
        ? processRuntime.openNamespaceReference(rootPid, namespaceId)
        : null;
      const liveRootRemainsValid = reference !== null
        && processRuntime.processIdentity(rootPid) === rootIdentity
        && processRuntime.processNamespaceId(rootPid) === namespaceId
        && processRuntime.processNamespacePid(rootPid) === 1
        && processRuntime.processIdentity(rootPid) === rootIdentity;
      if (!liveRootRemainsValid) {
        reference?.close();
        failCleanupVerification("resource collector PID namespace root could not be verified");
        return true;
      }
      containmentNamespaceId = namespaceId;
      containmentRootPid = rootPid;
      containmentRootIdentity = rootIdentity;
      containmentReference = reference;
      containmentProven = true;
      containmentScanComplete = false;
      containmentMembershipEmpty = false;
      namespaceScanComplete = true;
      retainLiveContainmentMembers();
      return true;
    };
    if (!containmentRequested && !containmentProven) {
      failCleanupVerification("resource collector kernel containment is unavailable");
    }
    const clearLifecycleTimers = () => {
      clearTimeout(workerTimer);
      if (rootCleanupTimer) clearTimeout(rootCleanupTimer);
      if (killTimer) clearTimeout(killTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (cleanupPoll) clearTimeout(cleanupPoll);
      clearOwnershipTimers();
    };
    const settleIfReady = () => {
      if (settled || !outcome || (!workerClosed && !streamsDetached) || !cleanupComplete) return;
      settled = true;
      const completed = outcome;
      clearLifecycleTimers();
      releaseWorkerHandles();
      if (cleanupFailure) {
        if (completed.type === "success") {
          reject(workerFailure(
            "collector-crash",
            "worker-cleanup",
            "resource collector worker cleanup failed",
          ));
        } else {
          reject(workerFailure(
            completed.reason,
            completed.cause,
            completed.message,
            completed.error,
          ));
        }
        return;
      }
      if (completed.type === "success") resolve(completed.value);
      else reject(workerFailure(completed.reason, completed.cause, completed.message, completed.error));
    };
    const confirmCleanup = () => {
      if (!cleanupStarted || cleanupComplete) return;
      if (refreshOwnedProcesses()) cleanupAbsentSince = null;
      const absent = cleanupIsAbsent();
      if (!absent) cleanupAbsentSince = null;
      else if (cleanupAbsentSince === null) cleanupAbsentSince = Date.now();
      if (absent && Date.now() - cleanupAbsentSince! >= cleanupAbsenceConfirmationMs) {
        cleanupComplete = true;
        if (killTimer) clearTimeout(killTimer);
        if (cleanupPoll) clearTimeout(cleanupPoll);
        settleIfReady();
        return;
      }
      cleanupPoll = setTimeout(confirmCleanup, 5);
      cleanupPoll.unref();
    };
    const terminate = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      clearOwnershipTimers();
      const cleanupDeadlineMs = outcome?.type === "success" ? successCleanupTimeoutMs : cleanupTimeoutMs;
      cleanupDeadlineTimer = setTimeout(() => {
        refreshOwnedProcesses();
        const absentAtDeadline = cleanupIsAbsent();
        if (absentAtDeadline && cleanupIssue === undefined) {
          cleanupComplete = true;
          releaseWorkerHandles();
          settleIfReady();
          return;
        }
        if (!outcome && exitFailure) outcome = exitFailure;
        cleanupFailure = new Error(
          "resource collector worker cleanup deadline expired",
          cleanupIssue === undefined ? undefined : { cause: cleanupIssue },
        );
        cleanupComplete = true;
        releaseWorkerHandles();
        settleIfReady();
      }, cleanupDeadlineMs);
      cleanupDeadlineTimer.unref();
      if (containmentNamespaceId === null) {
        signalOwnedCleanup("SIGTERM", false);
      } else {
        signalOwnedCleanup("SIGTERM", false, "members");
        rootCleanupTimer = setTimeout(() => {
          if (cleanupComplete) return;
          signalOwnedCleanup("SIGTERM", false, "root");
          confirmCleanup();
        }, memberCleanupPhaseMs);
        rootCleanupTimer.unref();
      }
      killTimer = setTimeout(() => {
        signalOwnedCleanup("SIGKILL");
        confirmCleanup();
      }, closeTimeoutMs);
      killTimer.unref();
      confirmCleanup();
    };
    const finish = (next: WorkerOutcome) => {
      if (outcome) {
        if (outcome.type === "success" && next.type === "failure" && next.cause === "worker-output-limit") {
          outcome = next;
        }
        return;
      }
      outcome = next;
      clearTimeout(workerTimer);
      terminate();
    };
    refreshOwnedProcesses();
    for (const delay of [0, 5, 20, 40]) {
      const timer = setTimeout(() => {
        if (!cleanupStarted && !leaderExited) refreshOwnedProcesses();
      }, delay);
      timer.unref();
      ownershipTimers.push(timer);
    }
    const workerTimer = setTimeout(() => finish({
      type: "failure",
      reason: "timeout",
      cause: "worker-timeout",
      message: "resource collector worker timed out",
    }), timeoutMs);
    const onWorkerError = (error: Error) => {
      if (typeof pid !== "number") {
        containmentProven = true;
        containmentScanComplete = true;
        containmentMembershipEmpty = true;
        namespaceScanComplete = true;
      }
      finish({
        type: "failure",
        reason: "collector-crash",
        cause: "worker-spawn",
        message: "resource collector worker failed to start",
        error,
      });
    };
    const onWorkerExit = (code: number | null, signal: NodeJS.Signals | null) => {
      leaderExited = true;
      clearOwnershipTimers();
      clearTimeout(workerTimer);
      exitFailure = {
        type: "failure",
        reason: "collector-crash",
        cause: "worker-exit",
        message: `resource collector worker exited before observation (${signal ?? code ?? "unknown"})`,
      };
      terminate();
    };
    const onWorkerClose = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(workerTimer);
      finishStderr();
      workerClosed = true;
      if (!outcome) {
        outcome = exitFailure ?? {
          type: "failure",
          reason: "collector-crash",
          cause: "worker-exit",
          message: `resource collector worker closed before observation (${signal ?? code ?? "unknown"})`,
        };
        terminate();
      }
      confirmCleanup();
      settleIfReady();
    };
    worker.once("error", onWorkerError);
    worker.once("exit", onWorkerExit);
    worker.once("close", onWorkerClose);
    let output = "";
    worker.stdout.setEncoding("utf8");
    const onStdout = (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > outputMaxBytes + (containmentRequested && !containmentProven ? 512 : 0)) {
        finish({
          type: "failure",
          reason: "collector-crash",
          cause: "worker-output-limit",
          message: "resource collector worker exceeded stdout limit",
        });
        return;
      }
      if (outcome) return;
      output += chunk;
      while (!outcome) {
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        const raw = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (acceptContainmentHandshake(raw)) {
          outputBytes -= Buffer.byteLength(raw) + 1;
          if (outputBytes > outputMaxBytes) {
            finish({
              type: "failure",
              reason: "collector-crash",
              cause: "worker-output-limit",
              message: "resource collector worker exceeded stdout limit",
            });
          }
          continue;
        }
        if (outputBytes > outputMaxBytes) {
          finish({
            type: "failure",
            reason: "collector-crash",
            cause: "worker-output-limit",
            message: "resource collector worker exceeded stdout limit",
          });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          finish({
            type: "failure",
            reason: "collector-crash",
            cause: "worker-output-invalid",
            message: "resource collector worker emitted invalid JSON",
          });
          return;
        }
        const message = resourceWorkerMessage(parsed);
        if (!message) {
          finish({
            type: "failure",
            reason: "collector-crash",
            cause: "worker-output-invalid",
            message: "resource collector worker emitted an invalid message",
          });
          return;
        }
        if (message.type === "observation" && message.diagnostic.fresh !== fresh) {
          finish({
            type: "failure",
            reason: "collector-crash",
            cause: "worker-output-invalid",
            message: "resource collector worker returned mismatched freshness",
          });
          return;
        }
        if (message.type === "failure") {
          finish({
            type: "failure",
            reason: "collector-crash",
            cause: "worker-failure",
            message: "resource collector worker reported a failure",
            error: new Error(message.error),
          });
          return;
        }
        finish({
          type: "success",
          value: collectedResources(message.payload, message.diagnostic, message.targets, targetEpoch),
        });
        output = "";
      }
    };
    const onStderr = (chunk: Buffer) => {
      outputBytes += chunk.length;
      stderrTail.append(stderrDecoder.write(chunk));
      if (outputBytes > outputMaxBytes + (containmentRequested && !containmentProven ? 512 : 0)) {
        finish({
          type: "failure",
          reason: "collector-crash",
          cause: "worker-output-limit",
          message: "resource collector worker exceeded output limit",
        });
      }
    };
    const onStdinError = (error: Error) => finish({
      type: "failure",
      reason: "collector-crash",
      cause: "worker-input",
      message: "resource collector worker input failed",
      error,
    });
    worker.stdout.on("data", onStdout);
    worker.stderr.on("data", onStderr);
    worker.stdin.once("error", onStdinError);
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
    workerProcessRuntime?: ResourceWorkerProcessRuntime;
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
    } : (fresh = false) => collectResourcesInWorker(
      fresh,
      options.readFiles,
      options.workerLimits,
      globalStore.__llvResourceTargetEpoch ?? 0,
      options.workerProcessRuntime,
    ),
  });
  let lastPersistedGeneration = options.initial?.generation ?? 0;
  const persist = (observation: ResourceObservation<CollectedResources>) => {
    if (observation.degradedReason || observation.generation <= lastPersistedGeneration) return;
    const succeeded = options.persist?.(observation) ?? true;
    if (succeeded) lastPersistedGeneration = observation.generation;
  };
  let freshFlight: Promise<ResourcesRead> | null = null;
  let backgroundFlight: Promise<void> | null = null;
  let latestBackgroundFailure: ResourceCollectorResult<CollectedResources> | null = null;
  const observeTimeoutMs = options.workerLimits?.observeTimeoutMs ?? RESOURCE_OBSERVE_TIMEOUT_MS;

  const clearBackgroundFailure = (observation: ResourceObservation<CollectedResources>) => {
    if (latestBackgroundFailure && observation.generation >= latestBackgroundFailure.generation) {
      latestBackgroundFailure = null;
    }
  };

  const revalidateInBackground = (latest: ResourceObservation<CollectedResources>) => {
    if (backgroundFlight) return;
    const task = collector.observe(latest.generation, observeTimeoutMs, false)
      .then((result) => {
        if (result.failure) {
          latestBackgroundFailure = result;
          return;
        }
        if (result.observation) {
          clearBackgroundFailure(result.observation);
        }
      })
      .finally(() => {
        if (backgroundFlight === task) backgroundFlight = null;
      });
    backgroundFlight = task;
  };

  const readOnce = async (fresh: boolean): Promise<ResourcesRead> => {
    const latest = collector.latest();
    if (!fresh && latest) {
      if (now() - latest.completedAt >= CACHE_MS) {
        /* The completed file snapshot remains the response while a bounded
           current scan revalidates in the collector. Its rejection is held
           by the collector, so polling never leaks an unhandled rejection. */
        revalidateInBackground(latest);
      }
      persist(latest);
      if (latestBackgroundFailure) {
        return resourceReadFromResult(latestBackgroundFailure, captureSystem, false, true);
      }
      return resourceReadFromResult({
        observation: latest,
        generation: latest.generation,
        startedAt: latest.startedAt,
        completedAt: latest.completedAt,
        collectorId,
      }, captureSystem, false, true);
    }
    const fence = fresh ? collector.fence() : -1;
    const result = await collector.observe(
      fence,
      observeTimeoutMs,
      fresh,
    );
    if (result.observation && !result.failure) {
      persist(result.observation);
      clearBackgroundFailure(result.observation);
    }
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
