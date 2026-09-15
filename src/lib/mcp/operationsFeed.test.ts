import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import {
  MCP_OPERATION_PENDING_LEASE_MS,
  readMcpOperations,
  type McpOperation,
  type McpPipelineCreation,
} from "./operationsFeed";
import { openMcpReceiptsReadOnly, type McpOperationCaller, type McpOperationTarget } from "./receiptsDatabase";
import {
  MCP_TOOL_NAMES,
  SqliteMcpReceiptStore,
  createMcpToolService,
  type McpToolBindings,
  type McpToolCallContext,
} from "./server";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;
const MANAGER: McpOperationCaller = { kind: "worker", conversationId: "conversation_manager", project: "alpha" };
const BETA_TASK: McpOperationTarget = { project: "beta", taskId: "task-beta", pipelineId: null };
const EMPTY_CREATIONS = { creationsAfter: "0:", creationsHasMore: false };

function receiptsFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-operations-"));
  scratch.push(directory);
  return path.join(directory, "mcp-receipts.sqlite");
}

/** A receipt database in the current schema, created by the real store. */
function seededDatabase(): { file: string; db: Database } {
  const file = receiptsFile();
  new SqliteMcpReceiptStore(file).close();
  return { file, db: new Database(file, { strict: true }) };
}

function insert(db: Database, row: {
  key: string;
  digest?: string;
  result?: unknown;
  rawResult?: string;
  claimedAt?: number;
  caller?: McpOperationCaller | null;
  target?: McpOperationTarget | null;
}): void {
  const result = row.rawResult ?? (row.result === undefined ? null : JSON.stringify(row.result));
  db.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at, caller_json, target_json) VALUES (?, ?, 'durable', ?, 1, ?, ?, ?)")
    .run(
      row.key, row.digest ?? `digest-${row.key}`, result, row.claimedAt ?? NOW,
      row.caller ? JSON.stringify(row.caller) : null,
      row.target ? JSON.stringify(row.target) : null,
    );
}

function settle(db: Database, key: string, result: unknown): void {
  db.query("UPDATE mcp_receipts SET result_json = ? WHERE receipt_key = ?").run(JSON.stringify(result), key);
}

function creation(pipelineId: string, project: string, recordedAt: number | null): McpPipelineCreation {
  return {
    pipelineId,
    project,
    claimedAt: new Date(NOW - MINUTE).toISOString(),
    recordedAt: recordedAt === null ? null : new Date(recordedAt).toISOString(),
  };
}

function stubBindings(overrides: Partial<McpToolBindings>): McpToolBindings {
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
  return Object.assign(bindings, overrides);
}

function receiptKeys(db: Database): Map<number, string> {
  return new Map(db.query<{ sequence: number; receipt_key: string }, []>("SELECT sequence, receipt_key FROM mcp_receipts").all()
    .map((row) => [row.sequence, row.receipt_key]));
}

const sequences = (operations: McpOperation[]) => operations.map((operation) => operation.sequence);

