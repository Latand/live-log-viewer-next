import { identityAlive, livenessProbe, type LivenessProbe } from "@/lib/agent/accountLiveness";
import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { agentRegistry } from "@/lib/agent/registry";
import { getPipelines } from "@/lib/pipelines/engine";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { completedFileScan } from "@/lib/scanner/scanCache";
import type { Engine, FileEntry } from "@/lib/types";

import {
  completedGenerationSelection,
  hydrateWithBudget,
  selectConversationEntries,
  type CompletedGenerationRead,
  type ConversationSelection,
  type ConversationSelectionRequest,
} from "./inventorySelection";
import {
  describeTranscriptPath,
  readLivenessTranscriptEvidence,
  type LivenessTranscript,
  type LivenessTranscriptEvidence,
} from "./transcript";
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
    unproven-launch grace the reaper and blocker evaluation already agree on.
    Past it a launch that never produced host evidence is registry rot, and an
    old transcript with no registry entry at all is not "starting up" either. */
export const STARTING_GRACE_MS = 5 * 60_000;

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
  /** Admitted, no host evidence recorded yet, still inside the launch grace. */
  | "launch_unproven"
  /** No host evidence ever appeared and the transcript has aged out of the
      grace. An orphan hours old is not starting up; the turn state decides
      whether it is stranded (`stalled`) or simply over (`gone`). */
  | "launch_unproven_expired";

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
  engine: Engine;
  title: string;
  /** ISO timestamp of the newest durable transcript RECORD — tool traffic
      counts, not only assistant prose (falls back to the transcript's own mtime
      when no record carries a timestamp). */
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
  /** Whether this row's turn state came from its own transcript tail or from
      the scan projection because the read budget was already spent (#860). */
  evidenceSource: "transcript" | "projection";
}

/**
 * Phase timings, in milliseconds and nothing else (#860).
 *
 * Deliberately identity-free: a timing report travels through logs and PR
 * bodies, so it carries numbers a reader can act on and never a path, a project
 * or an account.
 */
export interface AgentLivenessTimings {
  /** Reading the completed generation and applying filters and the row limit. */
  inventorySelectionMs: number;
  /** Registry, host and pipeline-lineage projection over the selected rows. */
  journalProjectionMs: number;
  /** Bounded transcript-tail hydration. */
  evidenceReadMs: number;
  /** Assembling the records this call returns. */
  serializationMs: number;
  totalMs: number;
}

export interface AgentLivenessSelectionReport {
  /** `targeted` names a conversation or path; the others read the catalog. */
  scope: "targeted" | "project" | "corpus";
  /** Conversation rows in the generation this call consumed. */
  scanned: number;
  /** Rows matching project/liveness before the row limit. */
  matched: number;
  selected: number;
  hydrated: number;
  /** Selected rows answered from the scan projection because the read budget
      was exhausted before they were reached. */
  projected: number;
  generation: number | null;
  cacheStatus: ConversationSelection["cacheStatus"] | null;
  /** True only on the legacy whole-inventory adapter. */
  freshScan: boolean;
  evidenceBytes: number;
  budget: "complete" | "byte_budget" | "deadline";
}

export interface AgentLivenessSnapshot {
  observedAt: string;
  stallAfterMs: number;
  count: number;
  /** Conversations whose lifecycle is `stalled`, so a poller can branch on one
      number instead of scanning the list. */
  stalledCount: number;
  conversations: AgentLivenessRecord[];
  selection: AgentLivenessSelectionReport;
  timings: AgentLivenessTimings;
}

