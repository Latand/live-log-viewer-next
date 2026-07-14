import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentRegistry, type AgentRegistry, type RegistryFile, type TmuxHostEvidence } from "@/lib/agent/registry";
import { readTranscriptHosts, type TranscriptHost, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { boardFor } from "@/lib/board/store";
import { statePath } from "@/lib/configDir";
import { forEachCooperatively } from "@/lib/cooperative";
import { resolveFlowMergeIdentity } from "@/lib/flows/git";
import { loadFlows, saveFlows } from "@/lib/flows/store";
import type { Flow, FlowMergeEvidence } from "@/lib/flows/types";
import { reconcileMigrationInventory } from "@/lib/accounts/migration/coordinator";
import { procBackend } from "@/lib/proc";
import { listFiles } from "@/lib/scanner";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { scanUserAuthoredMessagesCooperatively } from "@/lib/session/reader";
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
  userAuthoredPaths: Record<string, true>;
  /* Path-scoped authorship freshness (issue #112). For every transcript the
     reaper has scanned to completion and found NOT owner-authored, the observed
     transcript mtime (seconds) at that scan. The board clears
     `authorshipUnverified` only when this per-path stamp is at least as fresh as
     the file's current mtime — a global "last cycle" timestamp would falsely
     certify a worker that exited before it was ever scanned, letting an
     unobserved user-authored transcript collapse. */
  scannedAt: Record<string, number>;
}

function hostKey(host: TranscriptHost): string {
  return `${host.paneId}:${host.agentPid}:${host.agentIdentity ?? "unknown"}`;
}

function readState(): ReaperState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as Partial<ReaperState>;
    if (parsed.version === 1 && parsed.firstObservedAt && typeof parsed.firstObservedAt === "object") {
      return {
        version: 1,
        firstObservedAt: parsed.firstObservedAt,
        userAuthoredPaths: parsed.userAuthoredPaths && typeof parsed.userAuthoredPaths === "object"
          ? parsed.userAuthoredPaths as Record<string, true>
          : {},
        scannedAt: parsed.scannedAt && typeof parsed.scannedAt === "object" && !Array.isArray(parsed.scannedAt)
          ? parsed.scannedAt as Record<string, number>
          : {},
      };
    }
  } catch { /* first run or invalid state */ }
  return { version: 1, firstObservedAt: {}, userAuthoredPaths: {}, scannedAt: {} };
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
  const state = {
    version: 1 as const,
    firstObservedAt,
    userAuthoredPaths: previous.userAuthoredPaths,
    scannedAt: previous.scannedAt,
  };
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
    if (!identity && fs.existsSync(flow.cwd)) {
      if (evidence?.mergedAt || evidence?.source) {
        evidence.mergedAt = null;
        evidence.checkedAt = null;
        evidence.source = null;
        markChanged(flow);
      }
      return;
    }
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

/* A HEADLESS reviewer is launched straight through the CLI (startHeadlessReview),
   not a Viewer spawn receipt, so its automated review instruction lands in the
   transcript as one user-role message that no launch/delivery allowance covers.
   Left uncounted, that single automated prompt would mark every finished headless
   reviewer owner-authored and pin it forever — the exact opposite of the
   immediate reviewer collapse #112 exists for. Grant the round's reviewer
   transcript one allowance for that startup prompt; a genuine owner message on
   top is the second and still trips the exemption.

   PANE reviewers are excluded: they launch through `spawnAgentWithPrompt`, whose
   completed worker receipt already grants the launch allowance via
   `hasViewerWorkerLaunchPrompt`. Adding a second allowance would let a pane
   reviewer carrying one automated prompt AND one genuine owner follow-up scan
   clean, collapsing an owner-touched card — a hard-constraint violation.

   The allowance is granted only with DETERMINISTIC launch provenance: the
   round's reviewer transcript basename must contain the round's own sessionId
   (claude pre-chooses it at spawn, codex reports it in the first event). A
   reviewerPath claimed by the same-CWD/latest-mtime heuristic
   (`maybeClaimReviewerPathByHeuristic`) can misattribute an owner-created
   transcript; discounting there would eat that owner's first genuine message.
   Absent/mismatched sessionId → no allowance → the automated prompt counts and
   the path stays protected (the safe side). */