test("an operations-feed claim records the server-derived caller and the validated target, and hands its binding the claimed receipt", async () => {
  const file = receiptsFile();
  const store = new SqliteMcpReceiptStore(file, { now: () => NOW });
  const contexts = new Map<string, McpToolCallContext | undefined>();
  const answer = (result: Record<string, unknown>) => async (args: Record<string, unknown>, context?: McpToolCallContext) => {
    contexts.set(String(args.clientRequestId), context);
    return result;
  };
  const service = createMcpToolService(stubBindings({
    create_pipeline: answer({ pipelineId: "pipe-1", pipeline: { id: "pipe-1", project: "beta" } }),
    update_task: answer({ taskId: "task-beta", task: { id: "task-beta", project: "beta" } }),
    create_task: answer({ taskId: "task-2" }),
  }), store, undefined, {
    operationCaller: () => MANAGER,
    operationTarget: (_toolName, args) => (args.taskId === "task-beta" ? BETA_TASK : null),
  });

  const startedAt = Date.now();
  expect((await service.callTool("create_pipeline", { clientRequestId: "create-1", task: "Ship", taskId: "task-beta" })).ok).toBeTrue();
  expect((await service.callTool("update_task", { clientRequestId: "update-1", taskId: "task-beta", status: "done" })).ok).toBeTrue();
  expect((await service.callTool("update_task", { clientRequestId: "refine-1", refine: { text: "Title" } })).ok).toBeTrue();
  expect((await service.callTool("create_task", { clientRequestId: "task-1", project: "alpha", text: "Other" })).ok).toBeTrue();
  /* A replay reaches neither the binding nor a second row. */
  expect((await service.callTool("create_pipeline", { clientRequestId: "create-1", task: "Ship", taskId: "task-beta" })).replayed).toBeTrue();
  store.close();

  const db = new Database(file, { readonly: true, strict: true });
  const rows = db.query<{ receipt_key: string; digest: string; caller_json: string | null; target_json: string | null }, []>(
    "SELECT receipt_key, digest, caller_json, target_json FROM mcp_receipts ORDER BY sequence",
  ).all();
  db.close();
  const parsed = (value: string | null) => (value === null ? null : JSON.parse(value));
  expect(rows.map((row) => [row.receipt_key, parsed(row.caller_json), parsed(row.target_json)])).toEqual([
    ["create_pipeline:create-1", MANAGER, BETA_TASK],
    ["update_task:update-1", MANAGER, BETA_TASK],
    ["update_task:refine-1", MANAGER, null],
    ["create_task:task-1", null, null],
  ]);
  const createReceipt = contexts.get("create-1")?.receipt;
  expect(createReceipt).toEqual({ digest: rows[0]!.digest, claimedAt: expect.any(String), caller: MANAGER });
  const claimedAt = Date.parse(createReceipt!.claimedAt);
  expect(claimedAt >= startedAt && claimedAt <= Date.now()).toBeTrue();
  expect(contexts.get("update-1")?.receipt?.digest).toBe(rows[1]!.digest);
  expect(contexts.get("task-1")?.receipt).toBeUndefined();
});

test("resolver faults record no caller and no target, and never refuse the call", async () => {
  const file = receiptsFile();
  const store = new SqliteMcpReceiptStore(file, { now: () => NOW });
  let receipt: McpToolCallContext["receipt"];
  const service = createMcpToolService(stubBindings({
    update_task: async (_args, context) => {
      receipt = context?.receipt;
      return { taskId: "task-1" };
    },
  }), store, undefined, {
    operationCaller: () => {
      throw new Error("process ancestry unreadable");
    },
    operationTarget: () => {
      throw new Error("task store unreadable");
    },
  });

  expect((await service.callTool("update_task", { clientRequestId: "update-1", taskId: "task-1" })).ok).toBeTrue();
  store.close();
  const db = new Database(file, { readonly: true, strict: true });
  expect(db.query<{ caller_json: string | null; target_json: string | null }, []>("SELECT caller_json, target_json FROM mcp_receipts").get())
    .toEqual({ caller_json: null, target_json: null });
  db.close();
  expect(receipt?.caller).toBeNull();
});

