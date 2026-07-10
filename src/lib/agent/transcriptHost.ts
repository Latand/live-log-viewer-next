import type { ResumeSpec } from "@/lib/agent/cli";
import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { listFiles } from "@/lib/scanner";
import { agentProcesses, argvEngine, pidAlive, readArgv, readPpid, type AgentProcess } from "@/lib/scanner/process";
import {
  panePidMap,
  panePidOf,
  rememberResumePane,
  resumePaneRecords,
  sendText,
  spawnAgentWithPrompt,
  tmuxServerPid,
  type PaneRef,
  type PaneObservation,
  type SpawnedPane,
} from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_ANCESTRY_HOPS = 64;

type ClaimSource = "scanner" | "resume" | "argv";

const CLAIM_RANK: Record<ClaimSource, number> = {
  scanner: 3,
  resume: 2,
  argv: 1,
};

export interface TranscriptHost {
  tmuxServerPid: number;
  paneId: string;
  panePid: number;
  agentPid: number;
  display: string;
  engine: "claude" | "codex";
  cwd: string;
  /** argv observed with this pid; detects a pid that was recycled between
      observation and delivery. */
  agentArgv: string[];
  /** Linux process start tick when available; keeps pid reuse from inheriting
      a former agent's host claim. */
  agentIdentity: string | null;
  claimedPaths: string[];
  primaryPath: string | null;
}

export interface TranscriptHostSnapshot {
  hosts: TranscriptHost[];
  observation: "available" | "no-server" | "failure";
  observationError?: string;
  canonicalFor(pathname: string): TranscriptHost | null;
}

/** Display target exposed by resource observation and route lookup for one
    canonical transcript host. Actions keep using the host's stable pane id. */
export function canonicalTranscriptTarget(snapshot: TranscriptHostSnapshot, pathname: string): string | null {
  return snapshot.canonicalFor(pathname)?.display ?? null;
}

export type HostDeliveryOutcome =
  | { ok: true; outcome: "delivered-to-live"; target: string }
  | { ok: true; outcome: "resumed"; target: string }
  | { ok: false; outcome: "failed"; error: string; status: number };

export interface TranscriptHostResolver {
  readTranscriptHosts(fresh?: boolean): Promise<TranscriptHostSnapshot>;
  deliverToTranscriptHost(input: { entry: FileEntry; spec: ResumeSpec; payload: string }): Promise<HostDeliveryOutcome>;
}

const globalStore = globalThis as unknown as {
  __llvTranscriptHostDecisions?: Map<string, Promise<Decision>>;
};

interface HostDependencies {
  listFiles: () => Promise<FileEntry[]>;
  panes: (fresh: boolean) => Promise<PaneObservation>;
  ppidMap: () => Map<number, number>;
  agents: (fresh: boolean) => AgentProcess[];
  serverPid: () => Promise<number | null>;
  resumeRecords: () => ReturnType<typeof resumePaneRecords>;
  panePid: (paneId: string) => Promise<number | null>;
  alive: (pid: number) => boolean;
  argv: (pid: number) => string[];
  parentPid: (pid: number) => number | null;
  identity: (pid: number) => string | null;
  spawn: (spec: ResumeSpec, text: string) => Promise<SpawnedPane>;
  remember: (pathname: string, spec: ResumeSpec, pane: SpawnedPane) => Promise<void>;
  deliver: (paneId: string, text: string) => Promise<void>;
}

interface HostClaim {
  pathname: string;
  source: ClaimSource;
}

interface ObservedHost extends TranscriptHost {
  claims: HostClaim[];
}

interface Decision {
  host: TranscriptHost;
  resumed: boolean;
}

function sessionUuid(pathname: string): string | null {
  return pathname.slice(pathname.lastIndexOf("/") + 1).match(UUID_RE)?.[0]?.toLowerCase() ?? null;
}

function argvSessionUuid(argv: string[]): string | null {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const id = argv[index]?.match(UUID_RE)?.[0];
    if (id) return id.toLowerCase();
  }
  return null;
}

function paneNumber(paneId: string): number {
  const value = Number(paneId.slice(1));
  return Number.isInteger(value) ? value : -1;
}

function rootEntryByPid(entries: FileEntry[]): Map<number, FileEntry> {
  const byPid = new Map<number, FileEntry>();
  for (const entry of entries) {
    if (entry.pid === null || entry.proc !== "running") continue;
    const current = byPid.get(entry.pid);
    if (!current || (current.parent && !entry.parent)) byPid.set(entry.pid, entry);
  }
  return byPid;
}

function rootEntryByUuid(entries: FileEntry[]): Map<string, FileEntry> {
  const byUuid = new Map<string, FileEntry>();
  for (const entry of entries) {
    const uuid = sessionUuid(entry.path);
    if (!uuid) continue;
    const current = byUuid.get(uuid);
    if (!current || (current.parent && !entry.parent)) byUuid.set(uuid, entry);
  }
  return byUuid;
}

