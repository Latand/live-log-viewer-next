import { identityAlive, livenessProbe, type LivenessProbe } from "@/lib/agent/accountLiveness";
import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { agentRegistry } from "@/lib/agent/registry";
import { durableStageTurnEvidence, type StageTurnEvidence } from "@/lib/pipelines/durableEvidence";
import { getPipelines } from "@/lib/pipelines/engine";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { listFiles } from "@/lib/scanner";
import type { FileEntry } from "@/lib/types";

import type { LifecycleState, LifecycleTurnState } from "./vocabulary";

/**
 * #645 — agent liveness and stall detection over the registries the Viewer
 * already maintains, so an orchestrator's 30-minute sweep stops being a
 * hand-rolled `stat`/`pgrep` loop outside the product.
 *
 * The snapshot answers one question per conversation: can this turn still make
 * progress? It reports the shared lifecycle vocabulary, never a second status
 * model, and it deliberately does not echo whatever a pipeline record claims —
 * a pipeline stuck at `running` over a dead host is exactly the failure this
 * exists to catch.
 */

/** Silence under a LIVE host that turns `running` into `stalled`. A dead host
    over an open turn needs no threshold: it can never progress. */
export const DEFAULT_STALL_AFTER_MS = 10 * 60_000;

/** A launch with no host evidence yet is `starting`, not `gone`. Mirrors the
    unproven-launch grace the reaper and blocker evaluation already agree on. */
const STARTING_GRACE_MS = 5 * 60_000;

export type AgentHostState = "alive" | "gone" | "unknown";

export type AgentLivenessReason =
  /** A live host with a turn that is still moving. */
  | "host_alive_turn_active"
  /** A live host with a settled turn — the agent is awaiting input. */
  | "host_alive_turn_idle"
  /** A live host whose transcript has been silent past the stall threshold. */
  | "host_alive_transcript_silent"
  /** The zombie: an open turn whose host is gone. Nothing will ever finish it. */
  | "host_gone_turn_open"
  /** The host exited after its turn settled — a finished or killed stage. */
  | "host_gone_turn_settled"
  /** Admitted, no host evidence recorded yet. */
  | "launch_unproven";

export interface AgentLivenessPipelineRef {
  pipelineId: string;
  stageId: string;
  attempt: number;
  /** What the pipeline record currently claims. Reported for contrast, never
      used as liveness evidence — a stale `running` here is the bug, not the
      answer (see the pane-less structured attempt in `pipelines/engine.ts`). */
  reportedState: PipelineStageAttempt["state"];
  reportedPipelineState: Pipeline["state"];
  /** Pane-less attempts are structured-hosted; the reconciler treats their
      durable `busy` turn evidence as "wait forever", so they are the ones that
      strand. */
  paneId: string | null;
}

export interface AgentLivenessRecord {
  conversationId: string | null;
  transcriptPath: string;
  project: string;
  engine: FileEntry["engine"];
  title: string;
  /** ISO timestamp of the newest durable transcript record (falls back to the
      transcript's own mtime when no record carries a timestamp). */
  lastRecordAt: string | null;
  turnState: LifecycleTurnState;
  host: { state: AgentHostState; kind: "tmux" | "structured" | "none"; pid: number | null };
  /** Shared vocabulary. `stalled` means the turn cannot progress on its own. */
  lifecycle: LifecycleState;
  reason: AgentLivenessReason;
  /** Milliseconds since `lastRecordAt`; always reported so a caller can apply
      its own threshold without a second read. */
  silentForMs: number | null;
  /** Milliseconds this conversation has been silent while in the `stalled` or
      `gone` lifecycle; null when it is not stalled. */
  stalledForMs: number | null;
  pipeline: AgentLivenessPipelineRef | null;
}

export interface AgentLivenessSnapshot {
  observedAt: string;
  stallAfterMs: number;
  count: number;
  /** Conversations whose lifecycle is `stalled`, so a poller can branch on one
      number instead of scanning the list. */
  stalledCount: number;
  conversations: AgentLivenessRecord[];
}

export interface AgentLivenessRequest {
  conversationId?: string;
  transcriptPath?: string;
  project?: string;
  /** Restrict to conversations the scan still projects as live or stalled. */
  liveOnly?: boolean;
  stallAfterMs?: number;
  limit?: number;
}