test("while calls are held, pending and unknown rows name their claimed targets; an unrelated project sees nothing and a call naming no task reads target unknown", async () => {
  const file = receiptsFile();
  const store = new SqliteMcpReceiptStore(file, { now: () => NOW });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const service = createMcpToolService(stubBindings({
    update_task: async (args) => {
      entered += 1;
      await gate;
      return args.refine
        ? { refined: [], tasks: [{ id: "task-alpha", project: "alpha" }] }
        : { taskId: "task-beta", task: { id: "task-beta", project: "beta" } };
    },
    create_pipeline: async () => {
      entered += 1;
      await gate;
      return { pipelineId: "pipe-1", pipeline: { id: "pipe-1", project: "beta" } };
    },
  }), store, undefined, {
    operationCaller: () => MANAGER,
    operationTarget: (_toolName, args) => (args.taskId === "task-beta" ? BETA_TASK : null),
  });
  const calls = Promise.all([
    service.callTool("update_task", { clientRequestId: "move", taskId: "task-beta", status: "done" }),
    service.callTool("create_pipeline", { clientRequestId: "create", task: "Ship", taskId: "task-beta" }),
    service.callTool("update_task", { clientRequestId: "refine", refine: { text: "Title" } }),
  ]);
  for (let attempt = 0; entered < 3 && attempt < 400; attempt += 1) await Bun.sleep(5);
  expect(entered).toBe(3);

  const reader = openMcpReceiptsReadOnly(file)!;
  const keys = receiptKeys(reader);
  const view = (operations: McpOperation[]) => operations
    .map((operation) => [keys.get(operation.sequence), operation.state, operation.target] as const)
    .sort(([left], [right]) => String(left).localeCompare(String(right)));

  expect(view(readMcpOperations(reader, { project: "beta", after: null, limit: 50 }, { now: NOW + 1_000 }).operations)).toEqual([
    ["create_pipeline:create", "pending", BETA_TASK],
    ["update_task:move", "pending", BETA_TASK],
  ]);
  const alpha = readMcpOperations(reader, { project: "alpha", after: null, limit: 50 }, { now: NOW + 1_000 });
  expect(view(alpha.operations)).toEqual([
    ["create_pipeline:create", "pending", BETA_TASK],
    ["update_task:move", "pending", BETA_TASK],
    ["update_task:refine", "pending", null],
  ]);
  expect(readMcpOperations(reader, { project: "gamma", after: null, limit: 50 }, { now: NOW + 1_000 }).operations).toEqual([]);
  /* Past the lease the same rows read unknown and keep their targets. */
  expect(view(readMcpOperations(reader, { project: "beta", after: null, limit: 50 }, { now: NOW + MCP_OPERATION_PENDING_LEASE_MS + 1 }).operations)).toEqual([
    ["create_pipeline:create", "unknown", BETA_TASK],
    ["update_task:move", "unknown", BETA_TASK],
  ]);

  release();
  expect((await calls).map((result) => result.ok)).toEqual([true, true, true]);
  const settled = readMcpOperations(reader, {
    project: "alpha",
    after: alpha.after,
    limit: 50,
    unresolved: sequences(alpha.operations),
  }, { now: NOW + 2_000 });
  expect(settled.operations).toEqual([]);
  expect(view(settled.refreshed)).toEqual([
    ["create_pipeline:create", "accepted", { project: "beta", taskId: "task-beta", pipelineId: "pipe-1" }],
    ["update_task:move", "accepted", BETA_TASK],
    ["update_task:refine", "accepted", { project: "alpha", taskId: "task-alpha", pipelineId: null }],
  ]);
  const digests = (operations: McpOperation[]) => Object.fromEntries(operations.map((operation) => [operation.sequence, operation.requestDigest]));
  expect(digests(settled.refreshed)).toEqual(digests(alpha.operations));
  reader.close();
  store.close();
});

