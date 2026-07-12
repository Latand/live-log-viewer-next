import type { ResumeSpec } from "@/lib/agent/cli";
import { agentRegistry, type SpawnReceipt, type TmuxHostEvidence } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { listFiles } from "@/lib/scanner";
import { agentProcesses, argvEngine, pidAlive, readArgv, readPpid, type AgentProcess } from "@/lib/scanner/process";
import {
  panePidMap,
  panePidOf,
  paneInfo,
  paneLaunchId,
  rememberResumePane,
  resumePaneRecords,
  sendText,
  spawnAgentWithPrompt,
  tmuxEndpoint,
  tmuxServerPid,
  TmuxDeliveryUncertainError,
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
  windowName?: string;
  engine: "claude" | "codex";
  cwd: string;
  /** argv observed with this pid; detects a pid that was recycled between
      observation and delivery. */
  agentArgv: string[];
  /** Linux process start tick when available; keeps pid reuse from inheriting
      a former agent's host claim. */
  agentIdentity: string | null;
  /** Exact receipt correlation read from tmux pane-local state. */
  launchId: string | null;
  claimedPaths: string[];
  primaryPath: string | null;
}

export interface TranscriptHostSnapshot {
  hosts: TranscriptHost[];
  observation: "available" | "no-server" | "failure";
  observationError?: string;
  conflicts?: TranscriptHostConflict[];
  canonicalFor(pathname: string): TranscriptHost | null;
}

export interface TranscriptHostConflict {
  conversationId: string | null;
  paths: string[];
  paneIds: string[];
  quarantinedPaneIds?: string[];
}

/** Display target exposed by resource observation and route lookup for one
    canonical transcript host. Actions keep using the host's stable pane id. */
export function canonicalTranscriptTarget(snapshot: TranscriptHostSnapshot, pathname: string): string | null {
  return snapshot.canonicalFor(pathname)?.display ?? null;
}

export type HostDeliveryOutcome =
  | { ok: true; outcome: "delivered-to-live"; target: string }
  | { ok: true; outcome: "resumed"; target: string }
  | { ok: false; outcome: "failed"; error: string; status: number; actuation?: "started" };

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
  paneWindowName?: (paneId: string) => Promise<string | null>;
  alive: (pid: number) => boolean;
  argv: (pid: number) => string[];
  parentPid: (pid: number) => number | null;
  identity: (pid: number) => string | null;
  spawn: (spec: ResumeSpec, text: string, receipt?: SpawnReceipt) => Promise<SpawnedPane>;
  beginResume?: (entry: FileEntry, spec: ResumeSpec) => SpawnReceipt | null;
  remember: (pathname: string, spec: ResumeSpec, pane: SpawnedPane) => Promise<void>;
  deliver: (paneId: string, text: string) => Promise<void>;
  launchId?: (paneId: string) => Promise<string | null>;
  conversationIdForPath?: (pathname: string) => string | null;
  reconcile?: (hosts: TranscriptHost[]) => HostReconciliation | void | Promise<HostReconciliation | void>;
  serializeDelivery?: (entry: FileEntry, task: () => Promise<HostDeliveryOutcome>) => Promise<HostDeliveryOutcome>;
}

