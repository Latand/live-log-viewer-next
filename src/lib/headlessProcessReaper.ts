import os from "node:os";

import { readTranscriptHosts, type TranscriptHost } from "@/lib/agent/transcriptHost";
import { loadFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { procBackend, type ProcSnapshotEntry } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import type { ProcessSignal } from "@/lib/processGroup";
import { panePidMap } from "@/lib/tmux";

const DEFAULT_THRESHOLD_MS = 2 * 60 * 60_000;
const MINIMUM_THRESHOLD_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;

export interface ReaperProcess extends ProcSnapshotEntry {
  ppid: number;
  ageMs: number;
  identity: string | null;
}

export interface HeadlessProcessCandidate {
  pid: number;
  identity: string;
  kind: "codex-exec" | "orphan-mcp";
}

interface SelectionInput {
  processes: ReaperProcess[];
  flows: Flow[];
  hosts: TranscriptHost[];
  panePids: number[];
  thresholdMs: number;
}

interface ReaperDependencies {
  listProcesses(): ProcSnapshotEntry[];
  ppidMap(): Map<number, number>;
  processIdentity(pid: number): string | null;
  processAgeMs(pid: number, identity: string | null): number | null;
  loadFlows(): Flow[];
  readHosts(): Promise<TranscriptHost[]>;
  readPanePids(): Promise<number[] | null>;
  signalProcess: ProcessSignal;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
}

export interface HeadlessProcessReaperReport {
  candidates: number;
  signaled: number;
}

function isViewerCodexExec(process: Pick<ReaperProcess, "argv" | "tty">): boolean {
  if (process.tty !== 0) return false;
  const args = process.argv;
  return args.includes("exec") && args.includes("--json") && args.includes("--output-last-message")
    && args.some((arg) => /(^|[/\\])codex(?:-[^/\\]+)?$/i.test(arg));
}

function isCodexOwner(process: Pick<ReaperProcess, "argv">): boolean {
  return process.argv.some((arg) => /(^|[/\\])codex(?:-[^/\\]+)?$/i.test(arg))
    && (process.argv.includes("exec") || process.argv.includes("app-server"));
}

function isClaudeOwner(process: Pick<ReaperProcess, "argv">): boolean {
  return process.argv.some((arg) => /(^|[/\\])claude(?:-[^/\\]+)?$/i.test(arg));
}

function isMcpServer(process: Pick<ReaperProcess, "argv" | "tty">): boolean {
  if (process.tty !== 0) return false;
  const command = process.argv.join(" ").toLowerCase();
  return /(?:^|[\s/@_-])mcp(?:[\s/@_.-]|$)/.test(command)
    || command.includes("chrome-devtools-mcp")
    || command.includes("codex-telegram-mcp");
}

function ancestry(pid: number, byPid: Map<number, ReaperProcess>): number[] {
  const result: number[] = [];
  const seen = new Set<number>([pid]);
  let current = byPid.get(pid)?.ppid ?? 0;
  while (current > 0 && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = byPid.get(current)?.ppid ?? 0;
  }
  return result;
}

function protectedRoots(input: SelectionInput, byPid: Map<number, ReaperProcess>): Set<number> {
  const roots = new Set<number>();
  for (const host of input.hosts) {
    roots.add(host.panePid);
    roots.add(host.agentPid);
  }
  for (const panePid of input.panePids) roots.add(panePid);
  for (const flow of input.flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      if (!round.reviewerPid || round.verdict || round.error || round.terminalAt) continue;
      const observed = byPid.get(round.reviewerPid);
      if (!observed) continue;
      if (round.reviewerIdentity && observed.identity !== round.reviewerIdentity) continue;
      roots.add(round.reviewerPid);
    }
  }
  const protectedPids = new Set<number>();
  const ppids = new Map(input.processes.map((process) => [process.pid, process.ppid]));
  for (const root of roots) for (const pid of descendantPids(root, ppids)) protectedPids.add(pid);
  return protectedPids;
}

export function selectHeadlessProcessCandidates(input: SelectionInput): HeadlessProcessCandidate[] {
  const byPid = new Map(input.processes.map((process) => [process.pid, process]));
  const protectedPids = protectedRoots(input, byPid);
  const staleViewerExecs = new Set(input.processes
    .filter((process) => process.ageMs >= input.thresholdMs && process.identity && isViewerCodexExec(process) && !protectedPids.has(process.pid))
    .map((process) => process.pid));
  const candidates: HeadlessProcessCandidate[] = [];

  for (const process of input.processes) {
    if (!process.identity || process.ageMs < input.thresholdMs || protectedPids.has(process.pid)) continue;
    if (staleViewerExecs.has(process.pid)) {
      candidates.push({ pid: process.pid, identity: process.identity, kind: "codex-exec" });
      continue;
    }
    if (!isMcpServer(process)) continue;
    const parents = ancestry(process.pid, byPid);
    if (parents.some((pid) => staleViewerExecs.has(pid) || isMcpServer(byPid.get(pid) ?? { argv: [], tty: 0 }))) continue;
    if (parents.some((pid) => isCodexOwner(byPid.get(pid) ?? { argv: [] }))) continue;
    if (parents.some((pid) => isClaudeOwner(byPid.get(pid) ?? { argv: [] }))) continue;
    if (parents.some((pid) => pid !== 1 && byPid.has(pid))) continue;
    candidates.push({ pid: process.pid, identity: process.identity, kind: "orphan-mcp" });
  }
  return candidates.sort((left, right) => left.pid - right.pid);
}