test("each receipt state reads truthfully: pending in the lease, unknown after it, accepted with its target, failed with a short refusal", () => {
  const { db } = seededDatabase();
  insert(db, { key: "create_pipeline:pending", caller: MANAGER, target: BETA_TASK, claimedAt: NOW - 1_000 });
  insert(db, { key: "update_task:lost", caller: MANAGER, target: BETA_TASK, claimedAt: NOW - MCP_OPERATION_PENDING_LEASE_MS - 1 });
  insert(db, { key: "create_pipeline:made", caller: MANAGER, target: BETA_TASK, result: { ok: true, pipelineId: "pipe-1", pipeline: { id: "pipe-1", project: "beta" } } });
  insert(db, { key: "update_task:moved", caller: MANAGER, result: { ok: true, taskId: "task-1", task: { id: "task-1", project: "alpha" } } });
  insert(db, { key: "create_pipeline:refused", caller: MANAGER, target: BETA_TASK, result: { ok: false, error: `stages[0].kind: ${"x".repeat(400)}` } });
  insert(db, { key: "update_task:garbled", caller: MANAGER, rawResult: "{not json" });

  const page = readMcpOperations(db, { project: "alpha", after: 0, limit: 50 }, { now: NOW });
  const byKey = Object.fromEntries(page.operations.map((operation) => [operation.requestDigest.replace("digest-", ""), operation]));
  expect(byKey["create_pipeline:pending"]).toMatchObject({ state: "pending", tool: "create_pipeline", callerConversationId: "conversation_manager", callerProject: "alpha", target: BETA_TASK });
  expect(byKey["update_task:lost"]).toMatchObject({ state: "unknown", target: BETA_TASK });
  expect(byKey["create_pipeline:made"]).toMatchObject({ state: "accepted", target: { project: "beta", taskId: "task-beta", pipelineId: "pipe-1" }, refusal: null });
  expect(byKey["update_task:moved"]).toMatchObject({ state: "accepted", target: { project: "alpha", taskId: "task-1", pipelineId: null } });
  expect(byKey["create_pipeline:refused"]).toMatchObject({ state: "failed", target: BETA_TASK });
  expect(byKey["create_pipeline:refused"]?.refusal?.startsWith("stages[0].kind: ")).toBeTrue();
  expect(byKey["create_pipeline:refused"]?.refusal?.length).toBe(200);
  expect(byKey["update_task:garbled"]).toMatchObject({ state: "unknown", target: null });
  expect(byKey["create_pipeline:pending"]?.claimedAt).toBe(new Date(NOW - 1_000).toISOString());
  db.close();
});

test("a row belongs to a project by its caller, its claimed target, its result's target or its stamped pipeline, and no other tool appears", () => {
  const { db } = seededDatabase();
  const beta: McpOperationCaller = { ...MANAGER, project: "beta" };
  insert(db, { key: "update_task:mine", caller: MANAGER, result: { ok: true, taskId: "t1", task: { id: "t1", project: "alpha" } } });
  insert(db, { key: "create_pipeline:into-alpha", caller: beta, result: { ok: true, pipelineId: "p1", pipeline: { id: "p1", project: "alpha" } } });
  insert(db, { key: "update_task:refined", caller: null, result: { ok: true, refined: [], tasks: [{ id: "t2", project: "alpha" }] } });
  insert(db, { key: "update_task:claimed-into-alpha", caller: beta, target: { project: "alpha", taskId: "t4", pipelineId: null } });
  insert(db, { key: "create_pipeline:stamped", caller: null });
  insert(db, { key: "update_task:elsewhere", caller: beta, result: { ok: true, taskId: "t3", task: { id: "t3", project: "beta" } } });
  insert(db, { key: "send_message:alpha", caller: MANAGER, result: { ok: true } });
  insert(db, { key: "createXpipeline:lookalike", caller: MANAGER, result: { ok: true } });
  const creations = new Map([["digest-create_pipeline:stamped", creation("p5", "alpha", NOW)]]);

  const alpha = readMcpOperations(db, { project: "alpha", after: 0, limit: 50 }, { now: NOW, creations });
  expect(alpha.operations.map((operation) => operation.requestDigest)).toEqual([
    "digest-update_task:mine", "digest-create_pipeline:into-alpha", "digest-update_task:refined",
    "digest-update_task:claimed-into-alpha", "digest-create_pipeline:stamped",
  ]);
  expect(alpha.operations[2]).toMatchObject({ target: { project: "alpha", taskId: "t2", pipelineId: null }, callerConversationId: null });
  expect(alpha.operations[4]).toMatchObject({ state: "accepted", target: { project: "alpha", taskId: null, pipelineId: "p5" } });
  const betaPage = readMcpOperations(db, { project: "beta", after: 0, limit: 50 }, { now: NOW, creations });
  expect(betaPage.operations.map((operation) => operation.requestDigest)).toEqual([
    "digest-create_pipeline:into-alpha", "digest-update_task:claimed-into-alpha", "digest-update_task:elsewhere",
  ]);
  db.close();
});