interface HostReconciliation {
  quarantinedPaneIds: string[];
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

function hostConflicts(
  hosts: ObservedHost[],
  conversationIdForPath: (pathname: string) => string | null,
  quarantinedPaneIds = new Set<string>(),
): TranscriptHostConflict[] {
  const groups = new Map<string, { conversationId: string | null; paths: Set<string>; paneIds: Set<string>; quarantinedPaneIds: Set<string> }>();
  for (const host of hosts) {
    const paths = new Set(host.claims.map((claim) => claim.pathname));
    const conversationIds = [...new Set([...paths].map(conversationIdForPath).filter((value): value is string => value !== null))];
    const keys = conversationIds.length > 0 ? conversationIds.map((id) => `conversation:${id}`) : [...paths].map((pathname) => `path:${pathname}`);
    for (const key of keys) {
      const conversationId = key.startsWith("conversation:") ? key.slice("conversation:".length) : null;
      const group = groups.get(key) ?? { conversationId, paths: new Set<string>(), paneIds: new Set<string>(), quarantinedPaneIds: new Set<string>() };
      for (const pathname of paths) group.paths.add(pathname);
      group.paneIds.add(host.paneId);
      if (quarantinedPaneIds.has(host.paneId)) group.quarantinedPaneIds.add(host.paneId);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.paneIds.size > 1 || group.quarantinedPaneIds.size > 0)
    .map((group) => ({
      conversationId: group.conversationId,
      paths: [...group.paths].sort(),
      paneIds: [...group.paneIds].sort((left, right) => paneNumber(left) - paneNumber(right)),
      ...(group.quarantinedPaneIds.size > 0
        ? { quarantinedPaneIds: [...group.quarantinedPaneIds].sort((left, right) => paneNumber(left) - paneNumber(right)) }
        : {}),
    }))
    .sort((left, right) => (left.conversationId ?? left.paths[0] ?? "").localeCompare(right.conversationId ?? right.paths[0] ?? ""));
}

function conflictForPath(snapshot: TranscriptHostSnapshot, pathname: string, conversationIdForPath: (pathname: string) => string | null): TranscriptHostConflict | null {
  const conversationId = conversationIdForPath(pathname);
  return snapshot.conflicts?.find((conflict) =>
    (conversationId !== null && conflict.conversationId === conversationId) || conflict.paths.includes(pathname)) ?? null;
}

class TranscriptHostConflictError extends Error {
  constructor(conflict: TranscriptHostConflict) {
    super(conflict.quarantinedPaneIds?.length ? "conversation has a quarantined live pane" : "conversation has multiple live panes");
    this.name = "TranscriptHostConflictError";
  }
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

function failure(error: unknown, status = 500, actuation?: "started"): HostDeliveryOutcome {
  const resolvedStatus = error instanceof TranscriptHostConflictError ? 409 : status;
  return { ok: false, outcome: "failed", error: error instanceof Error ? error.message : String(error), status: resolvedStatus, ...(actuation ? { actuation } : {}) };
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
    const conversationIdForPath = dependencies.conversationIdForPath ?? (() => null);
    const [entries, paneObservation, records] = await Promise.all([dependencies.listFiles(), dependencies.panes(fresh), dependencies.resumeRecords()]);
    const serverPid = records?.serverPid ?? (await dependencies.serverPid());
    if (paneObservation.kind === "failure" && serverPid !== null) {
      return { hosts: [], observation: "failure", observationError: paneObservation.error, conflicts: [], canonicalFor: () => null };
    }
    if (serverPid === null || paneObservation.kind === "no-server") {
      await dependencies.reconcile?.([]);
      return { hosts: [], observation: "no-server", conflicts: [], canonicalFor: () => null };
    }
    if (paneObservation.kind !== "available" || paneObservation.panes.size === 0) {
      await dependencies.reconcile?.([]);
      return { hosts: [], observation: "available", conflicts: [], canonicalFor: () => null };
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
          windowName: pane.windowName ?? "",
          engine: agent.engine,
          cwd: agent.cwd,
          agentArgv: [...agent.argv],
          agentIdentity: dependencies.identity(agent.pid),
          launchId: dependencies.launchId ? await dependencies.launchId(pane.paneId) : null,
          claimedPaths: [...new Set(claims.map((claim) => claim.pathname))],
          primaryPath: primary?.pathname ?? null,
          claims,
        });
      }
    }

    const reconciliation = await dependencies.reconcile?.(hosts);
    const quarantinedPaneIds = new Set(reconciliation?.quarantinedPaneIds ?? []);
    const eligibleHosts = hosts.filter((host) => !quarantinedPaneIds.has(host.paneId));

