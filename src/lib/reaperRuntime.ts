import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentRegistry, type AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { readTranscriptHosts, type TranscriptHost, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { boardFor } from "@/lib/board/store";
import { statePath } from "@/lib/configDir";
import { loadFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { procBackend } from "@/lib/proc";
import { listFiles } from "@/lib/scanner";
import { readSession } from "@/lib/session/reader";
import { killTmuxHostIfMatches, tmuxEndpoint } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import { evaluateReaper, runEvaluatedReaper, type ReaperInput, type ReaperJournalRecord, type ReaperReport } from "./reaper";

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

function branchContainsHead(flow: Flow): boolean {
  for (const branch of ["origin/main", "origin/master", "main", "master"]) {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", branch], { cwd: flow.cwd, stdio: "ignore" });
    if (result.status === 0) return true;
  }
  return false;
}

function profileForPath(snapshot: ReturnType<AgentRegistry["snapshot"]>, pathname: string) {
  return Object.values(snapshot.entries).find((entry) => entry.artifactPath === pathname)?.launchProfile
    ?? Object.values(snapshot.conversations)
      .flatMap((conversation) => conversation.generations)
      .find((generation) => generation.path === pathname)?.launchProfile
    ?? null;
}

function userAuthoredPaths(snapshot: ReturnType<AgentRegistry["snapshot"]>, hosts: TranscriptHost[]): Set<string> {
  const protectedPaths = new Set<string>();
  for (const host of hosts) {
    const pathname = host.primaryPath;
    if (!pathname || protectedPaths.has(pathname) || !fs.existsSync(pathname)) continue;
    const profile = profileForPath(snapshot, pathname);
    const count = readSession(pathname, host.engine).messages.filter((message) => message.role === "user").length;
    const launchPromptAllowance = profile?.role === "worker" ? 1 : 0;
    if (count > launchPromptAllowance) protectedPaths.add(pathname);
  }
  return protectedPaths;
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

function makeInput(
  registry: AgentRegistry,
  hosts: TranscriptHost[],
  files: FileEntry[],
  state: ReaperState,
  now: number,
): ReaperInput {
  const snapshot = registry.snapshot();
  const flows = loadFlows();
  return {
    now,
    registry: snapshot,
    hosts,
    files,
    flows,
    manualPaths: manualPaths(snapshot, hosts, files),
    userAuthoredPaths: userAuthoredPaths(snapshot, hosts),
    missingTranscriptPaths: new Set(hosts.flatMap((host) =>
      host.primaryPath && !fs.existsSync(host.primaryPath) ? [host.primaryPath] : [])),
    mergedFlowIds: new Set(flows.filter(branchContainsHead).map((flow) => flow.id)),
    firstObservedAt: state.firstObservedAt,
    enabled: process.env.LLV_REAPER_ENABLED === "1",
  };
}

async function actuateCandidate(
  registry: AgentRegistry,
  files: FileEntry[],
  state: ReaperState,
  paneId: string,
): Promise<boolean> {
  const initialHost = (await readTranscriptHosts(true)).hosts.find((host) => host.paneId === paneId);
  if (!initialHost?.primaryPath) return false;
  const entry = Object.values(registry.snapshot().entries).find((candidate) => candidate.artifactPath === initialHost.primaryPath);
  if (!entry) return false;
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  return registry.withOperationLock(entry.key, owner, async () => {
    const claimOwner = `reaper:${crypto.randomUUID()}`;
    try {
      registry.claim(entry.key, claimOwner);
      const freshSnapshot: TranscriptHostSnapshot = await readTranscriptHosts(true);
      const freshHost = freshSnapshot.hosts.find((host) =>
        host.paneId === paneId
        && host.agentPid === initialHost.agentPid
        && host.agentIdentity === initialHost.agentIdentity
        && host.primaryPath === initialHost.primaryPath);
      if (!freshHost) return false;
      const current = evaluateReaper(makeInput(registry, freshSnapshot.hosts, refreshFileTimes(files), state, Date.now()));
      const candidate = current.agents.find((agent) => agent.paneId === paneId);
      if (!candidate?.eligible) return false;
      const killed = await killTmuxHostIfMatches(evidenceFor(freshHost));
      if (killed && registry.snapshot().entries[`${entry.key.engine}:${entry.key.sessionId}`]?.host?.paneId === paneId) {
        registry.markUnhosted(entry.key);
      }
      return killed;
    } finally {
      registry.releaseClaim(entry.key, claimOwner);
    }
  });
}

export async function runReaperCycle(options: {
  registry?: AgentRegistry;
  hosts: TranscriptHost[];
  files: FileEntry[];
  now?: number;
}): Promise<ReaperReport> {
  const registry = options.registry ?? agentRegistry();
  const now = options.now ?? Date.now();
  const state = updateObservationState(options.hosts, now);
  const report = evaluateReaper(makeInput(registry, options.hosts, options.files, state, now));
  const completed = await runEvaluatedReaper(report, {
    actuate: (agent) => actuateCandidate(registry, options.files, state, agent.paneId),
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
