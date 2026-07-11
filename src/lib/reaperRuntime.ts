import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentRegistry, type AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { readTranscriptHosts, type TranscriptHost, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { boardFor } from "@/lib/board/store";
import { statePath } from "@/lib/configDir";
import { resolveFlowMergeIdentity } from "@/lib/flows/git";
import { loadFlows, saveFlows } from "@/lib/flows/store";
import type { Flow, FlowMergeEvidence } from "@/lib/flows/types";
import { procBackend } from "@/lib/proc";
import { listFiles } from "@/lib/scanner";
import { scanUserAuthoredMessages } from "@/lib/session/reader";
import { killTmuxHostIfMatches, tmuxEndpoint } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import {
  evaluateReaper,
  runEvaluatedReaper,
  type HeadlessReviewerProcess,
  type ReaperAgentReport,
  type ReaperInput,
  type ReaperJournalRecord,
  type ReaperReport,
} from "./reaper";

const REPORT_FILE = () => statePath("reaper-report.json");
const STATE_FILE = () => statePath("reaper-state.json");
const JOURNAL_FILE = () => statePath("reaper-journal.ndjson");
const ROTATE_BYTES = 4 * 1024 * 1024;

interface ReaperState {
  version: 1;
  firstObservedAt: Record<string, string>;
}

function hostKey(host: TranscriptHost): string {
  return `${host.paneId}:${host.agentPid}:${host.agentIdentity ?? "unknown"}`;
}

function readState(): ReaperState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as Partial<ReaperState>;
    if (parsed.version === 1 && parsed.firstObservedAt && typeof parsed.firstObservedAt === "object") {
      return { version: 1, firstObservedAt: parsed.firstObservedAt };
    }
  } catch { /* first run or invalid state */ }
  return { version: 1, firstObservedAt: {} };
}

function atomicWrite(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function updateObservationState(hosts: TranscriptHost[], now: number): ReaperState {
  const previous = readState();
  const firstObservedAt: Record<string, string> = {};
  for (const host of hosts) {
    const key = hostKey(host);
    firstObservedAt[key] = previous.firstObservedAt[key] ?? new Date(now).toISOString();
  }
  const state = { version: 1 as const, firstObservedAt };
  atomicWrite(STATE_FILE(), state);
  return state;
}

function checkoutClean(flow: Flow): boolean | null {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: flow.cwd,
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().length === 0;
}

function localBranchMerged(flow: Flow, reviewedHeadSha: string): boolean {
  if (checkoutClean(flow) !== true) return false;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: flow.cwd, encoding: "utf8", timeout: 2_000 });
  if (head.status !== 0 || head.stdout.trim() !== reviewedHeadSha) return false;
  for (const branch of ["origin/main", "origin/master", "main", "master"]) {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", reviewedHeadSha, branch], {
      cwd: flow.cwd,
      stdio: "ignore",
      timeout: 2_000,
    });
    if (result.status === 0) return true;
  }
  return false;
}

type PullRequestProbe = { number: number; mergedAt: string | null; headRefOid: string | null };

const MERGE_PROBE_TIMEOUT_MS = 5_000;
const MERGE_PROBE_CONCURRENCY = 4;

function probePullRequest(evidence: FlowMergeEvidence, timeoutMs = MERGE_PROBE_TIMEOUT_MS): Promise<PullRequestProbe | null> {
  if (!evidence.repository || !evidence.headRef) return Promise.resolve(null);
  const args = evidence.prNumber
    ? ["pr", "view", String(evidence.prNumber), "--repo", evidence.repository, "--json", "number,mergedAt,headRefOid"]
    : ["pr", "list", "--repo", evidence.repository, "--head", evidence.headRef, "--state", "all", "--json", "number,mergedAt,headRefOid", "--limit", "1"];
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (value: PullRequestProbe | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length <= 1024 * 1024) stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || stdout.length > 1024 * 1024) return finish(null);
      try {
        const parsed = JSON.parse(stdout) as unknown;
        const item = (Array.isArray(parsed) ? parsed[0] : parsed) as { number?: unknown; mergedAt?: unknown; headRefOid?: unknown } | undefined;
        if (!item || !Number.isInteger(item.number)) return finish(null);
        const mergedAt = typeof item.mergedAt === "string" && item.mergedAt ? item.mergedAt : null;
        const headRefOid = typeof item.headRefOid === "string" && item.headRefOid ? item.headRefOid : null;
        if (mergedAt && (!evidence.headSha || headRefOid !== evidence.headSha)) return finish(null);
        finish({ number: item.number as number, mergedAt, headRefOid });
      } catch {
        finish(null);
      }
    });
  });
}