export interface AgentLivenessSources {
  now(): number;
  listFiles(): Promise<FileEntry[]>;
  registrySnapshot(): Pick<RegistryFile, "entries" | "conversations">;
  pipelines(): Pipeline[];
  durableTurnEvidence(engine: "claude" | "codex", transcriptPath: string): Promise<StageTurnEvidence | null>;
  probe: LivenessProbe;
}

export function productionLivenessSources(): AgentLivenessSources {
  return {
    now: () => Date.now(),
    listFiles: () => listFiles({ fresh: true, persist: false }),
    registrySnapshot: () => agentRegistry().readOnlySnapshot(),
    pipelines: () => getPipelines().pipelines,
    durableTurnEvidence: durableStageTurnEvidence,
    probe: livenessProbe(),
  };
}

function isoOrNull(ms: number | null): string | null {
  return ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The registry entry that hosts a transcript, matched on the artifact path the
    entry itself records — the only correlation that survives a resumed pane. */
function entryForPath(
  snapshot: Pick<RegistryFile, "entries">,
  transcriptPath: string,
): AgentRegistryEntry | null {
  for (const entry of Object.values(snapshot.entries)) {
    if (entry.artifactPath === transcriptPath) return entry;
  }
  return null;
}

function hostEvidence(
  entry: AgentRegistryEntry | null,
  probe: LivenessProbe,
): { state: AgentHostState; kind: "tmux" | "structured" | "none"; pid: number | null } {
  if (!entry) return { state: "unknown", kind: "none", pid: null };
  const structured = entry.structuredHost?.process ?? null;
  if (entry.host) {
    const alive = identityAlive(entry.host.agent, probe) || identityAlive(entry.host.panePid, probe);
    return { state: alive ? "alive" : "gone", kind: "tmux", pid: entry.host.agent.pid };
  }
  if (structured) {
    return { state: identityAlive(structured, probe) ? "alive" : "gone", kind: "structured", pid: structured.pid };
  }
  /* A hosted status with no recorded process is either a launch still being
     admitted or registry rot; the grace decides which. */
  const hosted = entry.status === "starting" || entry.status === "live" || entry.status === "idle" || entry.status === "handoff";
  if (!hosted) return { state: "gone", kind: "none", pid: null };
  const updatedAt = Date.parse(entry.updatedAt);
  const young = Number.isFinite(updatedAt) && probe.now() - updatedAt < STARTING_GRACE_MS;
  return { state: young ? "unknown" : "gone", kind: "none", pid: null };
}

function turnStateFromEvidence(evidence: StageTurnEvidence | null, entry: FileEntry): LifecycleTurnState {
  if (evidence) return evidence.turn === "terminal" ? "idle" : evidence.turn === "busy" ? "busy" : "unknown";
  /* No readable durable artifact: fall back to the scan's own projection so a
     transient read failure still reports something honest. */
  if (entry.activityReason === "jsonl_turn_open") return "busy";
  if (entry.authoritativeTurn?.state === "idle") return "idle";
  return "unknown";
}

/**
 * The whole decision table, pure and injectable so the zombie can be replayed
 * as a test instead of described in a comment.
 *
 * The case that matters: `host_gone_turn_open`. A pane-less structured attempt
 * whose transcript ends mid-turn while its host process is gone is reported
 * `stalled` immediately and unconditionally — no silence threshold, because the
 * turn has no process left that could ever advance it. The pipeline record for
 * that same attempt keeps claiming `running`; this surface refuses to echo it.
 */
export function evaluateLiveness(input: {
  host: { state: AgentHostState };
  turnState: LifecycleTurnState;
  silentForMs: number | null;
  stallAfterMs: number;
}): { lifecycle: LifecycleState; reason: AgentLivenessReason } {
  const silent = input.silentForMs !== null && input.silentForMs >= input.stallAfterMs;
  if (input.host.state === "gone") {
    return input.turnState === "busy"
      ? { lifecycle: "stalled", reason: "host_gone_turn_open" }
      : { lifecycle: "gone", reason: "host_gone_turn_settled" };
  }
  if (input.host.state === "unknown") {
    return input.turnState === "busy" && silent
      ? { lifecycle: "stalled", reason: "host_alive_transcript_silent" }
      : { lifecycle: "starting", reason: "launch_unproven" };
  }
  if (silent) return { lifecycle: "stalled", reason: "host_alive_transcript_silent" };
  if (input.turnState === "idle") return { lifecycle: "waiting", reason: "host_alive_turn_idle" };
  return { lifecycle: "running", reason: "host_alive_turn_active" };
}

/** Pipeline attempts indexed by the conversation and transcript they own, so a
    stalled agent can be named with its stage lineage. */
function pipelineIndex(pipelines: Pipeline[]): {
  byConversation: Map<string, AgentLivenessPipelineRef>;
  byPath: Map<string, AgentLivenessPipelineRef>;
} {
  const byConversation = new Map<string, AgentLivenessPipelineRef>();
  const byPath = new Map<string, AgentLivenessPipelineRef>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.historical) continue;
        const ref: AgentLivenessPipelineRef = {
          pipelineId: pipeline.id,
          stageId: run.stageId,
          attempt: attempt.n,
          reportedState: attempt.state,
          reportedPipelineState: pipeline.state,
          paneId: attempt.paneId,
        };
        if (attempt.conversationId) byConversation.set(attempt.conversationId, ref);
        if (attempt.agentPath) byPath.set(attempt.agentPath, ref);
      }
    }
  }
  return { byConversation, byPath };
}