export function headlessReaperThresholdMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const configured = Number(env.LLV_HEADLESS_REAPER_THRESHOLD_MS);
  return Number.isFinite(configured) && configured >= MINIMUM_THRESHOLD_MS ? configured : DEFAULT_THRESHOLD_MS;
}

function ageFromIdentity(_pid: number, identity: string | null): number | null {
  if (!identity) return null;
  const token = identity.slice(identity.indexOf(":") + 1);
  if (procBackend.name === "linux" && /^\d+$/.test(token)) {
    return Math.max(0, os.uptime() * 1_000 - Number(token) * 10);
  }
  const startedAt = Date.parse(token);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
}

const defaultDependencies: ReaperDependencies = {
  listProcesses: () => procBackend.listProcesses(),
  ppidMap: () => procBackend.ppidMap(),
  processIdentity: (pid) => procBackend.processIdentity(pid),
  processAgeMs: ageFromIdentity,
  loadFlows,
  readHosts: async () => (await readTranscriptHosts(true)).hosts,
  readPanePids: async () => {
    const observation = await panePidMap(true);
    if (observation.kind === "failure") return null;
    return observation.kind === "available" ? [...observation.panes.keys()] : [];
  },
  signalProcess: process.kill,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
};

function activeFlowReviewerPids(flows: Flow[]): Set<number> {
  const pids = new Set<number>();
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      if (round.reviewerPid && !round.verdict && !round.error && !round.terminalAt) pids.add(round.reviewerPid);
    }
  }
  return pids;
}

function snapshot(dependencies: ReaperDependencies, identityPids: ReadonlySet<number> = new Set()): ReaperProcess[] {
  const ppids = dependencies.ppidMap();
  return dependencies.listProcesses().map((process) => {
    const managed = identityPids.has(process.pid) || isViewerCodexExec(process as ReaperProcess) || isMcpServer(process as ReaperProcess);
    const identity = managed ? dependencies.processIdentity(process.pid) : null;
    return {
      ...process,
      ppid: ppids.get(process.pid) ?? 0,
      identity,
      ageMs: managed ? dependencies.processAgeMs(process.pid, identity) ?? 0 : 0,
    };
  });
}

function signalGroup(candidate: HeadlessProcessCandidate, dependencies: ReaperDependencies, graceMs: number): void {
  try { dependencies.signalProcess(-candidate.pid, "SIGTERM"); }
  catch { try { dependencies.signalProcess(candidate.pid, "SIGTERM"); } catch { return; } }
  const timer = dependencies.setTimeout(() => {
    try { dependencies.signalProcess(-candidate.pid, "SIGKILL"); }
    catch { /* the process group has exited */ }
  }, graceMs);
  timer.unref?.();
}

function signalOrphanTree(candidate: HeadlessProcessCandidate, processes: ReaperProcess[], dependencies: ReaperDependencies, graceMs: number): void {
  const ppids = new Map(processes.map((process) => [process.pid, process.ppid]));
  const tree = descendantPids(candidate.pid, ppids).reverse().map((pid) => ({ pid, identity: dependencies.processIdentity(pid) }));
  for (const process of tree) {
    if (!process.identity) continue;
    try { dependencies.signalProcess(process.pid, "SIGTERM"); } catch { /* process has exited */ }
  }
  const timer = dependencies.setTimeout(() => {
    for (const process of tree) {
      if (!process.identity || dependencies.processIdentity(process.pid) !== process.identity) continue;
      try { dependencies.signalProcess(process.pid, "SIGKILL"); } catch { /* process has exited */ }
    }
  }, graceMs);
  timer.unref?.();
}

export async function runHeadlessProcessReaper(options: {
  hosts: TranscriptHost[];
  flows?: Flow[];
  thresholdMs?: number;
  shutdownGraceMs?: number;
  dependencies?: Partial<ReaperDependencies>;
}): Promise<HeadlessProcessReaperReport> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const thresholdMs = options.thresholdMs ?? headlessReaperThresholdMs();
  const panePids = await dependencies.readPanePids();
  if (panePids === null) return { candidates: 0, signaled: 0 };
  const initialFlows = options.flows ?? dependencies.loadFlows();
  const initial = snapshot(dependencies, activeFlowReviewerPids(initialFlows));
  const candidates = selectHeadlessProcessCandidates({
    processes: initial,
    flows: initialFlows,
    hosts: options.hosts,
    panePids,
    thresholdMs,
  });
  let signaled = 0;
  for (const candidate of candidates) {
    const [hosts, flows, freshPanePids] = await Promise.all([
      dependencies.readHosts(),
      Promise.resolve(dependencies.loadFlows()),
      dependencies.readPanePids(),
    ]);
    if (freshPanePids === null) continue;
    const fresh = snapshot(dependencies, activeFlowReviewerPids(flows));
    const verified = selectHeadlessProcessCandidates({ processes: fresh, flows, hosts, panePids: freshPanePids, thresholdMs })
      .find((current) => current.pid === candidate.pid && current.identity === candidate.identity && current.kind === candidate.kind);
    if (!verified) continue;
    if (verified.kind === "codex-exec") signalGroup(verified, dependencies, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    else signalOrphanTree(verified, fresh, dependencies, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    signaled += 1;
  }
  return { candidates: candidates.length, signaled };
}
