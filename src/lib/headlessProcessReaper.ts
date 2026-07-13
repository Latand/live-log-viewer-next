import os from "node:os";
import path from "node:path";

import { readTranscriptHosts, type TranscriptHost } from "@/lib/agent/transcriptHost";
import { loadFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { procBackend, type ProcSnapshotEntry } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import type { ProcessSignal } from "@/lib/processGroup";
import { panePidMap } from "@/lib/tmux";
import { statePath } from "@/lib/configDir";

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
  flowArtifactsRoot: string;
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

interface ViewerFlowOutput {
  flowId: string;
  round: number;
}

function viewerFlowOutput(outputPath: string | undefined, flowArtifactsRoot: string): ViewerFlowOutput | null {
  if (!outputPath || !path.isAbsolute(outputPath)) return null;
  const relative = path.relative(path.resolve(flowArtifactsRoot), path.resolve(outputPath));
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !parts[0]) return null;
  const match = /^round-(\d+)-last-message\.md$/.exec(parts[1]!);
  return match ? { flowId: parts[0], round: Number(match[1]) } : null;
}

function viewerCodexExecOutput(process: Pick<ReaperProcess, "argv" | "tty">, flowArtifactsRoot: string): ViewerFlowOutput | null {
  if (process.tty !== 0) return null;
  const args = process.argv;
  const outputIndex = args.indexOf("--output-last-message");
  if (!args.includes("exec") || !args.includes("--json") || outputIndex < 0) return null;
  if (!args.some((arg) => /(^|[/\\])codex(?:-[^/\\]+)?$/i.test(arg))) return null;
  return viewerFlowOutput(args[outputIndex + 1], flowArtifactsRoot);
}

function hasViewerFlowProvenance(process: ReaperProcess, input: SelectionInput): boolean {
  const output = viewerCodexExecOutput(process, input.flowArtifactsRoot);
  if (!output || !process.identity) return false;
  const flow = input.flows.find((candidate) => candidate.id === output.flowId);
  const round = flow?.rounds.find((candidate) => candidate.n === output.round);
  return flow?.reviewerMode === "headless"
    && round?.reviewerPid === process.pid
    && round.reviewerIdentity === process.identity;
}

function isCodexOwner(process: Pick<ReaperProcess, "argv">): boolean {
  return process.argv.some((arg) => /(^|[/\\])codex(?:-[^/\\]+)?$/i.test(arg))
    && (process.argv.includes("exec") || process.argv.includes("app-server"));
}

function isClaudeOwner(process: Pick<ReaperProcess, "argv">): boolean {
  return process.argv.some((arg) => /(^|[/\\])claude(?:-[^/\\]+)?$/i.test(arg));
}

const MCP_NAME = /(?:^|[-_.])mcp(?:[-_.]|$)/i;
const PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[^\s/]+)?$/i;

function isMcpExecutable(command: string | undefined): boolean {
  return Boolean(command && MCP_NAME.test(path.basename(command)));
}

function isMcpPackageSpec(spec: string | undefined): boolean {
  if (!spec || !PACKAGE_SPEC.test(spec)) return false;
  const versionAt = spec.startsWith("@") ? spec.indexOf("@", spec.indexOf("/") + 1) : spec.indexOf("@");
  const packageName = versionAt > 0 ? spec.slice(0, versionAt) : spec;
  return MCP_NAME.test(packageName.split("/").at(-1) ?? "");
}

function packageOperand(args: string[], start: number): string | undefined {
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return undefined;
    if (arg === "--package" || arg === "-p") return args[index + 1];
    if (arg.startsWith("--package=")) return arg.slice("--package=".length);
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

const UV_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--cache-dir",
  "--color",
  "--config-file",
  "--directory",
  "--project",
  "--python",
]);

function uvMcpPackage(args: string[]): boolean {
  let index = 1;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "run") return isMcpPackageSpec(packageOperand(args, index + 1));
    if (arg === "tool" && args[index + 1] === "run") return isMcpPackageSpec(packageOperand(args, index + 2));
    if (UV_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return false;
  }
  return false;
}