export async function agentLivenessSnapshot(
  request: AgentLivenessRequest,
  sources: AgentLivenessSources,
): Promise<AgentLivenessSnapshot> {
  const now = sources.now();
  const stallAfterMs = Number.isFinite(request.stallAfterMs) && (request.stallAfterMs as number) > 0
    ? Math.floor(request.stallAfterMs as number)
    : DEFAULT_STALL_AFTER_MS;
  const limit = Math.max(1, Math.min(200, Number.isInteger(request.limit) ? request.limit as number : 100));
  const registry = sources.registrySnapshot();
  const pipelines = pipelineIndex(sources.pipelines());

  /* A conversation id names its current generation's transcript; that is the
     only path whose liveness is meaningful. */
  const requestedPaths = new Set<string>();
  if (request.transcriptPath) requestedPaths.add(request.transcriptPath);
  if (request.conversationId) {
    const conversation = registry.conversations[request.conversationId];
    const path = conversation?.generations.at(-1)?.path;
    if (path) requestedPaths.add(path);
  }

  const entries = (await sources.listFiles())
    .filter((entry) => entry.engine === "claude" || entry.engine === "codex")
    .filter((entry) => requestedPaths.size === 0 || requestedPaths.has(entry.path))
    .filter((entry) => !request.project || entry.project === request.project)
    .filter((entry) => !request.liveOnly || entry.activity === "live" || entry.activity === "stalled")
    .slice(0, limit);

  const conversations: AgentLivenessRecord[] = [];
  for (const entry of entries) {
    const engine = entry.engine === "codex" ? "codex" : "claude";
    const evidence = await sources.durableTurnEvidence(engine, entry.path);
    const turnState = turnStateFromEvidence(evidence, entry);
    const lastRecordMs = evidence?.message?.ts ?? (Number.isFinite(entry.mtime) ? entry.mtime * 1000 : null);
    const silentForMs = lastRecordMs !== null ? Math.max(0, now - lastRecordMs) : null;
    const registryEntry = entryForPath(registry, entry.path);
    const host = hostEvidence(registryEntry, sources.probe);
    const { lifecycle, reason } = evaluateLiveness({ host, turnState, silentForMs, stallAfterMs });
    const conversationId = entry.conversationId ?? null;
    conversations.push({
      conversationId,
      transcriptPath: entry.path,
      project: entry.project,
      engine: entry.engine,
      title: entry.title,
      lastRecordAt: isoOrNull(lastRecordMs),
      turnState,
      host,
      lifecycle,
      reason,
      silentForMs,
      stalledForMs: lifecycle === "stalled" || lifecycle === "gone" ? silentForMs : null,
      pipeline: (conversationId ? pipelines.byConversation.get(conversationId) : undefined)
        ?? pipelines.byPath.get(entry.path)
        ?? null,
    });
  }

  return {
    observedAt: new Date(now).toISOString(),
    stallAfterMs,
    count: conversations.length,
    stalledCount: conversations.filter((record) => record.lifecycle === "stalled").length,
    conversations,
  };
}