const MERGE_CHECK_INTERVAL_MS = 5 * 60_000;

function reviewedHeadSha(flow: Flow, evidence: FlowMergeEvidence | null): string | null {
  const reviewed = [...flow.rounds].reverse().find((round) => round.verdict === "APPROVE");
  if (reviewed?.reviewHeadSha) return reviewed.reviewHeadSha;
  return evidence?.source === "github-pr" && evidence.mergedAt ? evidence.headSha : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function flowTransitionRevision(flow: Flow): string {
  const { mergeEvidence: _mergeEvidence, ...transition } = flow;
  return JSON.stringify(transition);
}

function cloneMergeEvidence(evidence: FlowMergeEvidence | null | undefined): FlowMergeEvidence | null {
  return evidence ? { ...evidence } : null;
}

function persistRefreshedMergeEvidence(
  flows: Flow[],
  changedFlowIds: ReadonlySet<string>,
  initialRevisions: ReadonlyMap<string, string>,
  overrides: ReaperActuationOverrides,
): void {
  if (changedFlowIds.size === 0 || (overrides.loadFlows && !overrides.saveFlows)) return;
  const latest = overrides.loadFlows ? overrides.loadFlows() : overrides.saveFlows ? flows : loadFlows();
  let applied = false;
  for (const candidate of flows) {
    if (!changedFlowIds.has(candidate.id)) continue;
    const current = latest.find((flow) => flow.id === candidate.id);
    if (!current || flowTransitionRevision(current) !== initialRevisions.get(candidate.id)) continue;
    current.mergeEvidence = cloneMergeEvidence(candidate.mergeEvidence);
    applied = true;
  }
  if (applied) (overrides.saveFlows ?? saveFlows)(latest);
}

export async function refreshMergedFlowIds(flows: Flow[], overrides: ReaperActuationOverrides = {}): Promise<Set<string>> {
  const now = (overrides.now ?? Date.now)();
  const merged = new Set<string>();
  const initialRevisions = new Map(flows.map((flow) => [flow.id, flowTransitionRevision(flow)]));
  const changedFlowIds = new Set<string>();
  const markChanged = (flow: Flow) => { changedFlowIds.add(flow.id); };
  const timeoutMs = overrides.mergeProbeTimeoutMs ?? MERGE_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(1, overrides.mergeProbeConcurrency ?? MERGE_PROBE_CONCURRENCY);
  await mapWithConcurrency(flows, concurrency, async (flow) => {
    let evidence = flow.mergeEvidence ?? null;
    const clean = (overrides.checkoutClean ?? checkoutClean)(flow);
    if (clean === false || (clean === null && fs.existsSync(flow.cwd))) {
      if (evidence?.mergedAt || evidence?.source) {
        evidence.mergedAt = null;
        evidence.checkedAt = null;
        evidence.source = null;
        markChanged(flow);
      }
      return;
    }
    const reviewedSha = reviewedHeadSha(flow, evidence);
    if (!reviewedSha) return;
    const identity = (overrides.resolveMergeIdentity ?? resolveFlowMergeIdentity)(flow.cwd);
    if (identity) {
      if (identity.headSha !== reviewedSha) {
        if (evidence?.mergedAt || evidence?.source) {
          evidence.mergedAt = null;
          evidence.checkedAt = null;
          evidence.source = null;
          markChanged(flow);
        }
        return;
      }
      if (!evidence || evidence.repository !== identity.repository || evidence.headRef !== identity.headRef || evidence.headSha !== reviewedSha) {
        evidence = { ...identity, headSha: reviewedSha, prNumber: null, mergedAt: null, checkedAt: null, source: null };
        flow.mergeEvidence = evidence;
        markChanged(flow);
      }
    } else if (evidence?.headSha !== reviewedSha) {
      evidence = evidence ? { ...evidence, headSha: reviewedSha, prNumber: null, mergedAt: null, checkedAt: null, source: null } : null;
      flow.mergeEvidence = evidence;
      markChanged(flow);
    }
    if (evidence?.mergedAt) {
      merged.add(flow.id);
      return;
    }
    const checkedAt = evidence?.checkedAt ? Date.parse(evidence.checkedAt) : Number.NaN;
    if (Number.isFinite(checkedAt) && now - checkedAt < MERGE_CHECK_INTERVAL_MS) return;
    let confirmed: FlowMergeEvidence | null = null;
    if (evidence?.repository && evidence.headRef) {
      const probe = overrides.probePullRequest
        ? Promise.resolve(overrides.probePullRequest(evidence))
        : probePullRequest(evidence, timeoutMs);
      const pullRequest = await withTimeout(probe, timeoutMs, null);
      if (pullRequest?.mergedAt && pullRequest.headRefOid === evidence.headSha) {
        confirmed = {
          ...evidence,
          prNumber: pullRequest.number,
          mergedAt: pullRequest.mergedAt,
          headSha: pullRequest.headRefOid ?? evidence.headSha,
          checkedAt: new Date(now).toISOString(),
          source: "github-pr",
        };
      } else {
        if (pullRequest) evidence.prNumber = pullRequest.number;
        evidence.checkedAt = new Date(now).toISOString();
        markChanged(flow);
      }
    }
    if (!confirmed && (overrides.localBranchMerged ?? localBranchMerged)(flow, reviewedSha)) {
      confirmed = {
        repository: evidence?.repository ?? null,
        headRef: evidence?.headRef ?? null,
        headSha: reviewedSha,
        prNumber: evidence?.prNumber ?? null,
        mergedAt: new Date(now).toISOString(),
        checkedAt: new Date(now).toISOString(),
        source: "git-ancestor",
      };
    }
    if (confirmed) {
      flow.mergeEvidence = confirmed;
      merged.add(flow.id);
      markChanged(flow);
    }
  });
  persistRefreshedMergeEvidence(flows, changedFlowIds, initialRevisions, overrides);
  return merged;
}

function profileForPath(snapshot: ReturnType<AgentRegistry["snapshot"]>, pathname: string) {
  return Object.values(snapshot.entries).find((entry) => entry.artifactPath === pathname)?.launchProfile
    ?? Object.values(snapshot.conversations)
      .flatMap((conversation) => conversation.generations)
      .find((generation) => generation.path === pathname)?.launchProfile
    ?? null;
}

function hasViewerWorkerLaunchPrompt(snapshot: ReturnType<AgentRegistry["snapshot"]>, pathname: string): boolean {
  return Object.values(snapshot.receipts).some((receipt) =>
    receipt.purpose === "launch"
    && receipt.artifactPath === pathname
    && receipt.launchProfile.role === "worker"
    && receipt.state === "completed");
}

function viewerFlowMessageAllowance(flows: Flow[], pathname: string): number {
  let count = 0;
  for (const flow of flows) {
    if (flow.kickoffDelivery?.path === pathname) count += 1;
    count += flow.rounds.filter((round) => round.relayDelivery?.path === pathname).length;
  }
  return count;
}

function authorshipEvidence(snapshot: ReturnType<AgentRegistry["snapshot"]>, hosts: TranscriptHost[], flows: Flow[]): {
  userAuthoredPaths: Set<string>;
  unverifiedPaths: Set<string>;
} {
  const userAuthoredPaths = new Set<string>();
  const unverifiedPaths = new Set<string>();
  for (const host of hosts) {
    const pathname = host.primaryPath;
    if (!pathname || userAuthoredPaths.has(pathname) || unverifiedPaths.has(pathname)) continue;
    const viewerMessageAllowance = (hasViewerWorkerLaunchPrompt(snapshot, pathname) ? 1 : 0)
      + viewerFlowMessageAllowance(flows, pathname);
    const scan = scanUserAuthoredMessages(pathname, host.engine, viewerMessageAllowance + 1);
    if (scan.count > viewerMessageAllowance) userAuthoredPaths.add(pathname);
    else if (!scan.complete) unverifiedPaths.add(pathname);
  }
  return { userAuthoredPaths, unverifiedPaths };
}

function viewerOwnedPaths(snapshot: ReturnType<AgentRegistry["snapshot"]>, hosts: TranscriptHost[]): Set<string> {
  return new Set(hosts.flatMap((host) =>
    host.primaryPath && hasViewerWorkerLaunchPrompt(snapshot, host.primaryPath) ? [host.primaryPath] : []));
}

function manualPaths(snapshot: ReturnType<AgentRegistry["snapshot"]>, hosts: TranscriptHost[], files: FileEntry[]): Set<string> {
  const filesByPath = new Map(files.map((entry) => [entry.path, entry]));
  const protectedPaths = new Set<string>();
  for (const host of hosts) {
    const pathname = host.primaryPath;
    if (!pathname) continue;
    const project = filesByPath.get(pathname)?.project || profileForPath(snapshot, pathname)?.project;
    if (!project) continue;
    try {
      if (boardFor(project).prefs.manual.includes(pathname)) protectedPaths.add(pathname);
    } catch {
      protectedPaths.add(pathname);
    }
  }
  return protectedPaths;
}

function refreshFileTimes(files: FileEntry[]): FileEntry[] {
  return files.map((entry) => {
    try { return { ...entry, mtime: fs.statSync(entry.path).mtimeMs / 1000 }; }
    catch { return entry; }
  });
}

function evidenceFor(host: TranscriptHost): TmuxHostEvidence {
  return {
    kind: "tmux",
    endpoint: tmuxEndpoint(),
    server: { pid: host.tmuxServerPid, startIdentity: procBackend.processIdentity(host.tmuxServerPid) },
    paneId: host.paneId,
    panePid: { pid: host.panePid, startIdentity: procBackend.processIdentity(host.panePid) },
    windowName: host.windowName ?? "",
    agent: { pid: host.agentPid, startIdentity: host.agentIdentity },
    argv: host.agentArgv,
  };
}

function appendJournal(record: ReaperJournalRecord): void {
  const filename = JOURNAL_FILE();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(filename).size > ROTATE_BYTES) fs.renameSync(filename, `${filename}.1`);
  } catch { /* first write */ }
  fs.appendFileSync(filename, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function makeInput(
  registry: AgentRegistry,
  hosts: TranscriptHost[],
  files: FileEntry[],
  state: ReaperState,
  now: number,
  overrides: ReaperActuationOverrides = {},
): Promise<ReaperInput> {
  const snapshot = registry.snapshot();
  const flows = (overrides.loadFlows ?? loadFlows)();
  const missingTranscriptPaths = new Set(hosts.flatMap((host) =>
    host.primaryPath && !fs.existsSync(host.primaryPath) ? [host.primaryPath] : []));
  const authorship = authorshipEvidence(snapshot, hosts, flows);
  return {
    now,
    registry: snapshot,
    hosts,
    reviewerProcesses: observeHeadlessReviewers(flows, overrides),
    viewerOwnedPaths: viewerOwnedPaths(snapshot, hosts),
    authorshipUnverifiedPaths: new Set([...missingTranscriptPaths, ...authorship.unverifiedPaths]),
    files,
    flows,
    manualPaths: manualPaths(snapshot, hosts, files),
    userAuthoredPaths: authorship.userAuthoredPaths,
    missingTranscriptPaths,
    mergedFlowIds: await refreshMergedFlowIds(flows, overrides),
    firstObservedAt: state.firstObservedAt,
    enabled: process.env.LLV_REAPER_ENABLED === "1",
  };
}

function observeHeadlessReviewers(flows: Flow[], overrides: ReaperActuationOverrides): HeadlessReviewerProcess[] {
  const pidAlive = overrides.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const processIdentity = overrides.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const processes: HeadlessReviewerProcess[] = [];
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      const pid = round.reviewerPid ?? null;
      const identity = round.reviewerIdentity ?? null;
      if (!pid || !identity || !pidAlive(pid) || processIdentity(pid) !== identity) continue;
      processes.push({ flowId: flow.id, round: round.n, pid, identity, path: round.reviewerPath });
    }
  }
  return processes;
}

