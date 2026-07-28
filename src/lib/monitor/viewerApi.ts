import type { MonitorSessionRecord } from "./requests";
import type { MonitorRunRecord } from "./types";

/**
 * The monitor's only door into the machine (issue #741).
 *
 * Every fact it reads and every write it makes goes through the Viewer's HTTP
 * API — the orchestrator record, the conversation catalog, transcripts, board
 * cards, pipelines and flows alike. The mechanism this replaces read
 * `state/pipelines.json` off disk, which is how it kept "working" against a
 * shape the viewer had long since stopped being the only writer of.
 *
 * The interface is what the run logic depends on, so a test drives a fake in
 * memory instead of standing up a server.
 */

export interface OrchestratorStatusResponse {
  record: { conversationId: string; path: string | null; createdAt: string } | null;
  exists: boolean;
  defaultCwd: string;
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

/** The single-flight admission the viewer granted, or who holds it. */
export type RunLockClaim =
  | { claimed: true; token: string }
  | { claimed: false; detail: string };

export interface ViewerApi {
  orchestrator(): Promise<OrchestratorStatusResponse>;
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
  /** Atomic single-flight admission, likewise owned by the viewer. */
  claimRunLock(): Promise<RunLockClaim>;
  releaseRunLock(token: string): Promise<boolean>;
}

export class ViewerApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "ViewerApiError";
  }
}

export interface HttpViewerApiOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The parsable ISO instants among a pile of maybe-timestamps. */
function timestamps(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
}

/** The Viewer speaks HTTP on loopback; the same-origin headers mirror what the
    MCP bindings send so the CSRF gate on mutating routes is satisfied. */
