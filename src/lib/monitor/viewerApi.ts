import type { MonitorSessionRecord } from "./requests";
import type { MonitorRunRecord } from "./types";

/**
 * The shapes the operator-request scan reads the machine in (issue #741), and
 * nothing else any more.
 *
 * This module used to be a door: an HTTP client that a standalone CLI process
 * pointed at the Viewer on loopback, because #741's monitor ran outside the
 * Viewer on a crontab that was never written. #1245 moved the clock inside the
 * release that owns traffic, so there is no second process to speak HTTP to
 * anything, and `httpViewerApi` retired with the CLI that was its only caller.
 *
 * What survives is the interface and its row shapes. `evidence.ts`,
 * `seatTickSources.ts` and `run.ts` are typed against them, and they are the
 * honest description of what the scan needs: a driver supplies them from
 * wherever it actually has them — in-process readers for anything inside the
 * Viewer, a fake in a test — rather than from one transport this module
 * hard-coded. The single-flight lock went the same way and for the same reason
 * (see {@link MonitorDeps.claim}): one clock in one process needs no lock, and
 * a lock kept for a driver that does not exist is a file to leak.
 */

export interface OrchestratorStatusResponse {
  record: { conversationId: string; path: string | null; createdAt: string } | null;
  exists: boolean;
}

export interface ConversationSummary {
  path: string;
  project: string;
  title: string;
  /** Unix seconds, as the catalog reports it. */
  mtime: number;
  kind: string;
  engine: string;
}

export interface TaskSummary {
  id: string;
  project: string;
  status: string;
  text: string;
  updatedAt: string;
  assignments?: { state?: string; path?: string | null; conversationId?: string | null }[];
  pipelineIds?: string[];
}

export interface PipelineSummary {
  id: string;
  task: string;
  project: string;
  state: string;
  createdAt: string;
  closedAt: string | null;
  spec?: string;
  /** Every instant the container itself recorded movement at: stage attempt
      starts and completions, pauses and resumes. Creation time is NOT movement
      — a container running for a week is not stale because it started a week
      ago — so this is what staleness is judged on. Empty means the payload
      carried no movement evidence, and freshness is unknown. */
  activityAt: string[];
}

export interface FlowSummary {
  id: string;
  project: string;
  state: string;
  spec?: string;
  createdAt: string;
  closedAt: string | null;
  /** Round-level movement: spawn, review, relay and terminal instants. Same
      contract as {@link PipelineSummary.activityAt}. */
  activityAt: string[];
}

export interface CreateCardInput {
  project: string;
  text: string;
  /** Idempotency key echoed by the create route's replay receipts. */
  clientRequestId: string;
}

export interface DeliveryResult {
  /** The route's own verdict: `delivered-to-live`, `resumed`, `held`, … */
  outcome: string | null;
  /** True when the send booted a session rather than reaching a live one. */
  spawned: boolean;
}

export interface DeliveryInput {
  conversationId: string;
  text: string;
  clientMessageId: string;
}

export interface ViewerApi {
  orchestrator(project: string): Promise<OrchestratorStatusResponse>;
  /** The host currently owning a transcript, or null when nothing does. A
      read-only liveness probe: delivering into a conversation with no host
      would RESUME it, and waking sessions is not the monitor's business. */
  hostTarget(transcriptPath: string): Promise<string | null>;
  conversations(query: { project?: string; limit?: number }): Promise<ConversationSummary[]>;
  session(transcriptPath: string): Promise<MonitorSessionRecord[]>;
  tasks(): Promise<TaskSummary[]>;
  pipelines(): Promise<PipelineSummary[]>;
  flows(): Promise<FlowSummary[]>;
  createCard(input: CreateCardInput): Promise<{ taskId: string }>;
  deliver(input: DeliveryInput): Promise<DeliveryResult>;
  /** Audit journal, owned by the viewer: the monitor never opens the file. */
  readRuns(limit: number): Promise<MonitorRunRecord[]>;
  appendRun(record: MonitorRunRecord): Promise<void>;
}