    const conflicts = hostConflicts(hosts, conversationIdForPath, quarantinedPaneIds);
    const snapshot: TranscriptHostSnapshot = {
      hosts,
      observation: "available",
      conflicts,
      canonicalFor: (pathname: string) => conflictForPath(snapshot, pathname, conversationIdForPath) ? null : canonicalFrom(eligibleHosts, pathname),
    };
    return snapshot;
  }

  async function revalidate(host: TranscriptHost, entry: FileEntry): Promise<boolean> {
    if (host.engine !== entry.engine || (await dependencies.serverPid()) !== host.tmuxServerPid) return false;
    if ((await dependencies.panePid(host.paneId)) !== host.panePid || !dependencies.alive(host.agentPid)) return false;
    if (host.windowName && dependencies.paneWindowName && (await dependencies.paneWindowName(host.paneId)) !== host.windowName) return false;
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
    const conversationIdForPath = dependencies.conversationIdForPath ?? (() => null);
    let snapshot = await observe(true);
    if (snapshot.observation === "failure") throw new Error(`tmux pane observation failed: ${snapshot.observationError}`);
    const initialConflict = conflictForPath(snapshot, input.entry.path, conversationIdForPath);
    if (initialConflict) throw new TranscriptHostConflictError(initialConflict);
    let host = snapshot.canonicalFor(input.entry.path);
    if (host && (await revalidate(host, input.entry))) return { host, resumed: false };

    const rejectedHost = host;

    /* The snapshot can tear while tmux or a process exits. One fresh pass
       closes that race before a controlled resume is allowed. */
    snapshot = await observe(true);
    if (snapshot.observation === "failure") throw new Error(`tmux pane observation failed: ${snapshot.observationError}`);
    const refreshedConflict = conflictForPath(snapshot, input.entry.path, conversationIdForPath);
    if (refreshedConflict) throw new TranscriptHostConflictError(refreshedConflict);
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

    const receipt = dependencies.beginResume?.(input.entry, input.spec) ?? undefined;
    const spawned = await dependencies.spawn(input.spec, "", receipt);
    await dependencies.remember(input.entry.path, input.spec, spawned);
    snapshot = await observe(true);
    if (snapshot.observation === "failure") throw new Error(`tmux pane observation failed: ${snapshot.observationError}`);
    const resumedConflict = conflictForPath(snapshot, input.entry.path, conversationIdForPath);
    if (resumedConflict) throw new TranscriptHostConflictError(resumedConflict);
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

  async function deliverToTranscriptHost(input: { entry: FileEntry; spec: ResumeSpec; payload: string }): Promise<HostDeliveryOutcome> {
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
          if (error instanceof TmuxDeliveryUncertainError) return failure(error, 500, "started");
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
  }

  return {
    readTranscriptHosts: observe,
    deliverToTranscriptHost: (input) => dependencies.serializeDelivery
      ? dependencies.serializeDelivery(input.entry, () => deliverToTranscriptHost(input))
      : deliverToTranscriptHost(input),
  };
}