function isMcpServer(process: Pick<ReaperProcess, "argv" | "tty">): boolean {
  if (process.tty !== 0) return false;
  const args = process.argv;
  if (isMcpExecutable(args[0])) return true;
  const runner = path.basename(args[0] ?? "").toLowerCase();
  if (runner === "npx" || runner === "bunx" || runner === "uvx") return isMcpPackageSpec(packageOperand(args, 1));
  if (runner === "npm" && (args[1] === "exec" || args[1] === "x")) return isMcpPackageSpec(packageOperand(args, 2));
  if ((runner === "pnpm" || runner === "yarn") && (args[1] === "dlx" || args[1] === "exec")) {
    return isMcpPackageSpec(packageOperand(args, 2));
  }
  if (runner === "bun" && args[1] === "x") return isMcpPackageSpec(packageOperand(args, 2));
  return runner === "uv" && uvMcpPackage(args);
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

function orphanProtectedPids(input: SelectionInput, byPid: Map<number, ReaperProcess>): Set<number> {
  const protectedPids = protectedRoots(input, byPid);
  const ppids = new Map(input.processes.map((process) => [process.pid, process.ppid]));
  for (const process of input.processes) {
    if (!isCodexOwner(process) && !isClaudeOwner(process)) continue;
    for (const pid of descendantPids(process.pid, ppids)) protectedPids.add(pid);
  }
  return protectedPids;
}

export function selectHeadlessProcessCandidates(input: SelectionInput): HeadlessProcessCandidate[] {
  const byPid = new Map(input.processes.map((process) => [process.pid, process]));
  const protectedPids = protectedRoots(input, byPid);
  const staleViewerExecs = new Set(input.processes
    .filter((process) => process.ageMs >= input.thresholdMs && hasViewerFlowProvenance(process, input) && !protectedPids.has(process.pid))
    .map((process) => process.pid));
  const candidates: HeadlessProcessCandidate[] = [];

  for (const process of input.processes) {
    if (!process.identity || process.ageMs < input.thresholdMs || protectedPids.has(process.pid)) continue;
    if (staleViewerExecs.has(process.pid)) {
      candidates.push({ pid: process.pid, identity: process.identity, kind: "codex-exec" });
      continue;
    }
    if (isCodexOwner(process) || isClaudeOwner(process)) continue;
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

function currentOrphanProtection(input: SelectionInput, dependencies: ReaperDependencies): {
  protectedPids: Set<number>;
  ppids: Map<number, number>;
} {
  const flows = dependencies.loadFlows();
  const identityPids = activeFlowReviewerPids(flows);
  const ppids = dependencies.ppidMap();
  const processes = dependencies.listProcesses().map((process) => ({
    ...process,
    ppid: ppids.get(process.pid) ?? 0,
    identity: identityPids.has(process.pid) ? dependencies.processIdentity(process.pid) : null,
    ageMs: 0,
  }));
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  return { protectedPids: orphanProtectedPids({ ...input, flows, processes }, byPid), ppids };
}

function snapshot(dependencies: ReaperDependencies, flowArtifactsRoot: string, identityPids: ReadonlySet<number> = new Set()): ReaperProcess[] {
  const ppids = dependencies.ppidMap();
  return dependencies.listProcesses().map((process) => {
    const managed = identityPids.has(process.pid) || viewerCodexExecOutput(process as ReaperProcess, flowArtifactsRoot) !== null || isMcpServer(process as ReaperProcess);
    const identity = managed ? dependencies.processIdentity(process.pid) : null;
    return {
      ...process,
      ppid: ppids.get(process.pid) ?? 0,
      identity,
      ageMs: managed ? dependencies.processAgeMs(process.pid, identity) ?? 0 : 0,
    };
  });
}

function signalGroup(candidate: HeadlessProcessCandidate, dependencies: ReaperDependencies, graceMs: number): boolean {
  if (dependencies.processIdentity(candidate.pid) !== candidate.identity) return false;
  try { dependencies.signalProcess(-candidate.pid, "SIGTERM"); }
  catch {
    if (dependencies.processIdentity(candidate.pid) !== candidate.identity) return false;
    try { dependencies.signalProcess(candidate.pid, "SIGTERM"); } catch { return false; }
  }
  const timer = dependencies.setTimeout(() => {
    try { dependencies.signalProcess(-candidate.pid, "SIGKILL"); }
    catch { /* the process group has exited */ }
  }, graceMs);
  timer.unref?.();
  return true;
}

function signalOrphanTree(candidate: HeadlessProcessCandidate, input: SelectionInput, dependencies: ReaperDependencies, graceMs: number): boolean {
  const processes = input.processes;
  const observed = new Map(processes.map((process) => [process.pid, process.identity]));
  let protection: ReturnType<typeof currentOrphanProtection>;
  try { protection = currentOrphanProtection(input, dependencies); }
  catch { return false; }
  const { ppids, protectedPids } = protection;
  const treePids = descendantPids(candidate.pid, ppids).reverse();
  if (treePids.some((pid) => protectedPids.has(pid))) return false;
  const tree = treePids.map((pid) => {
    const observedIdentity = observed.get(pid) ?? null;
    const expectedIdentity = dependencies.processIdentity(pid);
    const eligible = Boolean(expectedIdentity && (!observedIdentity || observedIdentity === expectedIdentity));
    return { pid, observedIdentity, expectedIdentity, eligible };
  });
  const root = tree.find((process) => process.pid === candidate.pid);
  if (root?.observedIdentity !== candidate.identity || root.expectedIdentity !== candidate.identity) return false;
  for (const process of tree) {
    if (!process.eligible || !process.expectedIdentity) continue;
    if (dependencies.processIdentity(process.pid) !== process.expectedIdentity) continue;
    try { dependencies.signalProcess(process.pid, "SIGTERM"); } catch { /* process has exited */ }
  }
  const timer = dependencies.setTimeout(() => {
    let protectedAtKill: Set<number>;
    try { protectedAtKill = currentOrphanProtection(input, dependencies).protectedPids; }
    catch { return; }
    for (const process of tree) {
      if (protectedAtKill.has(process.pid)) continue;
      if (!process.eligible || !process.expectedIdentity || dependencies.processIdentity(process.pid) !== process.expectedIdentity) continue;
      try { dependencies.signalProcess(process.pid, "SIGKILL"); } catch { /* process has exited */ }
    }
  }, graceMs);
  timer.unref?.();
  return true;
}

export async function runHeadlessProcessReaper(options: {
  hosts: TranscriptHost[];
  flows?: Flow[];
  thresholdMs?: number;
  flowArtifactsRoot?: string;
  shutdownGraceMs?: number;
  dependencies?: Partial<ReaperDependencies>;
}): Promise<HeadlessProcessReaperReport> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const thresholdMs = options.thresholdMs ?? headlessReaperThresholdMs();
  const flowArtifactsRoot = options.flowArtifactsRoot ?? statePath("flows");
  const panePids = await dependencies.readPanePids();
  if (panePids === null) return { candidates: 0, signaled: 0 };
  const initialFlows = options.flows ?? dependencies.loadFlows();
  const initial = snapshot(dependencies, flowArtifactsRoot, activeFlowReviewerPids(initialFlows));
  const candidates = selectHeadlessProcessCandidates({
    processes: initial,
    flows: initialFlows,
    hosts: options.hosts,
    panePids,
    flowArtifactsRoot,
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
    const fresh = snapshot(dependencies, flowArtifactsRoot, activeFlowReviewerPids(flows));
    const freshInput = { processes: fresh, flows, hosts, panePids: freshPanePids, flowArtifactsRoot, thresholdMs };
    const verified = selectHeadlessProcessCandidates(freshInput)
      .find((current) => current.pid === candidate.pid && current.identity === candidate.identity && current.kind === candidate.kind);
    if (!verified) continue;
    if (verified.kind === "codex-exec") {
      if (!signalGroup(verified, dependencies, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS)) continue;
    } else if (!signalOrphanTree(verified, freshInput, dependencies, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS)) {
      continue;
    }
    signaled += 1;
  }
  return { candidates: candidates.length, signaled };
}
