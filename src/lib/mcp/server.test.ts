import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PIPELINE_ACTIONS } from "@/lib/pipelines/types";
import { SNAPSHOT_CALLER_KEYS, SNAPSHOT_SCOPE_KEYS, SNAPSHOT_TEXT_KEYS, SNAPSHOT_VIEW_KEYS } from "@/lib/view/types";
import { DeadlineExceededError } from "@/lib/deadline";

import {
  MCP_TOOL_NAMES,
  TOOL_INPUT_SCHEMAS,
  FileMcpReceiptStore,
  MemoryMcpReceiptStore,
  McpToolTimingAggregate,
  SqliteMcpReceiptStore,
  createViewerMcpServer,
  createMcpToolService,
  type McpToolBindings,
  type McpReceiptStore,
  type McpToolResult,
} from "./server";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function rewriteReceiptFileAsV1(receiptPath: string): void {
  const current = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
    readReceipts: Record<string, unknown>;
    mutationReceipts: Record<string, unknown>;
  };
  fs.writeFileSync(receiptPath, JSON.stringify({
    version: 1,
    receipts: { ...current.readReceipts, ...current.mutationReceipts },
  }));
}

async function waitForFile(filename: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) return true;
    await Bun.sleep(10);
  }
  return fs.existsSync(filename);
}

async function waitForFileCount(directory: string, prefix: string, count: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.readdirSync(directory).filter((entry) => entry.startsWith(prefix)).length >= count) return true;
    await Bun.sleep(10);
  }
  return fs.readdirSync(directory).filter((entry) => entry.startsWith(prefix)).length >= count;
}

function recoveryArtifacts(directory: string): string[] {
  return fs.readdirSync(directory)
    .filter((entry) => entry.includes(".recovering") || entry.includes(".recovery-owner"));
}

async function waitForRecoveryCleanup(directory: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (recoveryArtifacts(directory).length === 0) return true;
    await Bun.sleep(10);
  }
  return recoveryArtifacts(directory).length === 0;
}

async function childResult(child: { exited: Promise<number>; stderr: ReadableStream<Uint8Array> }): Promise<{
  exit: number;
  error: string;
}> {
  const exit = await child.exited;
  return { exit, error: await new Response(child.stderr).text() };
}