interface HeadlessReviewerKillDeps {
  pidAlive(pid: number): boolean;
  processIdentity(pid: number): string | null;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(milliseconds: number): Promise<void>;
  maxVerifyAttempts: number;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

export async function killHeadlessReviewerIfMatches(
  expected: { pid: number; identity: string },
  overrides: Partial<HeadlessReviewerKillDeps> = {},
): Promise<boolean> {
  const deps: HeadlessReviewerKillDeps = {
    pidAlive: (pid) => procBackend.pidAlive(pid),
    processIdentity: (pid) => procBackend.processIdentity(pid),
    signal: signalProcessGroup,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxVerifyAttempts: 20,
    ...overrides,
  };
  const gone = () => !deps.pidAlive(expected.pid) || deps.processIdentity(expected.pid) !== expected.identity;
  if (gone()) return false;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      deps.signal(expected.pid, signal);
    } catch {
      if (gone()) return true;
      return false;
    }
    for (let attempt = 0; attempt < deps.maxVerifyAttempts; attempt += 1) {
      if (gone()) return true;
      if (attempt + 1 < deps.maxVerifyAttempts) await deps.sleep(25);
    }
  }
  return false;
}

function hostMatchesCandidate(host: TranscriptHost, candidate: ReaperAgentReport): boolean {
  return candidate.targetKind === "tmux"
    && host.paneId === candidate.paneId
    && host.panePid === candidate.panePid
    && host.agentPid === candidate.agentPid
    && host.agentIdentity === candidate.processIdentity
    && host.primaryPath === candidate.path;
}