function viewerReviewerLaunchAllowance(flows: Flow[], pathname: string): number {
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      if (round.reviewerPath !== pathname || !round.sessionId) continue;
      if (path.basename(pathname).includes(round.sessionId)) return 1;
    }
  }
  return 0;
}

/* A native subagent (a Claude `agent-*` session, or a Codex thread with a
   parent_thread_id) is spawned by its parent AGENT, not the owner, and its first
   turn is the parent's automated assignment — serialized as a user-role message
   with no Viewer receipt or flow delivery to cover it. Left uncounted, that one
   automated prompt marks every agent-spawned subtask owner-authored and pins it
   forever, so the spawned workers #112 targets never collapse. Provenance is
   deterministic from the scan entry (the `subagent` kind / native codex parent),
   so grant exactly one allowance for the assignment; a genuine owner message on
   top is the second and still trips the exemption. */
function viewerNativeSubagentAllowance(file: FileEntry | undefined): number {
  if (!file) return 0;
  if (file.root === "claude-projects" && file.kind === "subagent") return 1;
  if (file.root === "codex-sessions" && file.engine === "codex" && isNativeCodexSubagentTranscript(file.path, file.size)) return 1;
  return 0;
}

async function authorshipEvidence(
  snapshot: ReturnType<AgentRegistry["snapshot"]>,
  hosts: TranscriptHost[],
  flows: Flow[],
  files: FileEntry[],
  missingTranscriptPaths: ReadonlySet<string>,
  priorScannedAt: Record<string, number>,
): Promise<{
  userAuthoredPaths: Set<string>;
  unverifiedPaths: Set<string>;
  /* Path → observed transcript mtime (seconds) for every transcript scanned to
     completion and found NOT owner-authored. This is the path-scoped freshness
     the board needs to clear `authorshipUnverified` without falsely certifying
     an unscanned worker (issue #112). */
  verifiedCleanAt: Map<string, number>;
}> {
  const userAuthoredPaths = new Set<string>();
  const unverifiedPaths = new Set<string>();
  const verifiedCleanAt = new Map<string, number>();
  /* Authorship scanning cannot ride live host discovery alone: a finished
     headless reviewer is a detached process (never a tmux host) and an exited
     worker has no host at all, so those paths would never earn a clean stamp and
     the board would pin them unverified forever — defeating the immediate
     reviewer collapse central to #112. Cover every quiet claude/codex transcript
     the scan sees, in addition to the live hosts. A live file is skipped: it is
     board-exempt regardless and its mtime advances every write, so scanning it
     would churn without ever producing a usable stamp. */
  const fileByPath = new Map<string, FileEntry>();
  const targets = new Map<string, "claude" | "codex">();
  await forEachCooperatively(files, (file) => {
    fileByPath.set(file.path, file);
  });
  await forEachCooperatively(hosts, (host) => {
    if (host.primaryPath) targets.set(host.primaryPath, host.engine);
  });
  await forEachCooperatively(files, (file) => {
    if (file.engine !== "claude" && file.engine !== "codex") return;
    if (file.activity === "live" || targets.has(file.path)) return;
    /* Already clean-stamped at or past the current mtime — no need to re-scan;
       the persisted stamp still stands (the caller keeps prior state entries). */
    const stamp = priorScannedAt[file.path];
    if (stamp !== undefined && stamp >= file.mtime) return;
    targets.set(file.path, file.engine);
  });
  await forEachCooperatively([...targets], async ([pathname, engine]) => {
    if (userAuthoredPaths.has(pathname) || unverifiedPaths.has(pathname)) return;
    if (missingTranscriptPaths.has(pathname)) return;
    const viewerMessageAllowance = (hasViewerWorkerLaunchPrompt(snapshot, pathname) ? 1 : 0)
      + viewerFlowMessageAllowance(flows, pathname)
      + viewerReviewerLaunchAllowance(flows, pathname)
      + viewerNativeSubagentAllowance(fileByPath.get(pathname));
    /* Stamp the mtime BEFORE reading: a transcript that grows during the scan
       ends up with a newer on-disk mtime than we record, so the board re-pins it
       as unverified until the next cycle rather than certifying content the
       reaper never saw. */
    let observedMtime: number | null = null;
    try {
      observedMtime = fs.statSync(pathname).mtimeMs / 1000;
    } catch {
      unverifiedPaths.add(pathname);
      return;
    }
    const scan = await scanUserAuthoredMessagesCooperatively(pathname, engine, viewerMessageAllowance + 1);
    if (scan.count > viewerMessageAllowance) userAuthoredPaths.add(pathname);
    else if (!scan.complete) unverifiedPaths.add(pathname);
    else verifiedCleanAt.set(pathname, observedMtime);
  });
  return { userAuthoredPaths, unverifiedPaths, verifiedCleanAt };
}