export interface AgentLivenessRequest {
  conversationId?: string;
  transcriptPath?: string;
  project?: string;
  /** Restrict to conversations the scan still projects as live or stalled, or
      that the registry projection currently hosts. */
  liveOnly?: boolean;
  stallAfterMs?: number;
  limit?: number;
  /** The caller's lifetime. Cancelling it stops the generation read and starts
      no further transcript tails. */
  signal?: AbortSignal | null;
  /** Wall-clock ceiling on transcript-tail hydration for this call. */
  evidenceDeadlineMs?: number;
  /** Byte ceiling on transcript-tail hydration for this call. */
  evidenceByteBudget?: number;
  /** Tail reads in flight at once. */
  evidenceConcurrency?: number;
}

/** Tail reads in flight at once. Small on purpose: a `limit: 10` read is ten
    reads total, and twenty concurrent callers must not multiply into a storm. */
export const DEFAULT_EVIDENCE_CONCURRENCY = 4;
/** Bytes one call may charge to transcript evidence. A tail read is clamped to
    128 KiB, so this is a ceiling of roughly sixty-four tails. */
export const DEFAULT_EVIDENCE_BYTE_BUDGET = 8 * 1024 * 1024;
/** Wall clock one call may spend on transcript evidence before the remaining
    rows fall back to the scan projection. */
export const DEFAULT_EVIDENCE_DEADLINE_MS = 2_000;
/** What one tail read actually costs, mirroring `readStableTailRecords`. */
const EVIDENCE_TAIL_BYTES = 131_072;

export interface AgentLivenessSources {
  now(): number;
  /**
   * Bounded selection over ONE completed scanner generation (#860): filters and
   * the row limit are applied to metadata the process already published, before
   * anything opens a transcript. Only a request that names no single
   * conversation calls it.
   */
  selectInventory?(
    request: ConversationSelectionRequest,
    options?: { signal?: AbortSignal | null },
  ): Promise<ConversationSelection>;
  /**
   * The legacy whole-inventory adapter, kept for injected callers that predate
   * the selection seam. Production never installs it: it is the fresh
   * whole-corpus sweep #860 exists to remove.
   */
  listFiles?(): Promise<FileEntry[]>;
  /** One transcript by path, described with no sweep of any kind. */
  describeTranscript(transcriptPath: string): Promise<LivenessTranscript | null>;
  registrySnapshot(): Pick<RegistryFile, "entries" | "conversations">;
  pipelines(): Pipeline[];
  /** Turn state and newest-record freshness from ONE tail read. */
  transcriptEvidence(
    engine: "claude" | "codex",
    transcriptPath: string,
    options?: { signal?: AbortSignal | null },
  ): Promise<LivenessTranscriptEvidence | null>;
  probe: LivenessProbe;
}