function claimsForAgent(
  agent: AgentProcess,
  pane: PaneRef,
  panePid: number,
  entriesByPid: Map<number, FileEntry>,
  entriesByUuid: Map<string, FileEntry>,
  records: Awaited<ReturnType<typeof resumePaneRecords>>,
): HostClaim[] {
  const claims: HostClaim[] = [];
  const direct = entriesByPid.get(agent.pid);
  if (direct?.engine === agent.engine) claims.push({ pathname: direct.path, source: "scanner" });

  if (records) {
    for (const [pathname, record] of records.records) {
      if (
        record.paneId === pane.paneId &&
        record.panePid === panePid &&
        record.engine === agent.engine
      ) {
        claims.push({ pathname, source: "resume" });
      }
    }
  }

  const byArgv = argvSessionUuid(agent.argv);
  const matched = byArgv ? entriesByUuid.get(byArgv) : undefined;
  if (matched?.engine === agent.engine) claims.push({ pathname: matched.path, source: "argv" });
  return claims;
}

function primaryClaim(claims: HostClaim[]): HostClaim | null {
  return [...claims].sort((left, right) => CLAIM_RANK[right.source] - CLAIM_RANK[left.source] || left.pathname.localeCompare(right.pathname))[0] ?? null;
}

function canonicalFrom(hosts: ObservedHost[], pathname: string): TranscriptHost | null {
  const candidates = hosts
    .map((host) => ({ host, claim: host.claims.filter((claim) => claim.pathname === pathname).sort((a, b) => CLAIM_RANK[b.source] - CLAIM_RANK[a.source])[0] }))
    .filter((candidate): candidate is { host: ObservedHost; claim: HostClaim } => candidate.claim !== undefined)
    .sort(
      (left, right) =>
        CLAIM_RANK[right.claim.source] - CLAIM_RANK[left.claim.source] ||
        paneNumber(right.host.paneId) - paneNumber(left.host.paneId),
    );
  return candidates[0]?.host ?? null;
}

function isDescendantOf(pid: number, ancestor: number, parentPid: (pid: number) => number | null): boolean {
  const seen = new Set<number>();
  let cursor: number | null = pid;
  for (let hops = 0; cursor !== null && hops < MAX_ANCESTRY_HOPS; hops += 1) {
    if (cursor === ancestor) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = parentPid(cursor);
  }
  return false;
}

function failure(error: unknown, status = 500): HostDeliveryOutcome {
  return { ok: false, outcome: "failed", error: error instanceof Error ? error.message : String(error), status };
}

function processIdentity(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = raw.lastIndexOf(")");
    const fields = raw.slice(closing + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks ? `${pid}:${startTicks}` : null;
  } catch {
    return null;
  }
}

/**
 * Creates the deep transcript-host module. The optional dependencies form a
 * test seam; production callers use the singleton below and only learn the
 * two operational methods exported at the end of this file.
 */
