import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RegistryConversation, RegistryFile } from "@/lib/agent/registry";
import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { Flow, Round } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

export type ReaperClass = "flow-worker" | "headless-reviewer" | "probe" | "duplicate-resume" | "dead-transcript";
export type ReaperProtection =
  | "user-authored-message"
  | "mid-turn"
  | "manual-board-placement"
  | "migration-in-progress"
  | "newest-duplicate"
  | "flow-in-progress"
  | "flow-not-merged"
  | "review-verdict-pending"
  | "idle-ttl"
  | "observation-pending"
  | "unclassified";

export interface ReaperAgentReport {
  paneId: string;
  panePid: number;
  agentPid: number;
  path: string | null;
  conversationId: string | null;
  class: ReaperClass | null;
  idleSeconds: number | null;
  ttlSeconds: number | null;
  protectedReasons: ReaperProtection[];
  eligible: boolean;
  action: "dry-run" | "retained" | "reaped" | "kill-failed";
}

export interface ReaperReport {
  generatedAt: string;
  mode: "dry-run" | "active";
  configFlag: "LLV_REAPER_ENABLED";
  eligibleCount: number;
  agents: ReaperAgentReport[];
}

export interface ReaperInput {
  now: number;
  registry: RegistryFile;
  hosts: TranscriptHost[];
  files: FileEntry[];
  flows: Flow[];
  manualPaths: ReadonlySet<string>;
  userAuthoredPaths: ReadonlySet<string>;
  missingTranscriptPaths: ReadonlySet<string>;
  mergedFlowIds: ReadonlySet<string>;
  firstObservedAt: Readonly<Record<string, string>>;
  enabled: boolean;
}

export interface ReaperJournalRecord {
  at: string;
  paneId: string;
  path: string | null;
  class: ReaperClass;
  reason: "idle-ttl-exceeded";
  outcome: "reaped" | "kill-failed";
}

const TTL_SECONDS: Record<ReaperClass, number> = {
  "flow-worker": 30 * 60,
  "headless-reviewer": 5 * 60,
  probe: 60 * 60,
  "duplicate-resume": 0,
  "dead-transcript": 30 * 60,
};

function conversationForPath(registry: RegistryFile, pathname: string): RegistryConversation | null {
  return Object.values(registry.conversations).find((conversation) =>
    conversation.generations.some((generation) => generation.path === pathname)
    || conversation.continuityPaths.includes(pathname)) ?? null;
}

function profileForPath(registry: RegistryFile, pathname: string): LaunchProfile | null {
  const direct = Object.values(registry.entries).find((entry) => entry.artifactPath === pathname)?.launchProfile;
  if (direct) return direct;
  const conversation = conversationForPath(registry, pathname);
  return conversation?.generations.find((generation) => generation.path === pathname)?.launchProfile
    ?? conversation?.generations.at(-1)?.launchProfile
    ?? null;
}

function paneNumber(paneId: string): number {
  const parsed = Number(paneId.slice(1));
  return Number.isInteger(parsed) ? parsed : -1;
}

function observedKey(host: TranscriptHost): string {
  return `${host.paneId}:${host.agentPid}:${host.agentIdentity ?? "unknown"}`;
}

function secondsSince(now: number, timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1000)) : null;
}

function fileIdleSeconds(now: number, entry: FileEntry | undefined): number | null {
  return entry ? Math.max(0, Math.floor(now / 1000 - entry.mtime)) : null;
}

function flowForPath(flows: Flow[], pathname: string): { flow: Flow; round: Round | null; role: "implementer" | "reviewer" } | null {
  for (const flow of flows) {
    if (flow.implementerPath === pathname) return { flow, round: null, role: "implementer" };
    const round = flow.rounds.find((candidate) => candidate.reviewerPath === pathname);
    if (round) return { flow, round, role: "reviewer" };
  }
  return null;
}

function flowIdleSeconds(now: number, flow: Flow): number | null {
  return secondsSince(now, flow.closedAt ?? flow.rounds.at(-1)?.reviewedAt ?? null);
}

function reviewerIdleSeconds(now: number, round: Round): number | null {
  return secondsSince(now, round.reviewedAt);
}

function probeProfile(profile: LaunchProfile | null, host: TranscriptHost): boolean {
  const text = [profile?.title, profile?.project, profile?.goal?.objective, host.windowName, ...host.agentArgv].filter(Boolean).join(" ");
  return /\b(?:probe|soak)\b/i.test(text);
}

function duplicateGroups(hosts: TranscriptHost[]): Map<string, TranscriptHost[]> {
  const groups = new Map<string, TranscriptHost[]>();
  for (const host of hosts) {
    if (!host.primaryPath) continue;
    const key = `${host.engine}:${host.primaryPath}`;
    groups.set(key, [...(groups.get(key) ?? []), host]);
  }
  return groups;
}