export function productionLivenessSources(
  dependencies: { completedFileScan?: CompletedGenerationRead } = {},
): AgentLivenessSources {
  const read = dependencies.completedFileScan ?? completedFileScan;
  return {
    now: () => Date.now(),
    /* Consumes the COMPLETED generation the process already published. One scan
       generation serves every catalog read; this one opens none of its own. */
    selectInventory: (request, options) => completedGenerationSelection(request, {
      completedFileScan: read,
      signal: options?.signal ?? null,
    }),
    describeTranscript: describeTranscriptPath,
    registrySnapshot: () => agentRegistry().readOnlySnapshot(),
    pipelines: () => getPipelines().pipelines,
    transcriptEvidence: readLivenessTranscriptEvidence,
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
  const hosted = entry.status === "starting" || entry.status === "live" || entry.status === "idle" || entry.status === "handoff";
  const structured = entry.structuredHost?.process ?? null;
  const tmux = entry.host
    ? {
        state: identityAlive(entry.host.agent, probe) || identityAlive(entry.host.panePid, probe) ? "alive" as const : "gone" as const,
        kind: "tmux" as const,
        pid: entry.host.agent.pid,
      }
    : null;
  const structuredEvidence = structured
    ? {
        state: identityAlive(structured, probe) ? "alive" as const : "gone" as const,
        kind: "structured" as const,
        pid: structured.pid,
      }
    : null;

  if (!hosted) {
    const recorded = tmux ?? structuredEvidence;
    return recorded ? { ...recorded, state: "gone" } : { state: "gone", kind: "none", pid: null };
  }
  if (tmux?.state === "alive") return tmux;
  if (structuredEvidence?.state === "alive") return structuredEvidence;
  if (tmux) return tmux;
  if (structuredEvidence) return structuredEvidence;

  /* A hosted status with no recorded process is either a launch still being
     admitted or registry rot; the grace decides which. */
  const updatedAt = Date.parse(entry.updatedAt);
  const young = Number.isFinite(updatedAt) && probe.now() - updatedAt < STARTING_GRACE_MS;
  return { state: young ? "unknown" : "gone", kind: "none", pid: null };
}

function turnStateFromEvidence(evidence: LivenessTranscriptEvidence | null, entry: LivenessTranscript): LifecycleTurnState {
  if (evidence) return evidence.turn;
  /* No readable durable artifact: fall back to the scan's own projection so a
     transient read failure still reports something honest. A targeted lookup
     carries no scan projection, and `unknown` is the honest answer there. */
  if (entry.activityReason === "jsonl_turn_open") return "busy";
  if (entry.activityReason === "jsonl_turn_completed") return "idle";
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
 *
 * `unknown` host evidence is aged. Reporting `starting` on it regardless of age
 * makes an orphaned transcript from last week look like a launch in progress —
 * the one answer an orchestrator must never get, since it implies waiting.
 */
export function evaluateLiveness(input: {
  host: { state: AgentHostState };
  turnState: LifecycleTurnState;
  silentForMs: number | null;
  stallAfterMs: number;
  startingGraceMs?: number;
}): { lifecycle: LifecycleState; reason: AgentLivenessReason } {
  const silent = input.silentForMs !== null && input.silentForMs >= input.stallAfterMs;
  if (input.host.state === "gone") {
    return input.turnState === "busy"
      ? { lifecycle: "stalled", reason: "host_gone_turn_open" }
      : { lifecycle: "gone", reason: "host_gone_turn_settled" };
  }
  if (input.host.state === "unknown") {
    const grace = input.startingGraceMs ?? STARTING_GRACE_MS;
    /* Nothing to age it by leaves the launch the benefit of the doubt; any
       readable age past the grace takes it away. */
    if (input.silentForMs === null || input.silentForMs < grace) {
      return { lifecycle: "starting", reason: "launch_unproven" };
    }
    return input.turnState === "busy"
      ? { lifecycle: "stalled", reason: "launch_unproven_expired" }
      : { lifecycle: "gone", reason: "launch_unproven_expired" };
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

function transcriptFromEntry(entry: FileEntry): LivenessTranscript {
  return {
    path: entry.path,
    project: entry.project,
    title: entry.title,
    engine: entry.engine,
    mtimeMs: Number.isFinite(entry.mtime) ? entry.mtime * 1000 : Number.NaN,
    sizeBytes: Number.isFinite(entry.size) ? entry.size : undefined,
    conversationId: entry.conversationId ?? null,
    activity: entry.activity ?? null,
    activityReason: entry.activityReason ?? null,
  };
}

/** The conversation that owns a transcript, from the registry the snapshot has
    already read — a targeted lookup has no scan projection to carry one. */
function conversationIdForPath(
  registry: Pick<RegistryFile, "conversations">,
  transcriptPath: string,
): string | null {
  for (const conversation of Object.values(registry.conversations)) {
    if (conversation.generations.some((generation) => generation.path === transcriptPath)) return conversation.id;
    if (conversation.continuityPaths?.includes(transcriptPath)) return conversation.id;
  }
  return null;
}

/** The transcripts the registry projection currently hosts. A completed
    generation can predate a launch by its whole refresh cadence, so liveness
    filtered on the scan projection alone would drop a conversation that started
    a minute ago — the correctness half of not sweeping the corpus (#860). */
function hostedTranscriptPaths(snapshot: Pick<RegistryFile, "entries">): Set<string> {
  const hosted = new Set<string>();
  for (const entry of Object.values(snapshot.entries)) {
    if (entry.status !== "starting" && entry.status !== "live" && entry.status !== "idle" && entry.status !== "handoff") continue;
    if (entry.artifactPath) hosted.add(entry.artifactPath);
  }
  return hosted;
}

function livenessAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("liveness snapshot cancelled", "AbortError");
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

/**
 * The liveness answer for a request, bounded end to end (#860).
 *
 * The order is the whole repair: project, liveness and the row limit are
 * applied to one COMPLETED scanner generation, and only the rows that survive
 * are hydrated — at bounded concurrency, under byte and time budgets, with the
 * caller's cancellation reaching both phases. Before this, ten rows of answer
 * cost a fresh whole-corpus sweep plus a sequential tail read per surviving row,
 * and a caller that timed out left all of it running.
 */
export async function agentLivenessSnapshot(
  request: AgentLivenessRequest,
  sources: AgentLivenessSources,
): Promise<AgentLivenessSnapshot> {
  const startedAt = performance.now();
  const now = sources.now();
  const signal = request.signal ?? null;
  if (signal?.aborted) throw livenessAbortError(signal.reason);
  const stallAfterMs = Number.isFinite(request.stallAfterMs) && (request.stallAfterMs as number) > 0
    ? Math.floor(request.stallAfterMs as number)
    : DEFAULT_STALL_AFTER_MS;
  const limit = Math.max(1, Math.min(200, Number.isInteger(request.limit) ? request.limit as number : 100));

  const projectionStartedAt = performance.now();
  const registry = sources.registrySnapshot();
  const pipelines = pipelineIndex(sources.pipelines());
  const hostedPaths = hostedTranscriptPaths(registry);
  const journalProjectionMs = performance.now() - projectionStartedAt;

  /* A conversation id names its current generation's transcript; that is the
     only path whose liveness is meaningful. */
  const requestedPaths = new Set<string>();
  const targeted = Boolean(request.transcriptPath || request.conversationId);
  if (request.transcriptPath) requestedPaths.add(request.transcriptPath);
  if (request.conversationId) {
    const conversation = registry.conversations[request.conversationId];
    const path = conversation?.generations.at(-1)?.path;
    if (path) requestedPaths.add(path);
  }

  const selectionStartedAt = performance.now();
  let entries: LivenessTranscript[];
  let selection: Omit<AgentLivenessSelectionReport, "hydrated" | "projected" | "evidenceBytes" | "budget">;
  if (targeted) {
    /* The targeted branch. A caller that named a specific target gets back what
       it named and nothing else — even an empty set. Falling through to the
       catalog would turn a stale alias into an unrelated read. */
    entries = requestedPaths.size > 0
      ? (await Promise.all([...requestedPaths].slice(0, limit).map((path) => sources.describeTranscript(path))))
        .filter((entry): entry is LivenessTranscript => entry !== null)
      : [];
    selection = {
      scope: "targeted",
      scanned: requestedPaths.size,
      matched: entries.length,
      selected: entries.length,
      generation: null,
      cacheStatus: null,
      freshScan: false,
    };
  } else {
    const selectionRequest: ConversationSelectionRequest = {
      project: request.project,
      liveOnly: request.liveOnly,
      limit,
      hostedPaths,
    };
    if (sources.selectInventory) {
      const selected = await sources.selectInventory(selectionRequest, { signal });
      entries = selected.entries.map(transcriptFromEntry);
      selection = {
        scope: request.project ? "project" : "corpus",
        scanned: selected.scanned,
        matched: selected.matched,
        selected: selected.entries.length,
        generation: selected.generation,
        cacheStatus: selected.cacheStatus,
        freshScan: selected.freshScan,
      };
    } else if (sources.listFiles) {
      const selected = selectConversationEntries(await sources.listFiles(), selectionRequest);
      entries = selected.entries.map(transcriptFromEntry);
      selection = {
        scope: request.project ? "project" : "corpus",
        scanned: selected.scanned,
        matched: selected.matched,
        selected: selected.entries.length,
        generation: null,
        cacheStatus: null,
        freshScan: true,
      };
    } else {
      throw new Error("liveness needs an inventory source: install selectInventory");
    }
  }
  const inventorySelectionMs = performance.now() - selectionStartedAt;
  if (signal?.aborted) throw livenessAbortError(signal.reason);

  const hydratable = entries.filter((entry) => entry.engine === "claude" || entry.engine === "codex");
  const evidenceStartedAt = performance.now();
  const deadlineMs = Number.isFinite(request.evidenceDeadlineMs) && (request.evidenceDeadlineMs as number) > 0
    ? Math.floor(request.evidenceDeadlineMs as number)
    : DEFAULT_EVIDENCE_DEADLINE_MS;
  const hydration = await hydrateWithBudget(
    hydratable,
    (entry) => Math.min(Number.isFinite(entry.sizeBytes) ? entry.sizeBytes as number : EVIDENCE_TAIL_BYTES, EVIDENCE_TAIL_BYTES),
    async (entry, hydrationSignal) => sources.transcriptEvidence(
      entry.engine as "claude" | "codex",
      entry.path,
      { signal: hydrationSignal },
    ),
    {
      concurrency: Math.max(1, Math.floor(request.evidenceConcurrency ?? DEFAULT_EVIDENCE_CONCURRENCY)),
      maxBytes: Math.max(0, Math.floor(request.evidenceByteBudget ?? DEFAULT_EVIDENCE_BYTE_BUDGET)),
      deadlineAt: now + deadlineMs,
      signal,
      now: sources.now,
    },
  );
  const evidenceReadMs = performance.now() - evidenceStartedAt;
  if (signal?.aborted) throw livenessAbortError(signal.reason);

  const serializationStartedAt = performance.now();
  const conversations: AgentLivenessRecord[] = [];
  for (const [index, entry] of hydratable.entries()) {
    const evidence = hydration.results.get(index) ?? null;
    const turnState = turnStateFromEvidence(evidence, entry);
    /* Freshness is the newest RECORD, tool traffic included. Reading it off the
       last assistant prose message reports a live agent in a long tool stretch
       as stalled — the exact question this surface exists to answer. */
    const lastRecordMs = evidence?.lastRecordTs ?? (Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : null);
    const silentForMs = lastRecordMs !== null ? Math.max(0, now - lastRecordMs) : null;
    const registryEntry = entryForPath(registry, entry.path);
    const host = hostEvidence(registryEntry, sources.probe);
    const { lifecycle, reason } = evaluateLiveness({ host, turnState, silentForMs, stallAfterMs });
    const conversationId = entry.conversationId ?? conversationIdForPath(registry, entry.path);
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
      evidenceSource: evidence !== null ? "transcript" : "projection",
    });
  }
  const serializationMs = performance.now() - serializationStartedAt;

  return {
    observedAt: new Date(now).toISOString(),
    stallAfterMs,
    count: conversations.length,
    stalledCount: conversations.filter((record) => record.lifecycle === "stalled").length,
    conversations,
    selection: {
      ...selection,
      hydrated: hydration.hydrated,
      projected: hydratable.length - hydration.hydrated,
      evidenceBytes: hydration.bytes,
      budget: hydration.stopped,
    },
    timings: {
      inventorySelectionMs: roundMs(inventorySelectionMs),
      journalProjectionMs: roundMs(journalProjectionMs),
      evidenceReadMs: roundMs(evidenceReadMs),
      serializationMs: roundMs(serializationMs),
      totalMs: roundMs(performance.now() - startedAt),
    },
  };
}