export function createTranscriptHostResolver(
  dependencies: HostDependencies,
  decisions = new Map<string, Promise<Decision>>(),
): TranscriptHostResolver {

  async function observe(fresh: boolean): Promise<TranscriptHostSnapshot> {
    const [entries, paneObservation, records] = await Promise.all([dependencies.listFiles(), dependencies.panes(fresh), dependencies.resumeRecords()]);
    const serverPid = records?.serverPid ?? (await dependencies.serverPid());
    if (paneObservation.kind === "failure" && serverPid !== null) {
      return { hosts: [], observation: "failure", observationError: paneObservation.error, canonicalFor: () => null };
    }
    if (serverPid === null || paneObservation.kind === "no-server") {
      return { hosts: [], observation: "no-server", canonicalFor: () => null };
    }
    if (paneObservation.kind !== "available" || paneObservation.panes.size === 0) {
      return { hosts: [], observation: "available", canonicalFor: () => null };
    }
    const { panes } = paneObservation;

    const ppids = dependencies.ppidMap();
    const agents = dependencies.agents(fresh);
    const byPid = rootEntryByPid(entries);
    const byUuid = rootEntryByUuid(entries);
    const hosts: ObservedHost[] = [];

    for (const [panePid, pane] of panes) {
      const tree = new Set(descendantPids(panePid, ppids));
      for (const agent of agents) {
        if (!tree.has(agent.pid)) continue;
        const claims = claimsForAgent(agent, pane, panePid, byPid, byUuid, records);
        const primary = primaryClaim(claims);
        hosts.push({
          tmuxServerPid: serverPid,
          paneId: pane.paneId,
          panePid,
          agentPid: agent.pid,
          display: pane.target,
          engine: agent.engine,
          cwd: agent.cwd,
          agentArgv: [...agent.argv],
          agentIdentity: dependencies.identity(agent.pid),
          claimedPaths: [...new Set(claims.map((claim) => claim.pathname))],
          primaryPath: primary?.pathname ?? null,
          claims,
        });
      }
    }

    return {
      hosts,
      observation: "available",
      canonicalFor: (pathname: string) => canonicalFrom(hosts, pathname),
    };
  }

  async function revalidate(host: TranscriptHost, entry: FileEntry): Promise<boolean> {
    if (host.engine !== entry.engine || (await dependencies.serverPid()) !== host.tmuxServerPid) return false;
    if ((await dependencies.panePid(host.paneId)) !== host.panePid || !dependencies.alive(host.agentPid)) return false;
    if (!isDescendantOf(host.agentPid, host.panePid, dependencies.parentPid)) return false;
    const argv = dependencies.argv(host.agentPid);
    if (argv.length !== host.agentArgv.length || argv.some((value, index) => value !== host.agentArgv[index])) return false;
    if (host.agentIdentity !== null && dependencies.identity(host.agentPid) !== host.agentIdentity) return false;
    if (argvEngine(argv) !== host.engine) return false;
    const uuid = sessionUuid(entry.path);
    const ownsTranscript = entry.pid === host.agentPid || (uuid !== null && argvSessionUuid(argv) === uuid);
    return ownsTranscript && host.claimedPaths.includes(entry.path);
  }

  async function decide(input: { entry: FileEntry; spec: ResumeSpec }): Promise<Decision> {
    let snapshot = await observe(true);
    if (snapshot.observation === "failure") throw new Error(`tmux pane observation failed: ${snapshot.observationError}`);
    let host = snapshot.canonicalFor(input.entry.path);
    if (host && (await revalidate(host, input.entry))) return { host, resumed: false };

    const rejectedHost = host;

    /* The snapshot can tear while tmux or a process exits. One fresh pass
       closes that race before a controlled resume is allowed. */
    snapshot = await observe(true);
    if (snapshot.observation === "failure") throw new Error(`tmux pane observation failed: ${snapshot.observationError}`);
    host = snapshot.canonicalFor(input.entry.path);
    /* A PID that changed process identity in the same pane slot can be a
       recycled scanner claim for another conversation. The fresh observation
       is useful for ordinary races; an identity replacement stays unsafe and
       receives one controlled resume instead of a blind send. */
    const identityReplaced =
      host !== null &&
      rejectedHost !== null &&
      host.paneId === rejectedHost.paneId &&
      host.agentPid === rejectedHost.agentPid &&
      host.agentIdentity !== null &&
      rejectedHost.agentIdentity !== null &&
      host.agentIdentity !== rejectedHost.agentIdentity;
    if (host && !identityReplaced && (await revalidate(host, input.entry))) return { host, resumed: false };

    const spawned = await dependencies.spawn(input.spec, "");
    await dependencies.remember(input.entry.path, input.spec, spawned);
    snapshot = await observe(true);
    if (snapshot.observation === "failure") throw new Error(`tmux pane observation failed: ${snapshot.observationError}`);
    host = snapshot.canonicalFor(input.entry.path);
    if (!host || !(await revalidate(host, input.entry))) {
      throw new Error("resumed agent host could not be identified safely");
    }
    return { host, resumed: true };
  }

  function joinDecision(input: { entry: FileEntry; spec: ResumeSpec }): { owner: boolean; task: Promise<Decision> } {
    const existing = decisions.get(input.entry.path);
    if (existing) return { owner: false, task: existing };
    const task = decide(input).finally(() => decisions.delete(input.entry.path));
    decisions.set(input.entry.path, task);
    return { owner: true, task };
  }

  return {
    readTranscriptHosts: observe,
    async deliverToTranscriptHost(input): Promise<HostDeliveryOutcome> {
      let owner = false;
      let resumed = false;
      let decision: Decision;
      try {
        const joined = joinDecision(input);
        owner = joined.owner;
        decision = await joined.task;
        resumed = decision.resumed;
      } catch (error) {
        return failure(error);
      }

      /* A host can disappear after the shared decision completes. Re-entering
         the same keyed decision gives all callers one fresh recovery attempt. */
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!(await revalidate(decision.host, input.entry))) {
          try {
            const retry = joinDecision(input);
            decision = await retry.task;
            owner ||= retry.owner;
            resumed ||= decision.resumed;
            continue;
          } catch (error) {
            return failure(error);
          }
        }
        try {
          await dependencies.deliver(decision.host.paneId, input.payload);
          return {
            ok: true,
            outcome: owner && resumed ? "resumed" : "delivered-to-live",
            target: decision.host.display,
          };
        } catch (error) {
          if (attempt === 1) return failure(error);
          try {
            const retry = joinDecision(input);
            decision = await retry.task;
            owner ||= retry.owner;
            resumed ||= decision.resumed;
          } catch (retryError) {
            return failure(retryError);
          }
        }
      }
      return failure("agent host became unavailable during delivery");
    },
  };
}

const runtimeResolver = createTranscriptHostResolver({
  listFiles,
  panes: panePidMap,
  ppidMap: () => procBackend.ppidMap(),
  agents: agentProcesses,
  serverPid: tmuxServerPid,
  resumeRecords: resumePaneRecords,
  panePid: panePidOf,
  alive: pidAlive,
  argv: readArgv,
  parentPid: readPpid,
  identity: processIdentity,
  spawn: spawnAgentWithPrompt,
  remember: rememberResumePane,
  deliver: sendText,
}, globalStore.__llvTranscriptHostDecisions ??= new Map());

export const readTranscriptHosts = runtimeResolver.readTranscriptHosts;
export const deliverToTranscriptHost = runtimeResolver.deliverToTranscriptHost;