function viewerOwnedPaths(snapshot: ReturnType<AgentRegistry["snapshot"]>, hosts: TranscriptHost[]): Set<string> {
  return new Set(hosts.flatMap((host) =>
    host.primaryPath && hasViewerWorkerLaunchPrompt(snapshot, host.primaryPath) ? [host.primaryPath] : []));
}

function manualPaths(snapshot: ReturnType<AgentRegistry["snapshot"]>, hosts: TranscriptHost[], files: FileEntry[]): Set<string> {
  const filesByPath = new Map(files.map((entry) => [entry.path, entry]));
  const protectedPaths = new Set<string>();
  const placementsByProject = new Map<string, ReadonlySet<string>>();
  for (const host of hosts) {
    const pathname = host.primaryPath;
    if (!pathname) continue;
    const project = filesByPath.get(pathname)?.project || profileForPath(snapshot, pathname)?.project;
    if (!project) continue;
    try {
      let placements = placementsByProject.get(project);
      if (!placements) {
        placements = new Set(boardFor(project).explicitManual ?? []);
        placementsByProject.set(project, placements);
      }
      if (placements.has(pathname)) protectedPaths.add(pathname);
    } catch {
      protectedPaths.add(pathname);
    }
  }
  return protectedPaths;
}

async function refreshLifecycle(registry: AgentRegistry): Promise<FileEntry[]> {
  const files = await listFiles();
  await reconcileMigrationInventory(registry, files);
  return files;
}