test("pages are ascending: the newest rows without a cursor, then forward with hasMore and a cursor past everything considered", () => {
  const { db } = seededDatabase();
  for (let index = 1; index <= 5; index += 1) {
    insert(db, { key: `update_task:u${index}`, caller: MANAGER, result: { ok: true, taskId: `t${index}`, task: { id: `t${index}`, project: "alpha" } } });
  }
  insert(db, { key: "update_task:other", caller: { ...MANAGER, project: "beta" }, result: { ok: true } });

  const tail = readMcpOperations(db, { project: "alpha", after: null, limit: 2 }, { now: NOW });
  expect(sequences(tail.operations)).toEqual([4, 5]);
  expect(tail).toMatchObject({ after: 6, hasMore: false, refreshed: [] });

  const first = readMcpOperations(db, { project: "alpha", after: 0, limit: 2 }, { now: NOW });
  expect(sequences(first.operations)).toEqual([1, 2]);
  expect(first).toMatchObject({ after: 2, hasMore: true });
  const second = readMcpOperations(db, { project: "alpha", after: first.after, limit: 2 }, { now: NOW });
  expect(sequences(second.operations)).toEqual([3, 4]);
  const last = readMcpOperations(db, { project: "alpha", after: second.after, limit: 2 }, { now: NOW });
  expect(sequences(last.operations)).toEqual([5]);
  expect(last).toMatchObject({ after: 6, hasMore: false });
  expect(readMcpOperations(db, { project: "alpha", after: last.after, limit: 2 }, { now: NOW }))
    .toEqual({ operations: [], after: 6, hasMore: false, refreshed: [], ...EMPTY_CREATIONS });

  expect(readMcpOperations(db, { project: "alpha", after: 0, limit: 500 }, { now: NOW }).operations).toHaveLength(5);
  expect(readMcpOperations(db, { project: "alpha", after: 0, limit: 0 }, { now: NOW }).operations).toHaveLength(1);
  db.close();
});

test("an unresolved row the cursor has passed is answered when it settles, by the same sequence and digest, and never for another project", () => {
  const { db } = seededDatabase();
  insert(db, { key: "update_task:lost", caller: MANAGER, target: BETA_TASK, claimedAt: NOW - MCP_OPERATION_PENDING_LEASE_MS - 1 });
  insert(db, { key: "create_pipeline:running", caller: MANAGER, claimedAt: NOW - 500 });
  insert(db, { key: "update_task:beta-only", caller: { ...MANAGER, project: "beta" }, claimedAt: NOW - 500 });

  const first = readMcpOperations(db, { project: "alpha", after: null, limit: 50 }, { now: NOW });
  expect(first.operations.map((operation) => [operation.sequence, operation.state])).toEqual([[1, "unknown"], [2, "pending"]]);
  expect(first.after).toBe(3);
  /* Nothing new and nothing asked: the cursor stays and nothing repeats. */
  expect(readMcpOperations(db, { project: "alpha", after: first.after, limit: 50 }, { now: NOW }))
    .toEqual({ operations: [], after: 3, hasMore: false, refreshed: [], ...EMPTY_CREATIONS });

  settle(db, "update_task:lost", { ok: true, taskId: "task-beta", task: { id: "task-beta", project: "beta" } });
  settle(db, "create_pipeline:running", { ok: false, error: "stages[0].kind: stage kind must be run or review-loop" });
  settle(db, "update_task:beta-only", { ok: true, taskId: "t9", task: { id: "t9", project: "beta" } });
  const next = readMcpOperations(db, { project: "alpha", after: first.after, limit: 50, unresolved: [1, 2, 3, 99] }, { now: NOW + 1_000 });
  expect(next.operations).toEqual([]);
  expect(next.after).toBe(3);
  expect(next.refreshed.map((operation) => [operation.sequence, operation.requestDigest, operation.state, operation.refusal])).toEqual([
    [1, "digest-update_task:lost", "accepted", null],
    [2, "digest-create_pipeline:running", "failed", "stages[0].kind: stage kind must be run or review-loop"],
  ]);
  expect(next.refreshed[0]?.target).toEqual(BETA_TASK);
  db.close();
});