function reportMatchesCandidate(current: ReaperAgentReport, expected: ReaperAgentReport): boolean {
  return current.targetKind === "tmux"
    && current.paneId === expected.paneId
    && current.panePid === expected.panePid
    && current.agentPid === expected.agentPid
    && current.processIdentity === expected.processIdentity
    && current.path === expected.path;
}

async function actuateCandidate(
  registry: AgentRegistry,
  files: FileEntry[],
  state: ReaperState,
  agent: ReaperAgentReport,
  overrides: ReaperActuationOverrides = {},
): Promise<boolean> {
  if (agent.targetKind === "process") {
    if (!agent.flowId || agent.round === null || !agent.processIdentity) return false;
    const current = evaluateReaper(await makeInput(registry, [], files, state, (overrides.now ?? Date.now)(), overrides));
    const candidate = current.agents.find((item) => item.targetKind === "process"
      && item.flowId === agent.flowId
      && item.round === agent.round
      && item.agentPid === agent.agentPid
      && item.processIdentity === agent.processIdentity);
    if (!candidate?.eligible) return false;
    return (overrides.killProcess ?? killHeadlessReviewerIfMatches)({ pid: agent.agentPid, identity: agent.processIdentity });
  }
  const paneId = agent.paneId;
  if (paneId === null) return false;
  const observeHosts = overrides.readHosts ?? readTranscriptHosts;
  const killHost = overrides.kill ?? killTmuxHostIfMatches;
  const currentTime = overrides.now ?? Date.now;
  const initialHost = (await observeHosts(true)).hosts.find((host) => hostMatchesCandidate(host, agent));
  if (!initialHost?.primaryPath) return false;
  const entry = Object.values(registry.snapshot().entries).find((candidate) => candidate.artifactPath === agent.path);
  if (!entry) return false;
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  return registry.withOperationLock(entry.key, owner, async () => {
    const claimOwner = `reaper:${crypto.randomUUID()}`;
    try {
      registry.claim(entry.key, claimOwner);
      const freshSnapshot: TranscriptHostSnapshot = await observeHosts(true);
      const freshHost = freshSnapshot.hosts.find((host) => hostMatchesCandidate(host, agent));
      if (!freshHost) return false;
      const current = evaluateReaper(await makeInput(registry, freshSnapshot.hosts, refreshFileTimes(files), state, currentTime(), overrides));
      const candidate = current.agents.find((item) => reportMatchesCandidate(item, agent));
      if (!candidate?.eligible) return false;
      const killed = await killHost(evidenceFor(freshHost));
      if (killed && registry.snapshot().entries[`${entry.key.engine}:${entry.key.sessionId}`]?.host?.paneId === paneId) {
        registry.markUnhosted(entry.key);
      }
      return killed;
    } finally {
      registry.releaseClaim(entry.key, claimOwner);
    }
  });
}