async function reconcileRegistry(hosts: TranscriptHost[]): Promise<HostReconciliation> {
  const registry = agentRegistry();
  const seen = new Set<string>();
  const quarantinedPaneIds = new Set<string>();
  for (const host of hosts) {
    if (!host.primaryPath) continue;
    const key = sessionKeyFromTranscript(host.engine, host.primaryPath);
    if (!key) continue;
    const serverStart = procBackend.processIdentity(host.tmuxServerPid);
    const evidence: TmuxHostEvidence = {
      kind: "tmux",
      endpoint: tmuxEndpoint(),
      server: { pid: host.tmuxServerPid, startIdentity: serverStart },
      paneId: host.paneId,
      panePid: { pid: host.panePid, startIdentity: procBackend.processIdentity(host.panePid) },
      windowName: host.windowName ?? "",
      agent: { pid: host.agentPid, startIdentity: host.agentIdentity },
      argv: host.agentArgv,
    };
    if (host.launchId) {
      const settled = registry.completeObservedSpawn(host.launchId, {
        key,
        artifactPath: host.primaryPath,
        cwd: host.cwd,
        accountId: null,
        status: "live",
        host: evidence,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
      /* A mismatched pane/artifact remains quarantined. It must never fall
         through into the generic upsert and overwrite the real receipt. */
      if (settled.kind === "settled") {
        seen.add(`${key.engine}:${key.sessionId}`);
        continue;
      }
      quarantinedPaneIds.add(host.paneId);
      continue;
    }
    const existing = registry.snapshot().entries[`${key.engine}:${key.sessionId}`];
    registry.upsert({
      key,
      artifactPath: host.primaryPath,
      cwd: host.cwd,
      accountId: existing?.accountId ?? null,
      status: "live",
      host: evidence,
      claimEpoch: existing?.claimEpoch ?? 0,
      claimOwner: existing?.claimOwner ?? null,
      pendingAction: null,
    });
    seen.add(`${key.engine}:${key.sessionId}`);
  }
  for (const [id, entry] of Object.entries(registry.snapshot().entries)) {
    if (entry.host?.kind === "tmux" && !seen.has(id)) registry.markUnhosted(entry.key);
  }
  registry.reconcileSpawnReceipts([...seen].map((id) => {
    const [engine, sessionId] = id.split(":");
    return { engine: engine as "claude" | "codex", sessionId };
  }));
  return { quarantinedPaneIds: [...quarantinedPaneIds] };
}

async function registryResumeRecords(): ReturnType<typeof resumePaneRecords> {
  const serverPid = await tmuxServerPid();
  if (serverPid === null) return null;
  const registry = agentRegistry();
  const snapshot = registry.snapshot();
  if (!snapshot.importedResumePanes) {
    const legacy = await resumePaneRecords();
    if (legacy) registry.importResumePanes(legacy.serverPid, legacy.records);
  }
  return { serverPid, records: registry.resumePanes(serverPid) };
}

async function rememberRegistryResume(pathname: string, spec: ResumeSpec, pane: SpawnedPane): Promise<void> {
  await rememberResumePane(pathname, spec, pane);
  if (!pane.panePid) return;
  const serverPid = await tmuxServerPid();
  if (serverPid !== null) agentRegistry().rememberResumePane(serverPid, pathname, { paneId: pane.paneId, panePid: pane.panePid, windowName: spec.windowName, engine: spec.engine });
}

function beginRegistryResume(entry: FileEntry, spec: ResumeSpec): SpawnReceipt | null {
  if (entry.engine !== "claude" && entry.engine !== "codex") return null;
  const registry = agentRegistry();
  const conversation = registry.conversationForPath(entry.path)
    ?? registry.ensureConversation(entry.engine, entry.path, null);
  const current = conversation.generations.at(-1);
  const begun = registry.beginSpawnRequest({
    engine: entry.engine,
    cwd: spec.cwd,
    accountId: current?.accountId ?? null,
    conversationId: conversation.id,
    purpose: "resume-successor",
    launchProfile: spec.launchProfile ?? current?.launchProfile,
  });
  return begun.receipt;
}

async function serializeRegistryDelivery(entry: FileEntry, task: () => Promise<HostDeliveryOutcome>): Promise<HostDeliveryOutcome> {
  if (entry.engine !== "claude" && entry.engine !== "codex") return task();
  const key = sessionKeyFromTranscript(entry.engine, entry.path);
  if (!key) return task();
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  try {
    return await agentRegistry().withOperationLock(key, owner, task);
  } catch (error) {
    return failure(error, 409);
  }
}

const runtimeResolver = createTranscriptHostResolver({
  listFiles,
  panes: panePidMap,
  ppidMap: () => procBackend.ppidMap(),
  agents: agentProcesses,
  serverPid: tmuxServerPid,
  resumeRecords: registryResumeRecords,
  panePid: panePidOf,
  paneWindowName: async (paneId) => (await paneInfo(paneId))?.windowName ?? null,
  alive: pidAlive,
  argv: readArgv,
  parentPid: readPpid,
  identity: procBackend.processIdentity,
  launchId: paneLaunchId,
  conversationIdForPath: (pathname) => agentRegistry().conversationForPath(pathname)?.id ?? null,
  beginResume: beginRegistryResume,
  spawn: spawnAgentWithPrompt,
  remember: rememberRegistryResume,
  deliver: sendText,
  reconcile: reconcileRegistry,
  serializeDelivery: serializeRegistryDelivery,
}, globalStore.__llvTranscriptHostDecisions ??= new Map());

export const readTranscriptHosts = runtimeResolver.readTranscriptHosts;
export const deliverToTranscriptHost = runtimeResolver.deliverToTranscriptHost;