test("more than 50 unresolved rows are all observed settling in bounded batches while newer rows keep arriving", () => {
  const { db } = seededDatabase();
  for (let index = 1; index <= 60; index += 1) {
    insert(db, {
      key: `update_task:u${index}`,
      caller: MANAGER,
      target: { project: "alpha", taskId: `t${index}`, pipelineId: null },
      claimedAt: NOW - MCP_OPERATION_PENDING_LEASE_MS - 1,
    });
  }
  const states = new Map<number, string>();
  const unresolved = new Set<number>();
  let cursor: number | null = 0;
  const poll = () => {
    const batch = [...unresolved].slice(0, 50);
    const page = readMcpOperations(db, { project: "alpha", after: cursor, limit: 50, unresolved: batch }, { now: NOW });
    for (const operation of [...page.operations, ...page.refreshed]) {
      states.set(operation.sequence, operation.state);
      if (operation.state === "pending" || operation.state === "unknown") unresolved.add(operation.sequence);
      else unresolved.delete(operation.sequence);
    }
    /* Still-unresolved rows go to the back, so every row gets its turn. */
    for (const sequence of batch) {
      if (!unresolved.has(sequence)) continue;
      unresolved.delete(sequence);
      unresolved.add(sequence);
    }
    cursor = page.after;
    return page;
  };

  expect(poll().hasMore).toBeTrue();
  expect(poll().hasMore).toBeFalse();
  expect(unresolved.size).toBe(60);

  for (let index = 1; index <= 60; index += 1) {
    settle(db, `update_task:u${index}`, index % 2
      ? { ok: true, taskId: `t${index}`, task: { id: `t${index}`, project: "alpha" } }
      : { ok: false, error: "TASK_REVISION_MISMATCH" });
  }
  for (let index = 1; index <= 3; index += 1) {
    insert(db, { key: `update_task:new${index}`, caller: MANAGER, result: { ok: true, taskId: `n${index}`, task: { id: `n${index}`, project: "alpha" } } });
  }

  const third = poll();
  expect(sequences(third.operations)).toEqual([61, 62, 63]);
  expect(third.refreshed).toHaveLength(50);
  expect(unresolved.size).toBe(10);
  const fourth = poll();
  expect(fourth.refreshed).toHaveLength(10);
  expect(unresolved.size).toBe(0);
  expect([...states.entries()].filter(([sequence]) => sequence <= 60).map(([, state]) => state).sort())
    .toEqual([...Array(30).fill("accepted"), ...Array(30).fill("failed")]);

  /* A request carrying more than 50 sequences reads 50 of them. */
  const all = Array.from({ length: 60 }, (_value, index) => index + 1);
  expect(readMcpOperations(db, { project: "alpha", after: 63, limit: 50, unresolved: all }, { now: NOW }).refreshed).toHaveLength(50);
  db.close();
});