export function httpViewerApi(options: HttpViewerApiOptions): ViewerApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.baseUrl.replace(/\/+$/, "");

  async function call(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(pathname, `${base}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new ViewerApiError(`viewer request to ${pathname} failed: ${error instanceof Error ? error.message : "unknown error"}`, null);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ViewerApiError(`viewer request to ${pathname} returned ${response.status}`, response.status);
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new ViewerApiError(`viewer response for ${pathname} was not JSON: ${error instanceof Error ? error.message : "unknown error"}`, response.status);
    }
  }

  return {
    async orchestrator() {
      const payload = object(await call("api/orchestrator"));
      const record = payload.record === null || payload.record === undefined ? null : object(payload.record);
      return {
        record: record && str(record.conversationId)
          ? { conversationId: str(record.conversationId), path: typeof record.path === "string" ? record.path : null, createdAt: str(record.createdAt) }
          : null,
        exists: payload.exists === true,
        defaultCwd: str(payload.defaultCwd),
      };
    },

    async hostTarget(transcriptPath) {
      const payload = object(await call(`api/tmux?path=${encodeURIComponent(transcriptPath)}`));
      return typeof payload.target === "string" && payload.target ? payload.target : null;
    },

    async conversations(query) {
      const params = new URLSearchParams();
      if (query.project) params.set("project", query.project);
      if (query.limit) params.set("limit", String(query.limit));
      const suffix = params.toString();
      const payload = object(await call(`api/conversations${suffix ? `?${suffix}` : ""}`));
      return array(payload.items).map((raw) => {
        const item = object(raw);
        return {
          path: str(item.path),
          project: str(item.project),
          title: str(item.title),
          mtime: num(item.mtime),
          kind: str(item.kind),
          engine: str(item.engine),
        };
      }).filter((item) => item.path);
    },

    async session(transcriptPath) {
      const payload = object(await call(`api/session?path=${encodeURIComponent(transcriptPath)}`));
      return array(payload.messages).map((raw) => {
        const message = object(raw);
        return {
          kind: str(message.kind),
          role: str(message.role),
          ts: typeof message.ts === "string" ? message.ts : null,
          text: str(message.text),
        };
      });
    },

    async tasks() {
      const payload = object(await call("api/tasks"));
      return array(payload.tasks).map((raw) => {
        const task = object(raw);
        return {
          id: str(task.id),
          project: str(task.project),
          status: str(task.status),
          text: str(task.text),
          updatedAt: str(task.updatedAt),
          assignments: array(task.assignments).map((entry) => {
            const assignment = object(entry);
            return { state: str(assignment.state), path: typeof assignment.path === "string" ? assignment.path : null };
          }),
          pipelineIds: array(task.pipelineIds).map((id) => str(id)).filter(Boolean),
        };
      }).filter((task) => task.id);
    },

    async pipelines() {
      const payload = object(await call("api/pipelines"));
      return array(payload.pipelines).map((raw) => {
        const pipeline = object(raw);
        /* Attempt-level instants are where a long-running container actually
           shows movement; the container's own createdAt never changes. */
        const activityAt = timestamps([
          pipeline.pausedAt,
          pipeline.resumedAt,
          pipeline.updatedAt,
          ...array(pipeline.runs).flatMap((run) =>
            array(object(run).attempts).flatMap((attempt) => {
              const entry = object(attempt);
              return [entry.startedAt, entry.completedAt];
            })),
        ]);
        return {
          id: str(pipeline.id),
          task: str(pipeline.task),
          project: str(pipeline.project),
          state: str(pipeline.state),
          createdAt: str(pipeline.createdAt),
          closedAt: typeof pipeline.closedAt === "string" ? pipeline.closedAt : null,
          spec: str(pipeline.spec),
          activityAt,
        };
      }).filter((pipeline) => pipeline.id);
    },

    async flows() {
      const payload = object(await call("api/flows"));
      return array(payload.flows).map((raw) => {
        const flow = object(raw);
        const activityAt = timestamps(array(flow.rounds).flatMap((round) => {
          const entry = object(round);
          return [entry.startedAt, entry.spawnStartedAt, entry.relayStartedAt, entry.reviewedAt, entry.relayedAt, entry.terminalAt];
        }));
        return {
          id: str(flow.id),
          project: str(flow.project),
          state: str(flow.state),
          spec: str(flow.spec),
          createdAt: str(flow.createdAt),
          closedAt: typeof flow.closedAt === "string" ? flow.closedAt : null,
          activityAt,
        };
      }).filter((flow) => flow.id);
    },

    async createCard(input) {
      const payload = object(await call("api/tasks", {
        method: "POST",
        body: JSON.stringify({
          project: input.project,
          text: input.text,
          placement: "unplaced",
          clientRequestId: input.clientRequestId,
        }),
      }));
      const task = object(payload.task);
      const taskId = str(task.id);
      if (!taskId) throw new ViewerApiError("board create returned no task id", null);
      return { taskId };
    },

    async readRuns(limit) {
      const payload = object(await call(`api/monitor/runs?limit=${encodeURIComponent(String(limit))}`));
      return array(payload.runs).filter((run): run is MonitorRunRecord => Boolean(run) && typeof run === "object");
    },

    async appendRun(record) {
      await call("api/monitor/runs", { method: "POST", body: JSON.stringify({ record }) });
    },

    async claimRunLock() {
      const payload = object(await call("api/monitor/lock", { method: "POST", body: JSON.stringify({ action: "claim" }) }));
      if (payload.claimed === true && typeof payload.token === "string") return { claimed: true, token: payload.token };
      return { claimed: false, detail: str(payload.detail, "the monitor lock is held") };
    },

    async releaseRunLock(token) {
      const payload = object(await call("api/monitor/lock", { method: "POST", body: JSON.stringify({ action: "release", token }) }));
      return payload.released === true;
    },

    async deliver(input): Promise<DeliveryResult> {
      const payload = object(await call("api/tmux", {
        method: "POST",
        body: JSON.stringify({
          pid: null,
          path: "",
          conversationId: input.conversationId,
          clientMessageId: input.clientMessageId,
          text: input.text,
          images: [],
        }),
      }));
      return {
        outcome: typeof payload.outcome === "string" ? payload.outcome : null,
        spawned: payload.spawned === true || payload.outcome === "resumed",
      };
    },
  };
}