describe("MCP tool service", () => {
  test("production-shaped legacy receipts import once and stay bounded", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-sqlite-"));
    scratch.push(directory);
    const legacyPath = path.join(directory, "mcp-receipts.json");
    const sqlitePath = path.join(directory, "mcp-receipts.sqlite");
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    const durableArgs = { clientRequestId: "durable-before-sqlite", conversationId: "conversation_fixture", text: "hello" };

    /* Produce one real legacy receipt through the public seam so migration is
       checked against the same digest/idempotency contract as production. */
    const legacyService = createMcpToolService(bindings, new FileMcpReceiptStore(legacyPath));
    const durableResult = await legacyService.callTool("send_message", durableArgs);
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as {
      version: 2;
      readReceipts: Record<string, unknown>;
      mutationReceipts: Record<string, unknown>;
    };
    const digest = "a".repeat(64);
    for (let index = 0; index < 2_100; index += 1) {
      const clientRequestId = `durable-fixture-${index}`;
      legacy.mutationReceipts[`send_message:${clientRequestId}`] = {
        digest,
        result: {
          ok: true,
          toolName: "send_message",
          clientRequestId,
          replayed: false,
          operationId: `operation_fixture_${index}`,
        },
      };
    }
    const bulkyResults = [
      ...Array.from({ length: 22 }, () => ["list_pipelines", "x".repeat(400_000)] as const),
      ...Array.from({ length: 79 }, () => ["get_conversation", "x".repeat(55_000)] as const),
      ...Array.from({ length: 6 }, () => ["list_flows", "x".repeat(385_000)] as const),
      ...Array.from({ length: 393 }, () => ["list_tasks", "x".repeat(8_000)] as const),
    ];
    for (const [index, [toolName, payload]] of bulkyResults.entries()) {
      const clientRequestId = `read-fixture-${index}`;
      legacy.readReceipts[`${toolName}:${clientRequestId}`] = {
        digest,
        result: { ok: true, toolName, clientRequestId, replayed: false, payload },
      };
    }
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));

    let bindingCalls = 0;
    bindings.list_tasks = async () => {
      bindingCalls += 1;
      return { count: 1, tasks: [{ state: "ready" }] };
    };
    const store = new SqliteMcpReceiptStore(sqlitePath, { legacyFilePath: legacyPath });
    const service = createMcpToolService(bindings, store);
    expect(await service.callTool("send_message", durableArgs)).toEqual({ ...durableResult, replayed: true });
    expect(await service.callTool("send_message", { ...durableArgs, text: "changed" })).toMatchObject({
      ok: false,
      code: "idempotency_conflict",
      replayed: true,
    });

    const fresh = await service.callTool("list_tasks", { clientRequestId: "post-import-read", limit: 1 });
    expect(fresh).toMatchObject({ ok: true, replayed: false });
    expect(await service.callTool("list_tasks", { clientRequestId: "post-import-read", limit: 1 }))
      .toEqual({ ...fresh, replayed: true });
    expect(bindingCalls).toBe(1);

    store.close();
    expect(fs.statSync(sqlitePath).size).toBeLessThan(12 * 1024 * 1024);
    fs.writeFileSync(legacyPath, "legacy import must not run twice");
    const restarted = createMcpToolService(bindings, new SqliteMcpReceiptStore(sqlitePath, { legacyFilePath: legacyPath }));
    expect(await restarted.callTool("send_message", durableArgs)).toEqual({ ...durableResult, replayed: true });
  }, 30_000);

  test("twenty processes deterministically share one SQLite receipt owner and restart replay", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-processes-"));
    scratch.push(directory);
    const sqlitePath = path.join(directory, "receipts.sqlite");
    new SqliteMcpReceiptStore(sqlitePath).close();
    const childPath = path.join(import.meta.dir, "receiptStoreProbeChild.ts");
    const startPath = path.join(directory, "start");
    const ownerReadyPath = path.join(directory, "owner-ready");
    const ownerReleasePath = path.join(directory, "owner-release");
    const ownerCountPath = path.join(directory, "owner-count");
    const children = Array.from({ length: 20 }, (_value, index) => Bun.spawn({
      cmd: [
        process.execPath,
        childPath,
        sqlitePath,
        path.join(directory, `ready-${index}.json`),
        startPath,
        ownerReadyPath,
        ownerReleasePath,
        ownerCountPath,
        path.join(directory, `result-${index}.json`),
        String(index),
      ],
      cwd: import.meta.dir,
      env: { ...process.env, LLV_STATE_DIR: path.join(directory, "state", String(index)) },
      stdout: "pipe",
      stderr: "pipe",
    }));

    expect(await waitForFileCount(directory, "ready-", 20)).toBeTrue();
    const ready = Array.from({ length: 20 }, (_value, index) => JSON.parse(
      fs.readFileSync(path.join(directory, `ready-${index}.json`), "utf8"),
    ) as { index: number; steadyRssBytes: number });
    expect(ready.map(({ index }) => index).toSorted((left, right) => left - right))
      .toEqual(Array.from({ length: 20 }, (_value, index) => index));
    expect(ready.every(({ steadyRssBytes }) => Number.isFinite(steadyRssBytes) && steadyRssBytes > 0)).toBeTrue();

    fs.writeFileSync(startPath, "start");
    expect(await waitForFile(ownerReadyPath, 10_000)).toBeTrue();
    expect(await waitForFileCount(directory, "result-", 19, 10_000)).toBeTrue();
    const ownerIndex = Number(fs.readFileSync(ownerReadyPath, "utf8"));
    expect(fs.readFileSync(ownerCountPath, "utf8").trim().split("\n")).toEqual([String(ownerIndex)]);
    fs.writeFileSync(ownerReleasePath, "release");

    const childOutcomes = await Promise.all(children.map(childResult));
    expect(childOutcomes).toEqual(Array.from({ length: 20 }, () => ({ exit: 0, error: "" })));
    const results = Array.from({ length: 20 }, (_value, index) => JSON.parse(
      fs.readFileSync(path.join(directory, `result-${index}.json`), "utf8"),
    ) as {
      index: number;
      durationMs: number;
      peakRssBytes: number;
      result: { ok: boolean; replayed: boolean; code?: string; ownerIndex?: number };
    });
    const winners = results.filter(({ result }) => result.ok);
    const contenders = results.filter(({ result }) => result.code === "call_interrupted");
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ index: ownerIndex, result: { replayed: false, ownerIndex } });
    expect(contenders).toHaveLength(19);
    expect(contenders.every(({ result }) => result.replayed)).toBeTrue();

    let restartBindingCalls = 0;
    const restartBindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    restartBindings.list_tasks = async () => ({ restartBindingCall: ++restartBindingCalls });
    const restartedStore = new SqliteMcpReceiptStore(sqlitePath);
    const restartedService = createMcpToolService(restartBindings, restartedStore);
    expect(await restartedService.callTool("list_tasks", { clientRequestId: "twenty-process-owner", limit: 1 }))
      .toMatchObject({ ok: true, replayed: true, ownerIndex });
    expect(await restartedService.callTool("list_tasks", { clientRequestId: "twenty-process-owner", limit: 2 }))
      .toMatchObject({ ok: false, replayed: true, code: "idempotency_conflict" });
    expect(restartBindingCalls).toBe(0);
    restartedStore.close();

    const percentile = (values: number[], quantile: number) => values.toSorted((left, right) => left - right)[Math.ceil(values.length * quantile) - 1]!;
    const durations = results.map(({ durationMs }) => durationMs);
    const steadyRss = ready.map(({ steadyRssBytes }) => steadyRssBytes);
    const peaks = results.map(({ peakRssBytes }) => peakRssBytes);
    console.info("[mcp-sqlite-20-process]", JSON.stringify({
      processes: 20,
      latencyMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: Math.max(...durations) },
      steadyRssMiB: { total: steadyRss.reduce((sum, value) => sum + value, 0) / 1024 / 1024, max: Math.max(...steadyRss) / 1024 / 1024 },
      peakRssMiB: { max: Math.max(...peaks) / 1024 / 1024 },
    }));
  }, 30_000);

  test("SQLite read receipt count retention expires the oldest completed replay", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-count-"));
    scratch.push(directory);
    let bindingCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.list_tasks = async () => ({ bindingCall: ++bindingCalls });
    const store = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"), {
      readReceiptCountCap: 2,
      readReceiptByteCap: 1_000_000,
    });
    const service = createMcpToolService(bindings, store);

    for (const clientRequestId of ["count-1", "count-2", "count-3"]) {
      expect((await service.callTool("list_tasks", { clientRequestId })).replayed).toBeFalse();
    }
    expect((await service.callTool("list_tasks", { clientRequestId: "count-1" })).replayed).toBeFalse();
    expect(bindingCalls).toBe(4);
    store.close();
  });

  test("SQLite read receipt byte retention expires oversized completed replays", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-bytes-"));
    scratch.push(directory);
    let bindingCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.list_tasks = async () => ({ bindingCall: ++bindingCalls, payload: "x".repeat(512) });
    const store = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"), {
      readReceiptCountCap: 100,
      readReceiptByteCap: 1_000,
    });
    const service = createMcpToolService(bindings, store);

    await service.callTool("list_tasks", { clientRequestId: "bytes-1" });
    await service.callTool("list_tasks", { clientRequestId: "bytes-2" });
    expect((await service.callTool("list_tasks", { clientRequestId: "bytes-1" })).replayed).toBeFalse();
    expect(bindingCalls).toBe(3);
    store.close();
  });

  test("SQLite restart reclaims expired bounded claims within count and byte budgets", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-expired-"));
    scratch.push(directory);
    const filename = path.join(directory, "receipts.sqlite");
    let now = 10_000;
    let bindingCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.list_tasks = async () => ({ bindingCall: ++bindingCalls });
    const initial = new SqliteMcpReceiptStore(filename, {
      readReceiptCountCap: 100,
      readReceiptByteCap: 1_000_000,
      boundedPendingTtlMs: 100,
      now: () => now,
    });
    const service = createMcpToolService(bindings, initial);
    const completedArgs = { clientRequestId: "completed-before-abandonment" };
    const completed = await service.callTool("list_tasks", completedArgs);
    const digest = "a".repeat(64);
    for (let index = 0; index < 8; index += 1) {
      expect(initial.claim(`list_tasks:abandoned-${index}`, digest, "bounded")).toEqual({ kind: "fresh" });
    }
    expect(initial.claim("send_message:durable-pending", digest, "durable")).toEqual({ kind: "fresh" });
    initial.close();

    now += 101;
    const restarted = new SqliteMcpReceiptStore(filename, {
      readReceiptCountCap: 2,
      readReceiptByteCap: 1_000,
      boundedPendingTtlMs: 100,
      now: () => now,
    });
    expect(await createMcpToolService(bindings, restarted).callTool("list_tasks", completedArgs))
      .toEqual({ ...completed, replayed: true });
    expect(restarted.claim("list_tasks:abandoned-0", digest, "bounded")).toEqual({ kind: "fresh" });
    expect(restarted.claim("send_message:durable-pending", digest, "durable")).toMatchObject({ kind: "pending" });
    expect(restarted.claim("send_message:durable-pending", "b".repeat(64), "durable")).toEqual({ kind: "conflict" });
    restarted.close();

    const database = new Database(filename, { readonly: true, strict: true });
    const bounded = database.query<{ count: number; bytes: number; pending: number }, []>(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(storage_bytes), 0) AS bytes,
             SUM(CASE WHEN result_json IS NULL THEN 1 ELSE 0 END) AS pending
      FROM mcp_receipts
      WHERE retention = 'bounded'
    `).get()!;
    database.close();
    expect(bounded.count).toBeLessThanOrEqual(2);
    expect(bounded.bytes).toBeLessThanOrEqual(1_000);
    expect(bounded.pending).toBe(1);
    expect(bindingCalls).toBe(1);
  });

  test("separate SQLite store instances preserve one durable mutation owner", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-instances-"));
    scratch.push(directory);
    const filename = path.join(directory, "receipts.sqlite");
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const bindingStarted = new Promise<void>((resolve) => { started = resolve; });
    let bindingCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.send_message = async () => {
      bindingCalls += 1;
      started();
      await held;
      return { operationId: "operation-sqlite-owner" };
    };
    const firstStore = new SqliteMcpReceiptStore(filename);
    const secondStore = new SqliteMcpReceiptStore(filename);
    const args = { clientRequestId: "sqlite-owner", conversationId: "conversation_fixture", text: "hello" };
    const first = createMcpToolService(bindings, firstStore).callTool("send_message", args);
    await bindingStarted;

    expect(await createMcpToolService(bindings, secondStore).callTool("send_message", args)).toMatchObject({
      ok: false,
      code: "call_interrupted",
      retryable: true,
      replayed: true,
    });
    expect(bindingCalls).toBe(1);
    release();
    const completed = await first;
    firstStore.close();
    secondStore.close();

    const restartedStore = new SqliteMcpReceiptStore(filename);
    expect(await createMcpToolService(bindings, restartedStore).callTool("send_message", args))
      .toEqual({ ...completed, replayed: true });
    expect(bindingCalls).toBe(1);
    restartedStore.close();
  });

  test("tool timing aggregates expose numeric phases and retain no call data", async () => {
    const timings = new McpToolTimingAggregate();
    const privateSentinel = "PRIVATE_TIMING_SENTINEL";
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.list_tasks = async () => ({ resultBody: privateSentinel, count: 1 });
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), undefined, { timings });

    const args = {
      clientRequestId: `request-${privateSentinel}`,
      "prompt": privateSentinel,
      transcriptPath: `/private/${privateSentinel}.jsonl`,
      accountId: `account-${privateSentinel}`,
    };
    await service.callTool("list_tasks", args, { deadlineAt: Date.now() + 5_000 });
    await service.callTool("list_tasks", args, { deadlineAt: Date.now() + 5_000 });
    await service.callTool("list_tasks", { ...args, "prompt": "changed" }, { deadlineAt: Date.now() + 5_000 });

    const snapshot = timings.snapshot();
    const listTasks = snapshot.find((entry) => entry.toolName === "list_tasks")!;
    expect(snapshot).toHaveLength(MCP_TOOL_NAMES.length);
    expect(listTasks.calls).toBe(3);
    expect(listTasks.outcomes).toMatchObject({ success: 1, replay: 1, conflict: 1 });
    expect(listTasks.phases.claim.samples).toBe(3);
    expect(listTasks.phases.binding.samples).toBe(1);
    expect(listTasks.phases.completion.samples).toBe(1);
    expect(listTasks.phases.serialization.samples).toBe(3);
    expect(listTasks.phases.serviceTotal.samples).toBe(3);
    expect(listTasks.phases.replay.samples).toBe(1);
    expect(listTasks.phases.serviceTotal.max).toBeGreaterThanOrEqual(listTasks.phases.binding.max);
    expect(listTasks.phases.serviceTotal.max).toBeGreaterThanOrEqual(listTasks.phases.claim.max);
    expect(listTasks.phases).not.toHaveProperty("rpcDeliveryWait");
    expect(listTasks.resultSizeBytes.max).toBeGreaterThan(0);
    expect(listTasks.deadline.callsWithDeadline).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain(privateSentinel);
  });

  test("tool timing aggregates classify deadline, cancellation, and unfinished age", async () => {
    const pendingTimings = new McpToolTimingAggregate();
    const pendingStore: McpReceiptStore = {
      claim: () => ({ kind: "pending", unfinishedAgeMs: 4_321 }),
      complete: () => { throw new Error("pending receipt must not complete"); },
    };
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    await createMcpToolService(bindings, pendingStore, undefined, { timings: pendingTimings })
      .callTool("list_tasks", { clientRequestId: "pending-age" });

    const deadlineTimings = new McpToolTimingAggregate();
    bindings.list_tasks = async (_args, context) => {
      if (context?.signal?.aborted) throw context.signal.reason;
      return {};
    };
    const deadlineController = new AbortController();
    deadlineController.abort(new DeadlineExceededError("fixture deadline", 5_000));
    const cancelledController = new AbortController();
    cancelledController.abort(new DOMException("fixture cancelled", "AbortError"));
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), undefined, { timings: deadlineTimings });
    await service.callTool("list_tasks", { clientRequestId: "deadline" }, {
      signal: deadlineController.signal,
      deadlineAt: Date.now(),
    });
    await service.callTool("list_tasks", { clientRequestId: "cancelled" }, {
      signal: cancelledController.signal,
    });

    const pending = pendingTimings.snapshot().find((entry) => entry.toolName === "list_tasks")!;
    expect(pending.outcomes.pending).toBe(1);
    expect(pending.unfinishedAgeMs).toMatchObject({ samples: 1, max: 4_321 });
    const ended = deadlineTimings.snapshot().find((entry) => entry.toolName === "list_tasks")!;
    expect(ended.deadline).toMatchObject({ callsWithDeadline: 1, exceeded: 1 });
    expect(ended.cancellation.cancelled).toBe(1);
  });

  /* #863: the completion write serializes and persists the whole result, which on
     a large read is the exact cost the deadline was meant to stop. A caller that
     already gave up must not pay it, and must not have its clientRequestId burned
     on an answer it never received. */
  test("an abandoned bounded read writes no receipt, while a completed one still replays", async () => {
    const completed: string[] = [];
    const store: McpReceiptStore = {
      claim: () => ({ kind: "fresh" }),
      complete: (key) => { completed.push(key); },
    };
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.list_pipelines = async (_args, context) => {
      if (context?.signal?.aborted) throw context.signal.reason;
      return { count: 0, pipelines: [] };
    };
    const service = createMcpToolService(bindings, store);

    const deadline = new AbortController();
    deadline.abort(new DeadlineExceededError("fixture deadline", 5_000));
    const cancelled = new AbortController();
    cancelled.abort(new DOMException("fixture cancelled", "AbortError"));
    const timedOut = await service.callTool("list_pipelines", { clientRequestId: "abandoned-deadline" }, { signal: deadline.signal });
    await service.callTool("list_pipelines", { clientRequestId: "abandoned-cancel" }, { signal: cancelled.signal });
    expect(timedOut.ok).toBe(false);
    expect(completed).toEqual([]);

    await service.callTool("list_pipelines", { clientRequestId: "answered" });
    expect(completed).toEqual(["list_pipelines:answered"]);
  });

  /* The skip is a bounded-read affordance. `pruneBoundedReceipts` sweeps an
     unsettled claim only for retention='bounded', so leaving a durable mutation
     claim open would strand a permanent result_json IS NULL row and answer that
     clientRequestId with `call_interrupted` forever. */
  test("an abandoned durable mutation still settles its claim", async () => {
    const completed: string[] = [];
    const store: McpReceiptStore = {
      claim: () => ({ kind: "fresh" }),
      complete: (key, _digest, _result, retention) => { completed.push(`${key}:${retention}`); },
    };
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.conversation_action = async (_args, context) => {
      if (context?.signal?.aborted) throw context.signal.reason;
      return {};
    };
    const abandoned = new AbortController();
    abandoned.abort(new DeadlineExceededError("fixture deadline", 5_000));
    await createMcpToolService(bindings, store)
      .callTool("conversation_action", { clientRequestId: "abandoned-mutation" }, { signal: abandoned.signal });
    expect(completed).toEqual(["conversation_action:abandoned-mutation:durable"]);
  });

  test("an ordinary tool failure still writes its receipt", async () => {
    const completed: string[] = [];
    const store: McpReceiptStore = {
      claim: () => ({ kind: "fresh" }),
      complete: (key) => { completed.push(key); },
    };
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.list_pipelines = async () => { throw new Error("registry unreadable"); };
    await createMcpToolService(bindings, store).callTool("list_pipelines", { clientRequestId: "failed" });
    expect(completed).toEqual(["list_pipelines:failed"]);
  });

  test("each v1 tool returns structured ids and replays a duplicate clientRequestId", async () => {
    const calls = new Map<string, number>();
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      async () => {
        calls.set(toolName, (calls.get(toolName) ?? 0) + 1);
        return {
          conversationId: `conversation_${toolName}`,
          transcriptPath: `/sessions/${toolName}.jsonl`,
          pipelineId: `pipeline_${toolName}`,
          taskId: `task_${toolName}`,
          operationId: `operation_${toolName}`,
        };
      },
    ])) as unknown as McpToolBindings;
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());

    for (const toolName of MCP_TOOL_NAMES) {
      const args = { clientRequestId: `request-${toolName}`, value: toolName };
      const first = await service.callTool(toolName, args);
      const replay = await service.callTool(toolName, args);

      expect(first).toMatchObject({ ok: true, toolName, clientRequestId: args.clientRequestId, replayed: false });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(calls.get(toolName)).toBe(1);
    }
  });

  test("a receipt left pending across process restart becomes a structured retryable error", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.send_message = async () => {
      await held;
      return { operationId: "operation-after-restart" };
    };
    const args = { clientRequestId: "request-restart", conversationId: "conversation_a", text: "hello" };
    const first = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath)).callTool("send_message", args);
    await Bun.sleep(5);

    const restarted = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    expect(await restarted.callTool("send_message", args)).toEqual({
      ok: false,
      toolName: "send_message",
      clientRequestId: "request-restart",
      replayed: true,
      error: "The previous MCP process ended before this call completed",
      code: "call_interrupted",
      retryable: true,
    });

    release();
    await first;
  });

  test("only archive and unarchive recover an interrupted conversation action receipt", async () => {
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    const bindingCalls: string[] = [];
    bindings.conversation_action = async (args) => {
      bindingCalls.push(String(args.action));
      return { operationId: `operation_${String(args.action)}` };
    };

    for (const action of ["archive", "unarchive", "interrupt", "kill", "resume"] as const) {
      const completed: McpToolResult[] = [];
      const pendingStore: McpReceiptStore = {
        claim: () => ({ kind: "pending", unfinishedAgeMs: 4_000 }),
        complete: (_key, _digest, result) => { completed.push(result); },
      };
      const result = await createMcpToolService(bindings, pendingStore).callTool("conversation_action", {
        clientRequestId: `interrupted-${action}`,
        conversationId: "conversation_fixture",
        action,
      });

      if (action === "archive" || action === "unarchive") {
        expect(result).toMatchObject({ ok: true, operationId: `operation_${action}` });
        expect(completed).toEqual([result]);
      } else {
        expect(result).toMatchObject({ ok: false, code: "call_interrupted", replayed: true });
        expect(completed).toEqual([]);
      }
    }
    expect(bindingCalls).toEqual(["archive", "unarchive"]);
  });

  test("agent_activity keeps a durable receipt: it appends to the same journal lifecycle_events does", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));

    await service.callTool("agent_activity", { clientRequestId: "activity-durable" });
    await service.callTool("lifecycle_events", { clientRequestId: "events-durable" });
    await service.callTool("list_pipelines", { clientRequestId: "pipelines-bounded" });

    const stored = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
      readReceipts: Record<string, unknown>;
      mutationReceipts: Record<string, unknown>;
    };
    /* Both journal-appending tools are durable; a genuinely read-only one is
       not. A bounded receipt for a tool that writes lets a replayed
       clientRequestId re-run the append after the MCP process restarts. */
    expect(Object.keys(stored.mutationReceipts).sort()).toEqual([
      "agent_activity:activity-durable",
      "lifecycle_events:events-durable",
    ]);
    expect(Object.keys(stored.readReceipts)).toEqual(["list_pipelines:pipelines-bounded"]);
  });

  test("a future receipt file fails closed before a mutation binding runs", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const original = "{\n  \"version\": 3,\n  \"receipts\": {}\n}\n";
    fs.writeFileSync(receiptPath, original);
    let bindingCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.flow_action = async () => {
      bindingCalls += 1;
      return { operationId: "operation_future_state" };
    };
    const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));

    await expect(service.callTool("flow_action", {
      clientRequestId: "request-future-state",
      flowId: "flow_future",
      action: "pause",
    })).rejects.toThrow("unsupported MCP receipt file version");
    expect(bindingCalls).toBe(0);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(original);
  });

  test("malformed supported receipt files fail closed and preserve their bytes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    let bindingCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.flow_action = async () => {
      bindingCalls += 1;
      return { operationId: "operation_malformed_state" };
    };
    const digest = "0".repeat(64);
    const cases = [
      "{",
      JSON.stringify({ version: 1, receipts: { "flow_action:request-malformed": { digest: "broken" } } }),
      JSON.stringify({ version: 2, readReceipts: { "flow_action:request-malformed": { digest } }, mutationReceipts: {} }),
      JSON.stringify({
        version: 2,
        readReceipts: {},
        mutationReceipts: {
          "flow_action:request-malformed": {
            digest,
            result: {
              ok: true,
              toolName: "flow_action",
              clientRequestId: "request-other",
              replayed: false,
            },
          },
        },
      }),
      JSON.stringify({ version: 2, readReceipts: {}, mutationReceipts: {}, extra: true }),
    ];

    for (const original of cases) {
      fs.writeFileSync(receiptPath, original);
      const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
      await expect(service.callTool("flow_action", {
        clientRequestId: "request-malformed",
        flowId: "flow_malformed",
        action: "pause",
      })).rejects.toThrow("invalid MCP receipt file");
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(original);
    }
    expect(bindingCalls).toBe(0);
  });

  test("receipt read failures other than absence fail closed", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    fs.mkdirSync(receiptPath);
    let bindingCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.flow_action = async () => {
      bindingCalls += 1;
      return { operationId: "operation_unreadable_state" };
    };
    const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));

    await expect(service.callTool("flow_action", {
      clientRequestId: "request-unreadable-state",
      flowId: "flow_unreadable",
      action: "pause",
    })).rejects.toThrow();
    expect(bindingCalls).toBe(0);
    expect(fs.statSync(receiptPath).isDirectory()).toBeTrue();
  });

  test("a live receipt lock remains owned after its stale-age threshold", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const readyPath = path.join(directory, "holder-ready");
    const releasePath = path.join(directory, "holder-release");
    const countPath = path.join(directory, "binding-count");
    const resultPath = path.join(directory, "claim-result.json");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    const env = { ...process.env };
    const holder = Bun.spawn({
      cmd: [process.execPath, child, "hold", lockPath, readyPath, releasePath],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(readyPath)).toBeTrue();
    const claimant = Bun.spawn({
      cmd: [process.execPath, child, "claim", receiptPath, countPath, resultPath],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });

    await Bun.sleep(150);
    const completedWhileHeld = fs.existsSync(resultPath);
    fs.writeFileSync(releasePath, "release");
    const results = await Promise.all([childResult(holder), childResult(claimant)]);

    expect(completedWhileHeld).toBeFalse();
    expect(results).toEqual([{ exit: 0, error: "" }, { exit: 0, error: "" }]);
    expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({ ok: true, replayed: false });
    expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("persistent recovery-directory loss is bounded and keeps the event loop responsive", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-missing-directory-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const countPath = path.join(directory, "binding-count");
    const resultPath = path.join(directory, "bounded-result.json");
    const heartbeatPath = path.join(directory, "heartbeat");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "missing-directory-owner",
    }));

    const claimant = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "missing-directory-claim",
        receiptPath,
        countPath,
        resultPath,
        heartbeatPath,
      ],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const settled = await waitForFile(resultPath, 6_500);
    if (!settled) claimant.kill(9);
    const processResult = await childResult(claimant);

    expect(settled).toBeTrue();
    expect(processResult).toEqual({ exit: 0, error: "" });
    expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({
      outcome: "failed",
      error: "MCP receipt store is busy",
    });
    const probe = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      scans: number;
      ticks: number;
      elapsedMs: number;
    };
    expect(probe.scans).toBeLessThan(1_000);
    expect(probe.ticks).toBeGreaterThan(10);
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(4_900);
    expect(probe.elapsedMs).toBeLessThan(6_000);
    expect(fs.existsSync(countPath)).toBeFalse();
  }, 8_000);

  test("one vanished published owner entry retries within the same fenced recovery", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-transient-owner-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const countPath = path.join(directory, "binding-count");
    const resultPath = path.join(directory, "result.json");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    fs.writeFileSync(`${receiptPath}.lock`, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "transient-owner-read",
    }));

    const claimant = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "transient-owner-read-claim",
        receiptPath,
        countPath,
        resultPath,
      ],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const processResult = await childResult(claimant);

    expect(processResult).toEqual({ exit: 0, error: "" });
    expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({ ok: true, replayed: false });
    expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(recoveryArtifacts(directory)).toEqual([]);
  });

  test("every recovery publication boundary settles after creator death", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-boundaries-"));
    scratch.push(root);
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    const boundaries = [
      "pending-open",
      "pending-partial-write",
      "pending-fsync",
      "owner-publish",
      "recovery-link-publish",
      "original-unlink",
      "recovery-link-cleanup",
      "owner-cleanup",
    ] as const;

    for (const boundary of boundaries) {
      const directory = path.join(root, boundary);
      fs.mkdirSync(directory);
      const receiptPath = path.join(directory, "receipts.json");
      const lockPath = `${receiptPath}.lock`;
      const countPath = path.join(directory, "binding-count");
      const crashedResultPath = path.join(directory, "crashed-result.json");
      const firstResultPath = path.join(directory, "first-result.json");
      const secondResultPath = path.join(directory, "second-result.json");
      const readyPath = path.join(directory, "crash-ready");
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: 999_999_999,
        startIdentity: "dead",
        token: `boundary-${boundary}`,
      }));
      const creator = Bun.spawn({
        cmd: [
          process.execPath,
          child,
          "crash-claim",
          receiptPath,
          countPath,
          crashedResultPath,
          boundary,
          readyPath,
        ],
        env: { ...process.env },
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await waitForFile(readyPath)).toBeTrue();
      for (const artifact of recoveryArtifacts(directory)) {
        expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(255);
      }
      creator.kill(9);
      const creatorResult = await childResult(creator);

      const first = Bun.spawn({
        cmd: [process.execPath, child, "claim", receiptPath, countPath, firstResultPath],
        env: { ...process.env },
        stdout: "ignore",
        stderr: "pipe",
      });
      const second = Bun.spawn({
        cmd: [process.execPath, child, "claim", receiptPath, countPath, secondResultPath],
        env: { ...process.env },
        stdout: "ignore",
        stderr: "pipe",
      });
      const claimants = await Promise.all([childResult(first), childResult(second)]);

      expect(creatorResult.exit).not.toBe(0);
      expect(claimants).toEqual([{ exit: 0, error: "" }, { exit: 0, error: "" }]);
      const results = [firstResultPath, secondResultPath]
        .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as { ok: boolean; replayed: boolean });
      expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
      expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
      const artifacts = recoveryArtifacts(directory);
      if (artifacts.length > 0) throw new Error(`${boundary} left recovery artifacts: ${artifacts.join(", ")}`);
    }
  }, 30_000);

  test("same-inode replacement survives a paused stale reaper", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-inode-reuse-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const pausePath = path.join(directory, "reaper-paused");
    const pauseReleasePath = path.join(directory, "reaper-release");
    const holderReadyPath = path.join(directory, "replacement-ready");
    const holderReleasePath = path.join(directory, "replacement-release");
    const countPath = path.join(directory, "binding-count");
    const firstResultPath = path.join(directory, "first-result.json");
    const secondResultPath = path.join(directory, "second-result.json");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "inode-reuse-stale-owner",
    }));

    const first = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "claim",
        receiptPath,
        countPath,
        firstResultPath,
        pausePath,
        pauseReleasePath,
      ],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(pausePath)).toBeTrue();
    const recoveryName = recoveryArtifacts(directory).find((entry) => entry.endsWith(".recovering"));
    expect(recoveryName).toBeDefined();
    const recoveryPath = path.join(directory, recoveryName!);
    const staleIdentity = fs.statSync(recoveryPath).ino;
    fs.unlinkSync(lockPath);
    const replacement = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "hold-reused",
        recoveryPath,
        lockPath,
        holderReadyPath,
        holderReleasePath,
      ],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(holderReadyPath)).toBeTrue();
    expect(fs.statSync(lockPath).ino).toBe(staleIdentity);
    const second = Bun.spawn({
      cmd: [process.execPath, child, "claim", receiptPath, countPath, secondResultPath],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });

    fs.writeFileSync(pauseReleasePath, "release");
    await Bun.sleep(150);
    expect(fs.existsSync(lockPath)).toBeTrue();
    expect(fs.existsSync(countPath)).toBeFalse();
    fs.writeFileSync(holderReleasePath, "release");
    const processes = await Promise.all([
      childResult(first),
      childResult(second),
      childResult(replacement),
    ]);

    expect(processes).toEqual([
      { exit: 0, error: "" },
      { exit: 0, error: "" },
      { exit: 0, error: "" },
    ]);
    const results = [firstResultPath, secondResultPath]
      .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as { ok: boolean; replayed: boolean });
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(recoveryArtifacts(directory)).toEqual([]);
  }, 12_000);

  test("successors wait for namespace release before forced inode reuse", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-namespace-handoff-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const pinPath = path.join(directory, "retired-inode-pin");
    const handoffReadyPath = path.join(directory, "handoff-ready");
    const handoffReleasePath = path.join(directory, "handoff-release");
    const reuseReadyPath = path.join(directory, "reuse-ready");
    const reuseReleasePath = path.join(directory, "reuse-release");
    const countPath = path.join(directory, "binding-count");
    const reaperResultPath = path.join(directory, "reaper-result.json");
    const firstResultPath = path.join(directory, "first-result.json");
    const secondResultPath = path.join(directory, "second-result.json");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "namespace-handoff-owner",
    }));
    const staleInode = fs.statSync(lockPath).ino;

    const reaper = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "namespace-handoff-claim",
        receiptPath,
        countPath,
        reaperResultPath,
        pinPath,
        handoffReadyPath,
        handoffReleasePath,
      ],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(handoffReadyPath)).toBeTrue();
    expect(fs.existsSync(lockPath)).toBeFalse();
    expect(fs.statSync(pinPath).ino).toBe(staleInode);

    const first = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "reuse-claim",
        receiptPath,
        countPath,
        firstResultPath,
        pinPath,
        reuseReadyPath,
        reuseReleasePath,
      ],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const second = Bun.spawn({
      cmd: [process.execPath, child, "claim", receiptPath, countPath, secondResultPath],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const enteredBeforeRelease = await waitForFile(reuseReadyPath, 250);
    fs.writeFileSync(handoffReleasePath, "release");
    expect(await waitForFile(reuseReadyPath)).toBeTrue();
    expect(Number(fs.readFileSync(reuseReadyPath, "utf8"))).toBe(staleInode);
    fs.writeFileSync(reuseReleasePath, "release");
    const processes = await Promise.all([
      childResult(reaper),
      childResult(first),
      childResult(second),
    ]);

    expect(enteredBeforeRelease).toBeFalse();
    expect(processes).toEqual([
      { exit: 0, error: "" },
      { exit: 0, error: "" },
      { exit: 0, error: "" },
    ]);
    const results = [reaperResultPath, firstResultPath, secondResultPath]
      .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as { ok: boolean; replayed: boolean });
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(recoveryArtifacts(directory)).toEqual([]);
  }, 12_000);

  test("successors remain responsive and bounded while namespace release is paused", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-namespace-busy-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const pinPath = path.join(directory, "retired-inode-pin");
    const handoffReadyPath = path.join(directory, "handoff-ready");
    const handoffReleasePath = path.join(directory, "handoff-release");
    const countPath = path.join(directory, "binding-count");
    const reaperResultPath = path.join(directory, "reaper-result.json");
    const firstResultPath = path.join(directory, "first-result.json");
    const secondResultPath = path.join(directory, "second-result.json");
    const firstHeartbeatPath = path.join(directory, "first-heartbeat");
    const secondHeartbeatPath = path.join(directory, "second-heartbeat");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "namespace-busy-owner",
    }));

    const reaper = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "namespace-handoff-claim",
        receiptPath,
        countPath,
        reaperResultPath,
        pinPath,
        handoffReadyPath,
        handoffReleasePath,
      ],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(handoffReadyPath)).toBeTrue();
    const first = Bun.spawn({
      cmd: [process.execPath, child, "timed-claim", receiptPath, countPath, firstResultPath, firstHeartbeatPath],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const second = Bun.spawn({
      cmd: [process.execPath, child, "timed-claim", receiptPath, countPath, secondResultPath, secondHeartbeatPath],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(firstResultPath, 6_500)).toBeTrue();
    expect(await waitForFile(secondResultPath, 6_500)).toBeTrue();
    const claimants = await Promise.all([childResult(first), childResult(second)]);
    const results = [firstResultPath, secondResultPath]
      .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as {
        outcome: string;
        error: string;
        ticks: number;
        elapsedMs: number;
      });

    expect(claimants).toEqual([{ exit: 0, error: "" }, { exit: 0, error: "" }]);
    for (const result of results) {
      expect(result).toMatchObject({ outcome: "failed", error: "MCP receipt store is busy" });
      expect(result.ticks).toBeGreaterThan(10);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(4_900);
      expect(result.elapsedMs).toBeLessThan(6_000);
    }
    expect(fs.existsSync(countPath)).toBeFalse();
    reaper.kill(9);
    expect((await childResult(reaper)).exit).not.toBe(0);
  }, 10_000);

  test("multiprocess stale recovery preserves a live replacement and admits one same-key mutation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-race-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const pausePath = path.join(directory, "recovery-paused");
    const pauseReleasePath = path.join(directory, "recovery-release");
    const holderReadyPath = path.join(directory, "replacement-ready");
    const holderReleasePath = path.join(directory, "replacement-release");
    const countPath = path.join(directory, "binding-count");
    const firstResultPath = path.join(directory, "first-result.json");
    const secondResultPath = path.join(directory, "second-result.json");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    const env = { ...process.env };
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "stale-owner",
    }));

    const firstClaimant = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "claim",
        receiptPath,
        countPath,
        firstResultPath,
        pausePath,
        pauseReleasePath,
      ],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(pausePath)).toBeTrue();
    fs.unlinkSync(lockPath);
    const replacement = Bun.spawn({
      cmd: [process.execPath, child, "hold", lockPath, holderReadyPath, holderReleasePath],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(holderReadyPath)).toBeTrue();
    const secondClaimant = Bun.spawn({
      cmd: [process.execPath, child, "claim", receiptPath, countPath, secondResultPath],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });

    fs.writeFileSync(pauseReleasePath, "release");
    await Bun.sleep(150);
    const completedWhileReplacementHeld = fs.existsSync(firstResultPath) || fs.existsSync(secondResultPath);
    fs.writeFileSync(holderReleasePath, "release");
    const processes = await Promise.all([
      childResult(firstClaimant),
      childResult(secondClaimant),
      childResult(replacement),
    ]);

    expect(completedWhileReplacementHeld).toBeFalse();
    expect(processes).toEqual([
      { exit: 0, error: "" },
      { exit: 0, error: "" },
      { exit: 0, error: "" },
    ]);
    const results = [firstResultPath, secondResultPath]
      .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as { ok: boolean; replayed: boolean });
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a live recovery owner stays exclusive across two reapers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-authority-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const raceDirectory = path.join(directory, "race");
    const holderReadyPath = path.join(directory, "replacement-ready");
    const holderReleasePath = path.join(directory, "replacement-release");
    const countPath = path.join(directory, "binding-count");
    const winnerResultPath = path.join(directory, "winner-result.json");
    const contenderResultPath = path.join(directory, "contender-result.json");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    const env = { ...process.env };
    const phase = (role: "winner" | "contender", name: string, state: "ready" | "release") =>
      path.join(raceDirectory, `${role}-${name}-${state}`);
    fs.mkdirSync(raceDirectory);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "shared-stale-owner",
    }));

    const winner = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "race-claim",
        receiptPath,
        countPath,
        winnerResultPath,
        "winner",
        raceDirectory,
      ],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(phase("winner", "after-link", "ready"))).toBeTrue();
    const contender = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "race-claim",
        receiptPath,
        countPath,
        contenderResultPath,
        "contender",
        raceDirectory,
      ],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(path.join(raceDirectory, "contender-owner-seen"))).toBeTrue();
    const contenderBeforeUnlink = phase("contender", "before-unlink", "ready");
    const contenderBeforeAcquire = phase("contender", "acquire", "ready");
    expect(await waitForFile(contenderBeforeAcquire)).toBeTrue();
    const contenderGainedUnlinkAuthority = fs.existsSync(contenderBeforeUnlink);

    fs.writeFileSync(phase("winner", "after-link", "release"), "release");
    expect(await waitForFile(phase("winner", "after-unlink", "ready"))).toBeTrue();
    const replacement = Bun.spawn({
      cmd: [process.execPath, child, "hold", lockPath, holderReadyPath, holderReleasePath],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(holderReadyPath)).toBeTrue();
    fs.writeFileSync(phase("contender", "before-unlink", "release"), "release");
    fs.writeFileSync(phase("winner", "after-unlink", "release"), "release");
    await Bun.sleep(100);
    const replacementSurvived = fs.existsSync(lockPath);
    const mutationRanWhileHeld = fs.existsSync(countPath);

    fs.writeFileSync(holderReleasePath, "release");
    fs.writeFileSync(phase("contender", "acquire", "release"), "release");
    const processes = await Promise.all([
      childResult(winner),
      childResult(contender),
      childResult(replacement),
    ]);

    expect(contenderGainedUnlinkAuthority).toBeFalse();
    expect(replacementSurvived).toBeTrue();
    expect(mutationRanWhileHeld).toBeFalse();
    expect(processes).toEqual([
      { exit: 0, error: "" },
      { exit: 0, error: "" },
      { exit: 0, error: "" },
    ]);
    const results = [winnerResultPath, contenderResultPath]
      .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as { ok: boolean; replayed: boolean });
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("successors recover when the recovery-link creator exits", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-lock-crash-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const lockPath = `${receiptPath}.lock`;
    const creatorPausedPath = path.join(directory, "creator-paused");
    const creatorReleasePath = path.join(directory, "creator-release");
    const takeoverPausedPath = path.join(directory, "takeover-paused");
    const takeoverReleasePath = path.join(directory, "takeover-release");
    const holderReadyPath = path.join(directory, "replacement-ready");
    const holderReleasePath = path.join(directory, "replacement-release");
    const countPath = path.join(directory, "binding-count");
    const firstResultPath = path.join(directory, "first-result.json");
    const secondResultPath = path.join(directory, "second-result.json");
    const discardedResultPath = path.join(directory, "creator-result.json");
    const child = path.join(import.meta.dir, "server.lockChild.ts");
    const env = { ...process.env };
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      startIdentity: "dead",
      token: "creator-death-owner",
    }));

    const creator = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "claim",
        receiptPath,
        countPath,
        discardedResultPath,
        creatorPausedPath,
        creatorReleasePath,
      ],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(creatorPausedPath)).toBeTrue();
    creator.kill(9);
    const creatorOutcome = await childResult(creator);
    const startedAt = Date.now();
    const first = Bun.spawn({
      cmd: [
        process.execPath,
        child,
        "takeover-claim",
        receiptPath,
        countPath,
        firstResultPath,
        takeoverPausedPath,
        takeoverReleasePath,
      ],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(takeoverPausedPath)).toBeTrue();
    const second = Bun.spawn({
      cmd: [process.execPath, child, "claim", receiptPath, countPath, secondResultPath],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    fs.unlinkSync(lockPath);
    const replacement = Bun.spawn({
      cmd: [process.execPath, child, "hold", lockPath, holderReadyPath, holderReleasePath],
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(holderReadyPath)).toBeTrue();
    fs.writeFileSync(takeoverReleasePath, "release");
    const recovered = await waitForRecoveryCleanup(directory);
    const recoveryElapsedMs = Date.now() - startedAt;
    const replacementSurvived = fs.existsSync(lockPath);
    const mutationRanWhileHeld = fs.existsSync(countPath);

    fs.writeFileSync(holderReleasePath, "release");
    const processes = await Promise.all([
      childResult(first),
      childResult(second),
      childResult(replacement),
    ]);

    expect(creatorOutcome.exit).not.toBe(0);
    expect(recovered).toBeTrue();
    expect(recoveryElapsedMs).toBeLessThan(5_000);
    expect(recoveryArtifacts(directory)).toEqual([]);
    expect(replacementSurvived).toBeTrue();
    expect(mutationRanWhileHeld).toBeFalse();
    expect(processes).toEqual([
      { exit: 0, error: "" },
      { exit: 0, error: "" },
      { exit: 0, error: "" },
    ]);
    expect(fs.existsSync(firstResultPath)).toBeTrue();
    expect(fs.existsSync(secondResultPath)).toBeTrue();
    const results = [firstResultPath, secondResultPath]
      .filter((filename) => fs.existsSync(filename))
      .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")) as { ok: boolean; replayed: boolean });
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(fs.readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
  }, 12_000);

  test("mutations retain replay and conflict protection after read receipt churn and restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const actionCalls = new Map<string, number>();
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    const cases = [
      {
        toolName: "flow_action" as const,
        args: { clientRequestId: "request-flow-acceptance", flowId: "flow_acceptance", action: "pause" },
        changedArgs: { clientRequestId: "request-flow-acceptance", flowId: "flow_acceptance", action: "resume" },
      },
      {
        toolName: "conversation_action" as const,
        args: { clientRequestId: "request-conversation-acceptance", conversationId: "conversation_acceptance", action: "interrupt" },
        changedArgs: { clientRequestId: "request-conversation-acceptance", conversationId: "conversation_acceptance", action: "kill" },
      },
      {
        toolName: "conversation_migration" as const,
        args: { clientRequestId: "request-migration-acceptance", conversationId: "conversation_acceptance", action: "rollback", expectedRevision: 1 },
        changedArgs: { clientRequestId: "request-migration-acceptance", conversationId: "conversation_acceptance", action: "retry", expectedRevision: 1 },
      },
    ];
    for (const mutation of cases) {
      bindings[mutation.toolName] = async () => {
        actionCalls.set(mutation.toolName, (actionCalls.get(mutation.toolName) ?? 0) + 1);
        return { operationId: `operation_${mutation.toolName}_acceptance` };
      };
    }
    const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    const firstResults = new Map<string, Awaited<ReturnType<typeof service.callTool>>>();
    for (const mutation of cases) {
      firstResults.set(mutation.toolName, await service.callTool(mutation.toolName, mutation.args));
    }
    rewriteReceiptFileAsV1(receiptPath);
    for (let index = 0; index < 501; index += 1) {
      await service.callTool("list_flows", { clientRequestId: `request-read-${index}`, limit: 1 });
    }

    const restarted = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    for (const mutation of cases) {
      const firstResult = firstResults.get(mutation.toolName);
      if (!firstResult) throw new Error(`missing first result for ${mutation.toolName}`);
      expect(await restarted.callTool(mutation.toolName, mutation.args)).toEqual({
        ...firstResult,
        replayed: true,
      });
      expect(await restarted.callTool(mutation.toolName, mutation.changedArgs)).toMatchObject({
        ok: false,
        code: "idempotency_conflict",
        replayed: true,
      });
      expect(actionCalls.get(mutation.toolName)).toBe(1);
    }
  });

  test("a pending mutation remains claimed while read receipts churn", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let actionCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.conversation_action = async () => {
      actionCalls += 1;
      markStarted();
      await held;
      return { operationId: "operation_pending_acceptance" };
    };
    const args = { clientRequestId: "request-pending-acceptance", conversationId: "conversation_acceptance", action: "interrupt" };
    const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    const first = service.callTool("conversation_action", args);
    await started;
    rewriteReceiptFileAsV1(receiptPath);
    for (let index = 0; index < 501; index += 1) {
      await service.callTool("list_tasks", { clientRequestId: `request-pending-read-${index}`, limit: 1 });
    }

    const restarted = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    expect(await restarted.callTool("conversation_action", args)).toMatchObject({
      ok: false,
      code: "call_interrupted",
      replayed: true,
    });
    expect(await restarted.callTool("conversation_action", { ...args, action: "kill" })).toMatchObject({
      ok: false,
      code: "idempotency_conflict",
      replayed: true,
    });
    expect(actionCalls).toBe(1);

    release();
    const completed = await first;
    const completedRestart = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    expect(await completedRestart.callTool("conversation_action", args)).toEqual({ ...completed, replayed: true });
    expect(actionCalls).toBe(1);
  });

  test("a concurrent duplicate waits for the active call and returns it as a replay", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.send_message = async () => {
      calls += 1;
      await held;
      return { operationId: "operation-concurrent" };
    };
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
    const args = { clientRequestId: "request-concurrent", conversationId: "conversation_a", text: "hello" };
    const first = service.callTool("send_message", args);
    await Bun.sleep(1);
    const second = service.callTool("send_message", args);
    release();

    expect(await first).toMatchObject({ ok: true, replayed: false, operationId: "operation-concurrent" });
    expect(await second).toMatchObject({ ok: true, replayed: true, operationId: "operation-concurrent" });
    expect(calls).toBe(1);
  });

  test("registers the complete v1 surface and returns structured content over MCP", async () => {
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({ operationId: `operation_${toolName}` })])) as unknown as McpToolBindings;
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
    const server = createViewerMcpServer(service);
    const client = new Client({ name: "viewer-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "spawn_agent",
        "send_message",
        "message_receipt",
        "create_task",
        "update_task",
        "create_pipeline",
        "pipeline_action",
        "link_task_to_pipeline",
        "list_conversations",
        "search_transcripts",
        "get_conversation",
        "deploy_exact_sha",
        "get_pipeline",
        "board_snapshot",
        "list_flows",
        "get_flow",
        "flow_action",
        "list_pipelines",
        "conversation_action",
        "operator_snapshot",
        "list_tasks",
        "get_task",
        "deployment_status",
        "resources",
        "conversation_migration",
        "agent_activity",
        "lifecycle_events",
        "request_attention",
        "suggest_replies",
        "bridge_report",
        "bridge_directive",
        "get_orchestrator",
        "create_orchestrator",
        "send_message_to_orchestrator",
        "rotate_orchestrator",
        "seat_tick_settings",
      ]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.required).toContain("clientRequestId");
      }
      const spawnSchema = listed.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema;
      expect(spawnSchema?.properties).toHaveProperty("cwd");
      expect(spawnSchema?.properties).toHaveProperty("prompt");
      expect(spawnSchema?.properties).toHaveProperty("title");
      expect(spawnSchema?.required).toContain("title");
      expect(spawnSchema?.properties).toHaveProperty("mcpServers");
      const createOrchestratorSchema = listed.tools.find((tool) => tool.name === "create_orchestrator")?.inputSchema;
      expect(createOrchestratorSchema?.properties).toHaveProperty("conversationId");
      const suggestRepliesSchema = listed.tools.find((tool) => tool.name === "suggest_replies")?.inputSchema;
      expect(suggestRepliesSchema?.properties).not.toHaveProperty("replaces");
      /* #878: rotation must reach effort parity with create, or a successor
         silently boots at the default reasoning level. */
      const rotateOrchestratorSchema = listed.tools.find((tool) => tool.name === "rotate_orchestrator")?.inputSchema;
      expect(rotateOrchestratorSchema?.properties).toHaveProperty("effort");
      const deploySchema = listed.tools.find((tool) => tool.name === "deploy_exact_sha")?.inputSchema;
      /* #795: the deploy carries WHAT ships and nothing that claims authority —
         no confirmation flag, no bridge reference, no nonce. */
      expect(deploySchema?.properties).toHaveProperty("revision");
      expect(deploySchema?.properties).not.toHaveProperty("confirm");
      const called = await client.callTool({
        name: "send_message",
        arguments: { clientRequestId: "request-protocol", text: "hello" },
      });
      expect(called.structuredContent).toMatchObject({
        ok: true,
        toolName: "send_message",
        operationId: "operation_send_message",
        replayed: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

/* #774: `pipeline_action.action` was `z.string().min(1)` while the PATCH route
   admitted a fixed set, and `operator_snapshot`'s nested objects were free-form
   records against an exact-key validator. Both now read from one constant. */
test("#774 tool schemas publish the closed sets their servers enforce", () => {
  const pipelineAction = TOOL_INPUT_SCHEMAS.pipeline_action.shape.action;
  expect(pipelineAction.options).toEqual([...PIPELINE_ACTIONS]);

  const snapshot = TOOL_INPUT_SCHEMAS.operator_snapshot.shape;
  expect(Object.keys(snapshot.text.unwrap().shape).sort()).toEqual([...SNAPSHOT_TEXT_KEYS].sort());
  expect(Object.keys(snapshot.view.unwrap().shape).sort()).toEqual([...SNAPSHOT_VIEW_KEYS].sort());
  expect([
    ...new Set(snapshot.scope.unwrap().options.flatMap(
      (option: { shape: Record<string, unknown> }) => Object.keys(option.shape),
    )),
  ].sort()).toEqual([...SNAPSHOT_SCOPE_KEYS].sort());
  expect(Object.keys(snapshot.caller.unwrap().shape).sort()).toEqual([...SNAPSHOT_CALLER_KEYS].sort());

  /* Strict, not stripping: an unknown nested key must stay a loud rejection. */
  expect(snapshot.text.unwrap().safeParse({ mode: "digest" }).success).toBe(false);
  expect(snapshot.view.unwrap().safeParse({ includeFrame: true }).success).toBe(false);
  expect(TOOL_INPUT_SCHEMAS.operator_snapshot.safeParse({
    clientRequestId: "snapshot-extra-key",
    unknown: true,
  }).success).toBe(false);
});