test("creations stamped after the project's cursor passed their rows are all discovered, 51 and more over resumable pages, however late, while newer rows flow and nobody else learns of them", () => {
  const { db } = seededDatabase();
  /* 52 creations with no caller and no target: odd ones never answered, even ones refused. */
  for (let index = 1; index <= 52; index += 1) {
    insert(db, {
      key: `create_pipeline:c${index}`,
      digest: `digest-c${index}`,
      caller: null,
      claimedAt: NOW - MINUTE,
      ...(index % 2 ? {} : { result: { ok: false, error: "MCP tool deadline exceeded" } }),
    });
  }

  /* Before any stamp nothing ties the rows to beta, and beta's cursors pass all of them. */
  const first = readMcpOperations(db, { project: "beta", after: null, limit: 50 }, { now: NOW });
  expect(first).toEqual({ operations: [], after: 52, hasMore: false, refreshed: [], ...EMPTY_CREATIONS });

  /* 51 are stamped into beta, in the reverse of their claim order; beta comes back twenty minutes later. */
  const creations = new Map<string, McpPipelineCreation>();
  for (let index = 51; index >= 1; index -= 1) creations.set(`digest-c${index}`, creation(`pipe-${index}`, "beta", NOW + (52 - index)));
  for (let index = 1; index <= 3; index += 1) {
    insert(db, { key: `update_task:new${index}`, caller: { ...MANAGER, project: "beta" }, result: { ok: true, taskId: `n${index}`, task: { id: `n${index}`, project: "beta" } } });
  }
  const seen = new Map<number, McpOperation>();
  let after: number | null = first.after;
  let creationsAfter = first.creationsAfter;
  const poll = (now: number) => {
    const page = readMcpOperations(db, { project: "beta", after, limit: 50, creationsAfter }, { now, creations });
    for (const operation of [...page.operations, ...page.refreshed]) seen.set(operation.sequence, operation);
    after = page.after;
    creationsAfter = page.creationsAfter;
    return page;
  };

  const second = poll(NOW + 20 * MINUTE);
  expect(sequences(second.operations)).toEqual([53, 54, 55]);
  expect(second.refreshed).toHaveLength(50);
  expect(second.creationsHasMore).toBeTrue();
  /* Stamp order, not claim order: sequence 1 was stamped last, so it comes on the next page. */
  expect(sequences(second.refreshed)).not.toContain(1);
  const third = poll(NOW + 21 * MINUTE);
  expect(sequences(third.refreshed)).toEqual([1]);
  expect(third.creationsHasMore).toBeFalse();
  const settledCursor = third.creationsAfter;
  expect(poll(NOW + 22 * MINUTE)).toMatchObject({ operations: [], refreshed: [], creationsAfter: settledCursor, creationsHasMore: false });

  /* Sequence 52 is stamped a day later, behind every cursor beta holds. */
  creations.set("digest-c52", creation("pipe-52", "beta", NOW + 24 * 60 * MINUTE));
  const late = poll(NOW + 24 * 60 * MINUTE + MINUTE);
  expect(sequences(late.refreshed)).toEqual([52]);

  const created = [...seen.values()].filter((operation) => operation.tool === "create_pipeline")
    .sort((left, right) => left.sequence - right.sequence)
    .map((operation) => [operation.sequence, operation.requestDigest, operation.state, operation.target, operation.callerConversationId]);
  expect(created).toEqual(Array.from({ length: 52 }, (_value, offset) => {
    const index = offset + 1;
    return [index, `digest-c${index}`, "accepted", { project: "beta", taskId: null, pipelineId: `pipe-${index}` }, null];
  }));

  for (const project of ["alpha", "gamma"]) {
    const page = readMcpOperations(db, { project, after: 0, limit: 50, unresolved: [1, 2, 3], creationsAfter: "0:" }, { now: NOW, creations });
    expect(page.operations).toEqual([]);
    expect(page.refreshed).toEqual([]);
    expect(page.creationsHasMore).toBeFalse();
  }
  db.close();
});