function deliveryFencesTurn(registry: RegistryFile, conversation: RegistryConversation): boolean {
  const observedAt = conversation.turn.observedAt ? Date.parse(conversation.turn.observedAt) : Number.NaN;
  return Object.values(registry.heldDeliveries).some((delivery) => {
    if (delivery.conversationId !== conversation.id) return false;
    if (delivery.state === "held" || delivery.state === "assigned" || delivery.state === "delivery-uncertain") return true;
    if (delivery.state !== "delivered" || !delivery.deliveredAt) return false;
    const deliveredAt = Date.parse(delivery.deliveredAt);
    return Number.isFinite(deliveredAt) && (!Number.isFinite(observedAt) || deliveredAt >= observedAt);
  });
}

export function evaluateReaper(input: ReaperInput): ReaperReport {
  const files = new Map(input.files.map((entry) => [entry.path, entry]));
  const groups = duplicateGroups(input.hosts);
  const agents = input.hosts.map((host): ReaperAgentReport => {
    const pathname = host.primaryPath;
    const conversation = pathname ? conversationForPath(input.registry, pathname) : null;
    const profile = pathname ? profileForPath(input.registry, pathname) : null;
    const flowMatch = pathname ? flowForPath(input.flows, pathname) : null;
    const group = pathname ? groups.get(`${host.engine}:${pathname}`) ?? [] : [];
    const newestDuplicate = group.length > 1
      ? [...group].sort((left, right) => paneNumber(right.paneId) - paneNumber(left.paneId))[0]
      : null;

    let agentClass: ReaperClass | null = null;
    let idleSeconds: number | null = null;
    const protectedReasons: ReaperProtection[] = [];

    if (group.length > 1) {
      agentClass = "duplicate-resume";
      idleSeconds = 0;
      if (newestDuplicate?.paneId === host.paneId) protectedReasons.push("newest-duplicate");
    } else if (flowMatch?.role === "reviewer" && flowMatch.flow.reviewerMode === "headless") {
      agentClass = "headless-reviewer";
      idleSeconds = reviewerIdleSeconds(input.now, flowMatch.round!);
      if (!flowMatch.round?.verdict && !flowMatch.round?.error) protectedReasons.push("review-verdict-pending");
    } else if (flowMatch) {
      agentClass = "flow-worker";
      idleSeconds = flowIdleSeconds(input.now, flowMatch.flow);
      if (!new Set(["approved", "closed"]).has(flowMatch.flow.state)) protectedReasons.push("flow-in-progress");
      if (!input.mergedFlowIds.has(flowMatch.flow.id)) protectedReasons.push("flow-not-merged");
    } else if (probeProfile(profile, host)) {
      agentClass = "probe";
      idleSeconds = pathname ? fileIdleSeconds(input.now, files.get(pathname)) : null;
    } else if (pathname && input.missingTranscriptPaths.has(pathname)) {
      agentClass = "dead-transcript";
      idleSeconds = secondsSince(input.now, input.firstObservedAt[observedKey(host)]);
    }

    if (pathname && input.userAuthoredPaths.has(pathname)) protectedReasons.unshift("user-authored-message");
    if (conversation && (conversation.turn.state === "busy" || conversation.turn.state === "unknown" || deliveryFencesTurn(input.registry, conversation))) {
      protectedReasons.unshift("mid-turn");
    }
    if (conversation?.migration && !["committed", "rolled-back"].includes(conversation.migration.phase)) {
      protectedReasons.unshift("migration-in-progress");
    }
    if (pathname && input.manualPaths.has(pathname)) protectedReasons.unshift("manual-board-placement");

    const ttlSeconds = agentClass ? TTL_SECONDS[agentClass] : null;
    if (!agentClass) protectedReasons.push("unclassified");
    else if (idleSeconds === null) protectedReasons.push("observation-pending");
    else if (ttlSeconds !== null && idleSeconds < ttlSeconds) protectedReasons.push("idle-ttl");
    const eligible = agentClass !== null && protectedReasons.length === 0;
    return {
      paneId: host.paneId,
      panePid: host.panePid,
      agentPid: host.agentPid,
      path: pathname,
      conversationId: conversation?.id ?? null,
      class: agentClass,
      idleSeconds,
      ttlSeconds,
      protectedReasons,
      eligible,
      action: eligible && !input.enabled ? "dry-run" : "retained",
    };
  });
  return {
    generatedAt: new Date(input.now).toISOString(),
    mode: input.enabled ? "active" : "dry-run",
    configFlag: "LLV_REAPER_ENABLED",
    eligibleCount: agents.filter((agent) => agent.eligible).length,
    agents,
  };
}

export async function runEvaluatedReaper(
  report: ReaperReport,
  deps: {
    actuate(agent: ReaperAgentReport): Promise<boolean>;
    journal(record: ReaperJournalRecord): void;
  },
): Promise<ReaperReport> {
  if (report.mode === "dry-run") return report;
  for (const agent of report.agents) {
    if (!agent.eligible || agent.class === null) continue;
    const killed = await deps.actuate(agent);
    agent.action = killed ? "reaped" : "kill-failed";
    deps.journal({
      at: new Date().toISOString(),
      paneId: agent.paneId,
      path: agent.path,
      class: agent.class,
      reason: "idle-ttl-exceeded",
      outcome: killed ? "reaped" : "kill-failed",
    });
  }
  return report;
}