function evidenceFor(
  host: TranscriptHost,
  processIdentity: (pid: number) => string | null = (pid) => procBackend.processIdentity(pid),
): TmuxHostEvidence {
  return {
    kind: "tmux",
    endpoint: tmuxEndpoint(),
    server: { pid: host.tmuxServerPid, startIdentity: processIdentity(host.tmuxServerPid) },
    paneId: host.paneId,
    panePid: { pid: host.panePid, startIdentity: processIdentity(host.panePid) },
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
  const flows = (overrides.loadFlows ?? loadFlows)();
  const processIdentity = overrides.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const mergedFlowIds = await refreshMergedFlowIds(flows, overrides);
  const snapshot = registry.snapshot();
  const missingTranscriptPaths = new Set(hosts.flatMap((host) =>
    host.primaryPath && !fs.existsSync(host.primaryPath) ? [host.primaryPath] : []));
  const authorship = await authorshipEvidence(snapshot, hosts, flows, files, missingTranscriptPaths, state.scannedAt);
  let stateChanged = false;
  for (const pathname of authorship.userAuthoredPaths) {
    if (state.userAuthoredPaths[pathname]) continue;
    state.userAuthoredPaths[pathname] = true;
    stateChanged = true;
  }
  for (const [pathname, observedMtime] of authorship.verifiedCleanAt) {
    if (state.scannedAt[pathname] === observedMtime) continue;
    state.scannedAt[pathname] = observedMtime;
    stateChanged = true;
  }
  if (stateChanged) atomicWrite(STATE_FILE(), state);
  const protectedAuthorship = new Set([
    ...authorship.userAuthoredPaths,
    ...hosts.flatMap((host) => host.primaryPath && state.userAuthoredPaths[host.primaryPath] ? [host.primaryPath] : []),
  ]);
  return {
    now,
    registry: snapshot,
    hosts,
    tmuxEvidenceByHost: new Map(hosts.map((host) => [hostKey(host), evidenceFor(host, processIdentity)])),
    reviewerProcesses: observeHeadlessReviewers(flows, overrides),
    viewerOwnedPaths: viewerOwnedPaths(snapshot, hosts),
    authorshipUnverifiedPaths: authorship.unverifiedPaths,
    files,
    flows,
    manualPaths: manualPaths(snapshot, hosts, files),
    userAuthoredPaths: protectedAuthorship,
    missingTranscriptPaths,
    mergedFlowIds,
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

function sameTmuxEvidence(left: TmuxHostEvidence, right: TmuxHostEvidence): boolean {
  return left.kind === right.kind
    && left.endpoint === right.endpoint
    && left.server.pid === right.server.pid
    && left.server.startIdentity === right.server.startIdentity
    && left.paneId === right.paneId
    && left.panePid.pid === right.panePid.pid
    && left.panePid.startIdentity === right.panePid.startIdentity
    && left.windowName === right.windowName
    && left.agent.pid === right.agent.pid
    && left.agent.startIdentity === right.agent.startIdentity
    && left.argv.length === right.argv.length
    && left.argv.every((argument, index) => argument === right.argv[index]);
}

function completeTmuxEvidence(evidence: TmuxHostEvidence): boolean {
  return evidence.server.startIdentity !== null
    && evidence.panePid.startIdentity !== null
    && evidence.agent.startIdentity !== null;
}

function hostMatchesCandidate(
  host: TranscriptHost,
  candidate: ReaperAgentReport,
  processIdentity: (pid: number) => string | null,
): boolean {
  return candidate.targetKind === "tmux"
    && candidate.tmuxEvidence !== null
    && sameTmuxEvidence(evidenceFor(host, processIdentity), candidate.tmuxEvidence)
    && host.primaryPath === candidate.path;
}

function reportMatchesCandidate(current: ReaperAgentReport, expected: ReaperAgentReport): boolean {
  return current.targetKind === "tmux"
    && current.paneId === expected.paneId
    && current.panePid === expected.panePid
    && current.agentPid === expected.agentPid
    && current.processIdentity === expected.processIdentity
    && current.path === expected.path
    && current.tmuxEvidence !== null
    && expected.tmuxEvidence !== null
    && sameTmuxEvidence(current.tmuxEvidence, expected.tmuxEvidence);
}

function deliveryRevision(snapshot: RegistryFile, conversationId: string | null): string {
  if (!conversationId) return "";
  const deliveries = Object.values(snapshot.heldDeliveries)
    .filter((delivery) => delivery.conversationId === conversationId)
    .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify(deliveries);
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
  const expectedEvidence = agent.tmuxEvidence;
  if (paneId === null || !expectedEvidence || !completeTmuxEvidence(expectedEvidence)) return false;
  const observeHosts = overrides.readHosts ?? readTranscriptHosts;
  const killHost = overrides.kill ?? killTmuxHostIfMatches;
  const currentTime = overrides.now ?? Date.now;
  const processIdentity = overrides.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const initialHost = (await observeHosts(true)).hosts.find((host) => hostMatchesCandidate(host, agent, processIdentity));
  if (!initialHost?.primaryPath) return false;
  const entry = Object.values(registry.snapshot().entries).find((candidate) => candidate.artifactPath === agent.path);
  if (!entry) return false;
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  return registry.withOperationLock(entry.key, owner, async () => {
    const claimOwner = `reaper:${crypto.randomUUID()}`;
    try {
      registry.claim(entry.key, claimOwner);
      const freshSnapshot: TranscriptHostSnapshot = await observeHosts(true);
      const freshHost = freshSnapshot.hosts.find((host) => hostMatchesCandidate(host, agent, processIdentity));
      if (!freshHost) return false;
      const lifecycleFiles = await (overrides.refreshLifecycle ?? refreshLifecycle)(registry);
      const currentInput = await makeInput(registry, freshSnapshot.hosts, lifecycleFiles, state, currentTime(), overrides);
      const current = evaluateReaper(currentInput);
      const candidate = current.agents.find((item) => reportMatchesCandidate(item, agent));
      if (!candidate?.eligible) return false;
      if (deliveryRevision(registry.snapshot(), candidate.conversationId)
        !== deliveryRevision(currentInput.registry, candidate.conversationId)) return false;
      const killed = await killHost(expectedEvidence);
      const registeredHost = registry.snapshot().entries[`${entry.key.engine}:${entry.key.sessionId}`]?.host;
      if (killed && registeredHost && sameTmuxEvidence(registeredHost, expectedEvidence)) {
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
  refreshLifecycle?: typeof refreshLifecycle;
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
