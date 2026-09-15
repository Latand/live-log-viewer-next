import type { Database as BunDatabase } from "bun:sqlite";

import {
  MCP_OPERATION_TOOLS,
  isMcpOperationTool,
  type McpOperationCaller,
  type McpOperationTarget,
  type McpOperationTool,
} from "./receiptsDatabase";

/**
 * The read-only operations feed (#1695 C5): what `create_pipeline` and
 * `update_task` calls did, read from the MCP receipt rows that already decide
 * their idempotency and from the pipelines their creations stamped. Nothing
 * here claims, settles, replays or rewrites anything, and no arguments or
 * result bodies leave this module.
 */

export const MCP_OPERATIONS_MAX_LIMIT = 50;

/** A claim with no result stays pending for this long. The tool call deadline
    is 30 s; a claim still unanswered after four of them has most likely lost
    its process, and nothing can prove it did not, so it reads unknown. */
export const MCP_OPERATION_PENDING_LEASE_MS = 120_000;

const MAX_REFUSAL_CHARS = 200;

export type McpOperationState = "pending" | "accepted" | "failed" | "unknown";

export interface McpOperation {
  /** The receipt row's sequence; stable for the life of the call. */
  sequence: number;
  tool: McpOperationTool;
  /** The receipt digest; stable for the life of the call.
      `Pipeline.creationReceipt.requestDigest` carries the same value. */
  requestDigest: string;
  state: McpOperationState;
  claimedAt: string;
  callerConversationId: string | null;
  callerProject: string | null;
  /** Where the operation lands. Pending, unknown and refused rows carry the
      target validated when the call was claimed; an accepted row carries what
      its result or its stamped pipeline names. Null: the target is unknown. */
  target: McpOperationTarget | null;
  /** The recorded refusal, shortened; only on `failed`. */
  refusal: string | null;
}

export interface McpOperationsPage {
  operations: McpOperation[];
  /** Pass back unchanged. It moves past every row this page considered;
      unresolved rows are followed through `unresolved`. */
  after: number;
  /** More matching rows follow `after`. */
  hasMore: boolean;
  /** The current state of each requested unresolved sequence in this project,
      and of the creations stamped into this project after `creationsAfter`,
      without the rows already in `operations`. */
  refreshed: McpOperation[];
  /** Pass back unchanged: the last stamped creation this reader has been
      answered. Stamps are ordered as they committed, so every later stamp is
      after it, however late it comes. */
  creationsAfter: string;
  /** More stamped creations follow `creationsAfter`. */
  creationsHasMore: boolean;
}

export interface McpOperationsRequest {
  project: string;
  /** Rows after this sequence; null reads the newest rows. */
  after: number | null;
  limit: number;
  /** Sequences the reader still holds as pending or unknown. At most 50 are
      read per page; a reader holding more sends the rest on later pages. */
  unresolved?: readonly number[];
  /** The cursor a previous page returned. Absent, the reader starts at the
      newest stamp: creations stamped before it are cards already. */
  creationsAfter?: string | null;
}

/** A stored pipeline stamped with a creation receipt (C8). */
export interface McpPipelineCreation {
  pipelineId: string;
  project: string;
  claimedAt: string;
  /** The stamp's commit-ordered time; a stamp without one is never discovered,
      though it still scopes its row. */
  recordedAt: string | null;
}

export interface McpOperationsOptions {
  now?: number;
  /** Stamped pipelines by their creation digest. */
  creations?: ReadonlyMap<string, McpPipelineCreation>;
}

type ReceiptRow = {
  sequence: number;
  receipt_key: string;
  digest: string;
  result_json: string | null;
  claimed_at: number;
  caller_json: string | null;
  target_json: string | null;
};

type CreationKey = { at: number; digest: string };

const START_OF_CREATIONS: CreationKey = { at: 0, digest: "" };

function compareCreationKeys(left: CreationKey, right: CreationKey): number {
  return left.at - right.at || (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0);
}

export function formatCreationsCursor(key: CreationKey): string {
  return `${key.at}:${key.digest}`;
}