test("a reader without a creations cursor starts at the newest stamp, and a stamp without a recorded time still scopes its row", () => {
  const { db } = seededDatabase();
  insert(db, { key: "create_pipeline:old", digest: "digest-old", caller: null });
  insert(db, { key: "create_pipeline:unordered", digest: "digest-unordered", caller: null });
  insert(db, { key: "create_pipeline:new", digest: "digest-new", caller: null });
  const creations = new Map<string, McpPipelineCreation>([
    ["digest-old", creation("pipe-old", "beta", NOW)],
    ["digest-unordered", creation("pipe-unordered", "beta", null)],
  ]);

  const fresh = readMcpOperations(db, { project: "beta", after: 3, limit: 50 }, { now: NOW, creations });
  expect(fresh).toEqual({ operations: [], after: 3, hasMore: false, refreshed: [], creationsAfter: `${NOW}:digest-old`, creationsHasMore: false });
  expect(sequences(readMcpOperations(db, { project: "beta", after: 0, limit: 50 }, { now: NOW, creations }).operations)).toEqual([1, 2]);

  creations.set("digest-new", creation("pipe-new", "beta", NOW + 1));
  const next = readMcpOperations(db, { project: "beta", after: fresh.after, limit: 50, creationsAfter: fresh.creationsAfter }, { now: NOW, creations });
  expect(next.refreshed.map((operation) => [operation.sequence, operation.target?.pipelineId])).toEqual([[3, "pipe-new"]]);
  expect(next.creationsAfter).toBe(`${NOW + 1}:digest-new`);
  db.close();
});

test("no argument or result body leaves the feed", () => {
  const { db } = seededDatabase();
  insert(db, {
    key: "create_pipeline:bodies",
    caller: MANAGER,
    target: BETA_TASK,
    result: { ok: true, pipelineId: "pipe-1", pipeline: { id: "pipe-1", project: "alpha", spec: "SECRET-SPEC", stages: [{ prompt: "SECRET-PROMPT" }] } },
  });
  const page = readMcpOperations(db, { project: "alpha", after: 0, limit: 50, unresolved: [1] }, { now: NOW });
  expect(JSON.stringify(page)).not.toContain("SECRET-");
  expect(Object.keys(page).sort()).toEqual(["after", "creationsAfter", "creationsHasMore", "hasMore", "operations", "refreshed"]);
  const keys: (keyof McpOperation)[] = [
    "sequence", "tool", "requestDigest", "claimedAt", "callerConversationId", "callerProject", "state", "target", "refusal",
  ];
  expect(Object.keys(page.operations[0]!).sort()).toEqual([...keys].sort());
  expect(Object.keys(page.operations[0]!.target!).sort()).toEqual(["pipelineId", "project", "taskId"]);
  db.close();
});

test("a database no MCP process has migrated, and one that does not exist yet, both answer", () => {
  const file = receiptsFile();
  expect(openMcpReceiptsReadOnly(file)).toBeNull();
  expect(fs.existsSync(file)).toBeFalse();
  expect(readMcpOperations(null, { project: "alpha", after: 7, limit: 50 }))
    .toEqual({ operations: [], after: 7, hasMore: false, refreshed: [], ...EMPTY_CREATIONS });

  const legacy = new Database(file, { create: true, strict: true });
  legacy.exec(`
    CREATE TABLE mcp_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_key TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL,
      retention TEXT NOT NULL,
      result_json TEXT,
      storage_bytes INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL
    );
  `);
  legacy.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at) VALUES (?, ?, 'durable', ?, 1, ?)")
    .run("update_task:old", "digest-old", JSON.stringify({ ok: true, taskId: "t1", task: { id: "t1", project: "alpha" } }), NOW);
  legacy.close();

  const reader = openMcpReceiptsReadOnly(file)!;
  const page = readMcpOperations(reader, { project: "alpha", after: null, limit: 50, unresolved: [1] }, { now: NOW });
  expect(page.operations).toEqual([expect.objectContaining({
    state: "accepted",
    target: { project: "alpha", taskId: "t1", pipelineId: null },
    callerConversationId: null,
    callerProject: null,
  })]);
  expect(() => reader.exec("DELETE FROM mcp_receipts")).toThrow();
  reader.close();
});