export interface ReaperActuationOverrides {
  readHosts?: (fresh?: boolean) => Promise<TranscriptHostSnapshot>;
  kill?: typeof killTmuxHostIfMatches;
  loadFlows?: typeof loadFlows;
  pidAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | null;
  killProcess?: typeof killHeadlessReviewerIfMatches;
  resolveMergeIdentity?: typeof resolveFlowMergeIdentity;
  probePullRequest?: (evidence: FlowMergeEvidence) => PullRequestProbe | null | Promise<PullRequestProbe | null>;
  localBranchMerged?: typeof localBranchMerged;
  checkoutClean?: typeof checkoutClean;
  mergeProbeTimeoutMs?: number;
  mergeProbeConcurrency?: number;
  saveFlows?: typeof saveFlows;
  now?: () => number;
}

export async function runReaperCycle(options: {
  registry?: AgentRegistry;
  hosts: TranscriptHost[];
  files: FileEntry[];
  now?: number;
  actuation?: ReaperActuationOverrides;
}): Promise<ReaperReport> {
  const registry = options.registry ?? agentRegistry();
  const now = options.now ?? Date.now();
  const state = updateObservationState(options.hosts, now);
  const report = evaluateReaper(await makeInput(registry, options.hosts, options.files, state, now, options.actuation));
  const completed = await runEvaluatedReaper(report, {
    actuate: (agent) => actuateCandidate(registry, options.files, state, agent, options.actuation),
    journal: appendJournal,
  });
  atomicWrite(REPORT_FILE(), completed);
  return completed;
}

export function readReaperReport(): ReaperReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(REPORT_FILE(), "utf8")) as ReaperReport;
    return parsed && Array.isArray(parsed.agents) ? parsed : null;
  } catch {
    return null;
  }
}

export async function buildReaperReportOnDemand(): Promise<ReaperReport> {
  const [files, hosts] = await Promise.all([listFiles(), readTranscriptHosts(true)]);
  return runReaperCycle({ hosts: hosts.hosts, files });
}