/** Reads a `creationsAfter` cursor, or answers null for anything else. */
export function parseCreationsCursor(value: string): CreationKey | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const at = Number(value.slice(0, separator));
  return /^\d+$/.test(value.slice(0, separator)) && Number.isSafeInteger(at) ? { at, digest: value.slice(separator + 1) } : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseJson(serialized: string | null): unknown {
  if (serialized === null) return null;
  try {
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function callerOf(serialized: string | null): McpOperationCaller | null {
  const caller = record(parseJson(serialized));
  if (!caller || !["root", "worker", "unidentified"].includes(String(caller.kind))) return null;
  return {
    kind: caller.kind as McpOperationCaller["kind"],
    conversationId: text(caller.conversationId),
    project: text(caller.project),
  };
}

function claimedTargetOf(serialized: string | null): McpOperationTarget | null {
  const target = record(parseJson(serialized));
  const project = text(target?.project);
  return target && project ? { project, taskId: text(target.taskId), pipelineId: text(target.pipelineId) } : null;
}

/** The target an accepted result names, without copying its body. */
function acceptedTarget(tool: McpOperationTool, result: Record<string, unknown>, claimed: McpOperationTarget | null): McpOperationTarget | null {
  if (tool === "create_pipeline") {
    const pipeline = record(result.pipeline);
    const project = text(pipeline?.project);
    const pipelineId = text(result.pipelineId) ?? text(pipeline?.id);
    return project && pipelineId ? { project, taskId: claimed?.taskId ?? null, pipelineId } : claimed;
  }
  const task = record(result.task) ?? record(Array.isArray(result.tasks) ? result.tasks[0] : null);
  const project = text(task?.project);
  const taskId = text(result.taskId) ?? text(task?.id);
  return project && taskId ? { project, taskId, pipelineId: null } : claimed;
}

function operationOf(row: ReceiptRow, now: number, creations: ReadonlyMap<string, McpPipelineCreation>): McpOperation | null {
  const tool = row.receipt_key.slice(0, row.receipt_key.indexOf(":"));
  if (!isMcpOperationTool(tool)) return null;
  const caller = callerOf(row.caller_json);
  const claimed = claimedTargetOf(row.target_json);
  const base = {
    sequence: row.sequence,
    tool,
    requestDigest: row.digest,
    claimedAt: new Date(row.claimed_at).toISOString(),
    callerConversationId: caller?.conversationId ?? null,
    callerProject: caller?.project ?? null,
  };
  /* The durable pipeline outranks the receipt: a card stamped with this
     digest exists, whatever the row managed to record. */
  const creation = tool === "create_pipeline" ? creations.get(row.digest) : undefined;
  if (creation) {
    const target = { project: creation.project, taskId: claimed?.taskId ?? null, pipelineId: creation.pipelineId };
    return { ...base, state: "accepted", target, refusal: null };
  }
  if (row.result_json === null) {
    const state = now - row.claimed_at <= MCP_OPERATION_PENDING_LEASE_MS ? "pending" : "unknown";
    return { ...base, state, target: claimed, refusal: null };
  }
  const result = record(parseJson(row.result_json));
  if (result?.ok === true) return { ...base, state: "accepted", target: acceptedTarget(tool, result, claimed), refusal: null };
  if (result?.ok === false) {
    const error = text(result.error) ?? "refused";
    const refusal = error.length > MAX_REFUSAL_CHARS ? `${error.slice(0, MAX_REFUSAL_CHARS - 1)}…` : error;
    return { ...base, state: "failed", target: claimed, refusal };
  }
  return { ...base, state: "unknown", target: claimed, refusal: null };
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(MCP_OPERATIONS_MAX_LIMIT, Math.max(1, Math.floor(limit))) : MCP_OPERATIONS_MAX_LIMIT;
}

function unresolvedSequences(values: readonly number[] | undefined): number[] {
  return [...new Set((values ?? []).filter((value) => Number.isSafeInteger(value) && value > 0))].slice(0, MCP_OPERATIONS_MAX_LIMIT);
}

/**
 * One page of a project's operations, ascending by sequence, with the current
 * state of the unresolved rows the reader asks about and the next creations
 * stamped into the project. A row belongs to the project when its recorded
 * caller, its claimed target, its result's target or a pipeline stamped with
 * its digest is in it.
 */
export function readMcpOperations(
  db: BunDatabase | null,
  request: McpOperationsRequest,
  options: McpOperationsOptions = {},
): McpOperationsPage {
  const creations = options.creations ?? new Map<string, McpPipelineCreation>();
  const projectCreations = [...creations].filter(([, creation]) => creation.project === request.project);
  /* Discovery walks the project's stamps in commit order from the reader's
     cursor, at most a page at a time, so every stamp is answered once the
     reader has paged up to it, however late it was stamped. */
  const stamps = projectCreations
    .map(([digest, creation]): CreationKey | null => {
      const at = Date.parse(creation.recordedAt ?? "");
      return Number.isFinite(at) && at >= 0 ? { at, digest } : null;
    })
    .filter((key): key is CreationKey => key !== null)
    .sort(compareCreationKeys);
  const cursor = request.creationsAfter ? parseCreationsCursor(request.creationsAfter) : null;
  const undiscovered = cursor ? stamps.filter((key) => compareCreationKeys(key, cursor) > 0) : [];
  const discovered = undiscovered.slice(0, MCP_OPERATIONS_MAX_LIMIT);
  const creationsHasMore = undiscovered.length > discovered.length;
  const creationsAfter = formatCreationsCursor(cursor ? discovered.at(-1) ?? cursor : stamps.at(-1) ?? START_OF_CREATIONS);

  const empty = { operations: [], after: request.after ?? 0, hasMore: false, refreshed: [], creationsAfter: request.creationsAfter && cursor ? request.creationsAfter : formatCreationsCursor(START_OF_CREATIONS), creationsHasMore: false };
  if (!db) return empty;
  const limit = clampLimit(request.limit);
  const now = options.now ?? Date.now();
  const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(mcp_receipts)").all().map((column) => column.name));
  if (!columns.size) return empty;
  /* A database no MCP process has migrated yet lacks the claim columns. */
  const callerColumn = columns.has("caller_json") ? "caller_json" : "NULL";
  const targetColumn = columns.has("target_json") ? "target_json" : "NULL";
  /* CASE guards json_extract, so one malformed row cannot fail the page. */
  const field = (column: string, path: string) => `(CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END)`;
  const toolFilter = MCP_OPERATION_TOOLS.map(() => "receipt_key LIKE ? ESCAPE '\\'").join(" OR ");
  const toolPatterns = MCP_OPERATION_TOOLS.map((tool) => `${tool.replaceAll("_", "\\_")}:%`);
  /* The stamped-pipeline digests scope rows before any paging, so a creation
     proven only by its pipeline is never filtered out of that project. */
  const scope = `(
    ${field(callerColumn, "$.project")} = ?
    OR ${field(targetColumn, "$.project")} = ?
    OR (CASE WHEN json_valid(result_json) THEN coalesce(
      json_extract(result_json, '$.pipeline.project'),
      json_extract(result_json, '$.task.project'),
      json_extract(result_json, '$.tasks[0].project')
    ) END) = ?
    OR digest IN (SELECT value FROM json_each(?))
  )`;
  const filters: (string | number)[] = [
    ...toolPatterns,
    request.project, request.project, request.project,
    JSON.stringify(projectCreations.map(([digest]) => digest)),
  ];
  const select = `SELECT sequence, receipt_key, digest, result_json, claimed_at, ${callerColumn} AS caller_json, ${targetColumn} AS target_json
    FROM mcp_receipts WHERE (${toolFilter}) AND ${scope}`;
  const operationsOf = (rows: ReceiptRow[]) => rows
    .map((row) => operationOf(row, now, creations))
    .filter((operation): operation is McpOperation => operation !== null);
  return db.transaction(() => {
    const maxSequence = db.query<{ sequence: number | null }, []>("SELECT MAX(sequence) AS sequence FROM mcp_receipts").get()?.sequence ?? 0;
    let rows: ReceiptRow[];
    let hasMore = false;
    if (request.after === null) {
      rows = db.query<ReceiptRow, (string | number)[]>(`${select} ORDER BY sequence DESC LIMIT ?`).all(...filters, limit).reverse();
    } else {
      rows = db.query<ReceiptRow, (string | number)[]>(`${select} AND sequence > ? ORDER BY sequence ASC LIMIT ?`)
        .all(...filters, request.after, limit + 1);
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
    }
    const operations = operationsOf(rows);
    const after = hasMore ? rows.at(-1)!.sequence : Math.max(maxSequence, request.after ?? 0);
    /* Reconciliation is bounded and read-only: the sequences the reader still
       holds unresolved, and the next stamped creations after its creations
       cursor. Both are answered by the same sequence and digest, and newer rows
       keep paging independently. */
    const unresolved = unresolvedSequences(request.unresolved);
    if (!unresolved.length && !discovered.length) return { operations, after, hasMore, refreshed: [], creationsAfter, creationsHasMore };
    const listed = new Set(operations.map((operation) => operation.sequence));
    const refreshed = operationsOf(db.query<ReceiptRow, (string | number)[]>(`${select}
      AND ((sequence <= ? AND sequence IN (SELECT value FROM json_each(?))) OR digest IN (SELECT value FROM json_each(?)))
      ORDER BY sequence ASC LIMIT ?`)
      .all(...filters, after, JSON.stringify(unresolved), JSON.stringify(discovered.map((key) => key.digest)), MCP_OPERATIONS_MAX_LIMIT * 2))
      .filter((operation) => !listed.has(operation.sequence));
    return { operations, after, hasMore, refreshed, creationsAfter, creationsHasMore };
  })();
}
