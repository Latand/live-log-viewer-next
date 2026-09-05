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

  test("cold concurrent starts migrate every prior SQLite schema once and keep the receipts", async () => {
    /* #1490: two processes that both inspect the columns and then both ALTER
       TABLE make the loser throw "duplicate column name". Every schema a
       production database can carry is opened cold by twenty processes at the
       same instant; each must initialize and read the seeded receipt back. */
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-cold-"));
    scratch.push(directory);
    const childPath = path.join(import.meta.dir, "receiptStoreProbeChild.ts");
    const digest = "e".repeat(64);
    const key = "send_message:cold-seeded";
    const seededResult: McpToolResult = { ok: true, toolName: "send_message", clientRequestId: "cold-seeded", replayed: false, operationId: "op_cold" };
    const baseColumns = `
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_key TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL,
      retention TEXT NOT NULL CHECK(retention IN ('bounded', 'durable')),
      result_json TEXT,
      storage_bytes INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL`;
    const schemas: { name: string; extraColumns: string; seed: (raw: Database) => void; expected: unknown }[] = [
      {
        name: "legacy",
        extraColumns: "",
        seed: (raw) => raw.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at) VALUES (?, ?, 'durable', ?, 1, 1)")
          .run(key, digest, JSON.stringify(seededResult)),
        expected: { digest, result: seededResult, binding: null, stage: "settled" },
      },
      {
        name: "previous-repair",
        extraColumns: ", binding_json TEXT, stage TEXT",
        seed: (raw) => raw.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at, binding_json, stage) VALUES (?, ?, 'durable', ?, 1, 1, NULL, 'settled')")
          .run(key, digest, JSON.stringify(seededResult)),
        expected: { digest, result: seededResult, binding: null, stage: "settled" },
      },
      { name: "absent", extraColumns: "", seed: () => {}, expected: null },
    ];
    for (const schema of schemas) {
      const sqlitePath = path.join(directory, `${schema.name}.sqlite`);
      if (schema.name !== "absent") {
        const raw = new Database(sqlitePath, { create: true, strict: true });
        raw.exec(`
          CREATE TABLE mcp_receipt_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE mcp_receipts (${baseColumns}${schema.extraColumns});
        `);
        schema.seed(raw);
        raw.close();
      }
      const startPath = path.join(directory, `${schema.name}-start`);
      const processes = 20;
      const children = Array.from({ length: processes }, (_value, index) => Bun.spawn({
        cmd: [
          process.execPath, childPath, "cold-start", sqlitePath,
          path.join(directory, `${schema.name}-ready-${index}`), startPath,
          path.join(directory, `${schema.name}-result-${index}.json`), String(index), key,
        ],
        cwd: import.meta.dir,
        env: { ...process.env, LLV_STATE_DIR: path.join(directory, "state", schema.name, String(index)) },
        stdout: "pipe",
        stderr: "pipe",
      }));
      expect(await waitForFileCount(directory, `${schema.name}-ready-`, processes)).toBeTrue();
      fs.writeFileSync(startPath, String(Date.now() + 150));
      const outcomes = await Promise.all(children.map(childResult));
      expect(outcomes).toEqual(Array.from({ length: processes }, () => ({ exit: 0, error: "" })));
      const results = Array.from({ length: processes }, (_value, index) => JSON.parse(
        fs.readFileSync(path.join(directory, `${schema.name}-result-${index}.json`), "utf8"),
      ) as { index: number; ok: boolean; error?: string; record?: unknown });
      expect(results.map(({ ok, error }) => `${schema.name}:${ok ? "ok" : error}`))
        .toEqual(Array.from({ length: processes }, () => `${schema.name}:ok`));
      expect(results.map(({ record }) => record)).toEqual(Array.from({ length: processes }, () => schema.expected));

      const migrated = new Database(sqlitePath, { readonly: true, strict: true });
      const columns = migrated.query<{ name: string }, []>("PRAGMA table_info(mcp_receipts)").all().map((column) => column.name);
      expect(columns).toEqual(["sequence", "receipt_key", "digest", "retention", "result_json", "storage_bytes", "claimed_at", "binding_json", "stage", "recovery_result_json"]);
      expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM mcp_receipts").get()?.count).toBe(schema.name === "absent" ? 0 : 1);
      migrated.close();
    }
  }, 60_000);

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
    expect(restarted.claim("send_message:durable-pending", "b".repeat(64), "durable")).toMatchObject({ kind: "conflict" });
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
        "conversation_deliverability",
        "conversation_messages",
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
        "account_project_binding",
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
      /* #1452: the incumbent's stale mandate is carried forward only on request. */
      expect(rotateOrchestratorSchema?.properties).toHaveProperty("keepIncumbentMandate");
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

/* ── ORIGINAL-KEY RECOVERY (#1490) ─────────────────────────────────────── */

import {
  McpDispatchNotExecutedError,
  McpDispatchUncertainError,
  McpDispatchVerdictError,
  McpToolRefusal,
  type McpRecoverableTool,
  type McpRecoveryEvidence,
  type McpRecoveryReceiptStore,
  type McpRequestBinding,
  type McpRequestCaller,
  type McpToolCallContext,
} from "./server";

const OWNER: McpRequestCaller = { kind: "worker", conversationId: "conversation_owner", project: "proj-a" };
const OTHER: McpRequestCaller = { kind: "worker", conversationId: "conversation_other", project: "proj-a" };
const OTHER_PROJECT: McpRequestCaller = { kind: "worker", conversationId: "conversation_owner", project: "proj-b" };
const UNIDENTIFIED: McpRequestCaller = { kind: "unidentified", conversationId: null, project: null };

interface RecoveryHarness {
  service: ReturnType<typeof createMcpToolService>;
  store: McpRecoveryReceiptStore;
  /** Who the authority resolver says is calling — changeable mid-test, as a
      real process's resolved identity can differ from one call to the next. */
  caller: McpRequestCaller;
  bindingCalls: McpToolCallContext[];
  recoverCalls: { binding: McpRequestBinding; legacy: boolean }[];
  evidence: McpRecoveryEvidence;
  bindingImpl: (args: Record<string, unknown>, context?: McpToolCallContext) => Promise<Record<string, unknown>>;
}

function recoveryHarness(
  caller: McpRequestCaller,
  store: McpRecoveryReceiptStore = new MemoryMcpReceiptStore(),
  overrides: Partial<Pick<RecoveryHarness, "evidence" | "bindingImpl">> = {},
): RecoveryHarness {
  const harness: RecoveryHarness = {
    service: undefined as never,
    store,
    caller,
    bindingCalls: [],
    recoverCalls: [],
    evidence: overrides.evidence ?? { outcome: "unknown", evidence: "none", reason: "nothing recorded yet", ids: {} },
    bindingImpl: overrides.bindingImpl ?? (async () => ({ operationId: "op_dispatched", outcome: "queued" })),
  };
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
  const recording: McpToolBindings[keyof McpToolBindings] = async (args, context) => {
    harness.bindingCalls.push(context ?? {});
    return harness.bindingImpl(args, context);
  };
  bindings.send_message = recording;
  bindings.spawn_agent = recording;
  /* One recoverable tool shape serves both mutations: a send binds its
     conversation, a spawn its directory, and the service treats them alike. */
  const tool: McpRecoverableTool = {
    bind: (args) => {
      if (typeof args.text !== "string" && typeof args.cwd !== "string") throw new McpToolRefusal("text is required", { code: "invalid_request" });
      return { caller: harness.caller, target: { project: "proj-a", identity: String(args.conversationId ?? args.cwd) }, downstreamKey: `key:${String(args.clientRequestId)}` };
    },
    recover: async (binding, options) => {
      harness.recoverCalls.push({ binding, legacy: options.legacy });
      return harness.evidence;
    },
  };
  harness.service = createMcpToolService(bindings, store, undefined, { recovery: { send_message: tool, spawn_agent: tool } });
  return harness;
}

const SEND = { clientRequestId: "recover-1", conversationId: "conversation_target", text: "hold" };
const SPAWN = { clientRequestId: "recover-1", cwd: "/fixture/launch-dir", "prompt": "go", title: "Recovery launch" };

describe("original-key recovery (#1490)", () => {
  test("a fresh ordinary call binds before dispatch, dispatches once with the persisted key, and settles", async () => {
    const harness = recoveryHarness(OWNER);
    const first = await harness.service.callTool("send_message", SEND);
    expect(first).toMatchObject({ ok: true, operationId: "op_dispatched", replayed: false });
    expect(harness.bindingCalls).toHaveLength(1);
    expect(harness.bindingCalls[0]?.binding).toMatchObject({
      version: 1,
      toolName: "send_message",
      clientRequestId: "recover-1",
      caller: OWNER,
      target: { project: "proj-a", identity: "conversation_target" },
      downstreamKey: "key:recover-1",
      owner: { pid: process.pid },
    });
    const record = await harness.store.lookup("send_message:recover-1");
    expect(record).toMatchObject({ stage: "settled", binding: { downstreamKey: "key:recover-1", caller: OWNER } });
    expect(record?.result).toMatchObject({ ok: true, operationId: "op_dispatched" });

    /* Ordinary replay keeps the recorded result; the binding is never re-run. */
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: true, operationId: "op_dispatched", replayed: true });
    expect(harness.bindingCalls).toHaveLength(1);
    expect(harness.recoverCalls).toHaveLength(0);

    /* Explicit recovery of a completed call reads current evidence and
       carries the original alongside — recoveryOnly is not in the digest. */
    harness.evidence = { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_dispatched" }, facts: { state: "delivered" } };
    const explicit = await harness.service.callTool("send_message", { ...SEND, recoveryOnly: true });
    expect(explicit).toMatchObject({ ok: true, recovered: true, outcome: "settled", state: "delivered", operationId: "op_dispatched", nextAction: "follow-disposition", replayed: true });
    expect((explicit as { original?: unknown }).original).toMatchObject({ ok: true, operationId: "op_dispatched" });
    expect(harness.recoverCalls).toEqual([{ binding: expect.objectContaining({ downstreamKey: "key:recover-1" }), legacy: false }]);
    expect(harness.bindingCalls).toHaveLength(1);
  });

  test("recoveryOnly under an absent key starts no work, writes nothing, and leaves a legitimate original free to claim and dispatch", async () => {
    const store = new MemoryMcpReceiptStore();
    const observer = recoveryHarness(OWNER, store);
    const probe = await observer.service.callTool("send_message", { ...SEND, recoveryOnly: true });
    expect(probe).toMatchObject({
      ok: false,
      code: "outcome_unknown",
      retryable: false,
      replayed: false,
      details: { outcome: "unknown", evidence: "none", nextAction: "original-key-lookup", reason: expect.stringContaining("no claim exists") },
    });
    expect(observer.bindingCalls).toHaveLength(0);
    /* Without a claim there is no binding that could authorise a downstream
       read, so none is made. */
    expect(observer.recoverCalls).toHaveLength(0);
    /* Nothing under the key: the lookup is an observation, never a claim. */
    expect(await store.lookup("send_message:recover-1")).toBeNull();

    /* The original arriving AFTER the lookup — the concurrent
       original-before-claim case — claims and dispatches exactly once. */
    const original = recoveryHarness(OWNER, store);
    expect(await original.service.callTool("send_message", SEND)).toMatchObject({ ok: true, operationId: "op_dispatched", replayed: false });
    expect(original.bindingCalls).toHaveLength(1);
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ stage: "settled" });
    /* And the observer now reads it. */
    observer.evidence = { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_dispatched" }, facts: { state: "delivered" } };
    expect(await observer.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "settled", operationId: "op_dispatched" });
    expect(original.bindingCalls).toHaveLength(1);

  });

  test("an absent claim discloses nothing, to anyone, for either tool: a downstream record under the key is never read without the binding that proves whose it is", async () => {
    /* The reviewer's reproduction: work exists downstream under a key nobody
       claimed HERE (the key's owner claimed it in another store, or the row
       was lost), and a downstream read would hand its ids to whoever asks
       with the key — another caller, another project, a changed payload,
       even the owner. No claim, no binding, no read, no ids. */
    for (const [toolName, args] of [["send_message", SEND], ["spawn_agent", SPAWN]] as const) {
      for (const caller of [OWNER, OTHER, OTHER_PROJECT]) {
        const harness = recoveryHarness(caller, new MemoryMcpReceiptStore(), {
          evidence: { outcome: "accepted", evidence: "spawn-receipt", reason: "accepted", ids: { launchId: "launch_elsewhere", conversationId: "conversation_elsewhere", operationId: "op_elsewhere" } },
        });
        for (const variant of [{ ...args, recoveryOnly: true }, { ...args, recoveryOnly: true, [toolName === "send_message" ? "text" : "prompt"]: "changed" }]) {
          const answer = await harness.service.callTool(toolName, variant);
          expect(answer).toMatchObject({
            ok: false,
            code: "outcome_unknown",
            replayed: false,
            details: { outcome: "unknown", evidence: "none", nextAction: "original-key-lookup", reason: expect.stringContaining("no claim exists") },
          });
          expect(JSON.stringify(answer)).not.toContain("elsewhere");
        }
        expect(harness.recoverCalls).toHaveLength(0);
        expect(harness.bindingCalls).toHaveLength(0);
        expect(await harness.store.lookup(`${toolName}:recover-1`)).toBeNull();
      }
    }
  });

  test("changed arguments conflict, and recoveryOnly alone never changes the digest", async () => {
    const harness = recoveryHarness(OWNER);
    await harness.service.callTool("send_message", { ...SEND, recoveryOnly: false });
    expect(await harness.service.callTool("send_message", { ...SEND, text: "changed" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(await harness.service.callTool("send_message", { ...SEND, text: "changed", recoveryOnly: true })).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: true, replayed: true });
    expect(harness.bindingCalls).toHaveLength(1);
  });

  test("another caller, another project, or an unidentified caller is refused without disclosure", async () => {
    const store = new MemoryMcpReceiptStore();
    const owner = recoveryHarness(OWNER, store);
    await owner.service.callTool("send_message", SEND);
    for (const caller of [OTHER, OTHER_PROJECT]) {
      const stranger = recoveryHarness(caller, store);
      for (const args of [SEND, { ...SEND, recoveryOnly: true }, { ...SEND, text: "changed" }]) {
        const answer = await stranger.service.callTool("send_message", args);
        expect(answer).toEqual({
          ok: false,
          toolName: "send_message",
          clientRequestId: "recover-1",
          replayed: true,
          error: "this clientRequestId cannot be recovered by this caller",
          code: "recovery_not_permitted",
          retryable: false,
        });
        expect(JSON.stringify(answer)).not.toContain("op_dispatched");
      }
      expect(stranger.bindingCalls).toHaveLength(0);
      expect(stranger.recoverCalls).toHaveLength(0);
    }
    /* An unidentified caller is refused before anything is claimed: the same
       answer under an existing key, an absent key, ordinary or explicit — so
       it neither dispatches a mutation nobody could recover nor learns whether
       the key exists. */
    const anonymous = recoveryHarness(UNIDENTIFIED, store);
    for (const args of [SEND, { ...SEND, recoveryOnly: true }, { ...SEND, text: "changed" }, { ...SEND, clientRequestId: "anon-1" }, { ...SEND, clientRequestId: "anon-2", recoveryOnly: true }]) {
      const answer = await anonymous.service.callTool("send_message", args);
      expect(answer).toEqual({
        ok: false,
        toolName: "send_message",
        clientRequestId: String(args.clientRequestId),
        replayed: false,
        error: expect.stringContaining("identity could not be established"),
        code: "caller_unidentified",
        retryable: false,
      });
      expect(JSON.stringify(answer)).not.toContain("op_dispatched");
    }
    expect(anonymous.bindingCalls).toHaveLength(0);
    expect(anonymous.recoverCalls).toHaveLength(0);
    expect(await store.lookup("send_message:anon-1")).toBeNull();
    expect(await store.lookup("send_message:anon-2")).toBeNull();
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ stage: "settled", binding: { caller: OWNER } });
  });

  test("a duplicate in the same process is authenticated and answered from the durable record, never joined to the original", async () => {
    const store = new MemoryMcpReceiptStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = recoveryHarness(OWNER, store, {
      bindingImpl: async () => { await held; return { operationId: "op_joined" }; },
    });
    const original = harness.service.callTool("send_message", SEND);
    await Bun.sleep(5);
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });

    /* The resolved identity changes while the original is still out: the
       same service instance now speaks for another caller, and learns nothing. */
    harness.caller = OTHER;
    for (const args of [SEND, { ...SEND, recoveryOnly: true }]) {
      const stranger = await harness.service.callTool("send_message", args);
      expect(stranger).toMatchObject({ ok: false, code: "recovery_not_permitted", replayed: true });
      expect(JSON.stringify(stranger)).not.toContain("op_joined");
    }
    harness.caller = OTHER_PROJECT;
    expect(await harness.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: false, code: "recovery_not_permitted" });
    harness.caller = UNIDENTIFIED;
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "caller_unidentified" });
    expect(harness.recoverCalls).toHaveLength(0);

    /* The owner's own duplicate reads the durable evidence rather than
       waiting on the in-process promise: what another process would see. */
    harness.caller = OWNER;
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "outcome_unknown", replayed: true, details: { outcome: "unknown", nextAction: "original-key-lookup" } });
    harness.evidence = { outcome: "accepted", evidence: "delivery-record", reason: "accepted", ids: { operationId: "op_joined" } };
    expect(await harness.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "accepted", operationId: "op_joined", replayed: true });
    expect(harness.recoverCalls).toHaveLength(2);
    expect(harness.bindingCalls).toHaveLength(1);

    release();
    expect(await original).toMatchObject({ ok: true, operationId: "op_joined", replayed: false });
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: true, operationId: "op_joined", replayed: true });
    expect(harness.bindingCalls).toHaveLength(1);
  });

  test("a failure after the request may be on the server stays unknown with the ids it carried; only proven pre-dispatch failures close the attempt", async () => {
    /* The production send binding reads the registry AFTER the HTTP
       acceptance; that read throwing is not proof of anything. */
    const afterDispatch = recoveryHarness(OWNER, undefined, {
      bindingImpl: async (_args, context) => {
        context!.dispatch!.attempted = true;
        throw new Error("the delivery record could not be read after acceptance");
      },
    });
    const lost = await afterDispatch.service.callTool("send_message", SEND);
    expect(lost).toMatchObject({
      ok: false,
      code: "outcome_unknown",
      retryable: false,
      replayed: false,
      error: expect.stringContaining("could not be read after acceptance"),
      details: { outcome: "unknown", nextAction: "original-key-lookup" },
    });
    expect(JSON.stringify(lost)).not.toContain("not-executed");
    expect(JSON.stringify(lost)).not.toContain("new-request-permitted");
    expect(await afterDispatch.store.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });
    expect(afterDispatch.recoverCalls).toHaveLength(1);
    /* The evidence found later is the answer, under the same key. */
    afterDispatch.evidence = { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_after" }, facts: { state: "delivered" } };
    expect(await afterDispatch.service.callTool("send_message", SEND)).toMatchObject({ ok: true, outcome: "settled", operationId: "op_after", replayed: true });
    expect(afterDispatch.bindingCalls).toHaveLength(1);

    /* A 5xx verdict, a 409 whose ids were lost, and a refusal after the
       attempt carrying an id: never not-executed. */
    for (const [thrown, expected] of [
      [new McpDispatchVerdictError("upstream failed", { status: 500 }), { code: "outcome_unknown", details: { outcome: "unknown" } }],
      [new McpDispatchVerdictError("conflict", { status: 409 }), { code: "outcome_unknown", details: { outcome: "unknown" } }],
      [new McpToolRefusal("delivery was started", { operationId: "op_kept", resend: "verify-first" }), { code: "outcome_unknown", details: { outcome: "unknown", operationId: "op_kept", nextAction: "original-key-lookup" } }],
    ] as const) {
      const harness = recoveryHarness(OWNER, undefined, {
        bindingImpl: async (_args, context) => { context!.dispatch!.attempted = true; throw thrown; },
      });
      expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: false, ...expected });
    }
    /* Ids a refusal carried are kept on an uncertain answer. */
    const carried = recoveryHarness(OWNER, undefined, {
      bindingImpl: async (_args, context) => { context!.dispatch!.attempted = true; throw new McpToolRefusal("host lost the answer", { conversationId: "conversation_named", status: 502 }); },
    });
    expect(await carried.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown", conversationId: "conversation_named" } });

    // All error status families without affirmative dispatch proof stay open.
    for (let status = 300; status <= 599; status += 1) {
      const harness = recoveryHarness(OWNER, undefined, {
        bindingImpl: async (_args, context) => {
          context!.dispatch!.attempted = true;
          throw new McpDispatchVerdictError("response without dispatch proof", { status });
        },
      });
      expect(await harness.service.callTool("send_message", SEND)).toMatchObject({
        code: "outcome_unknown", details: { outcome: "unknown", nextAction: "original-key-lookup" },
      });
      expect(await harness.store.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });
      expect(harness.recoverCalls).toHaveLength(1);
    }
    /* Proven: the transport never connected, or the failure happened before
       the request was handed to the transport. */
    for (const thrown of [
      new McpDispatchNotExecutedError("Viewer control is unreachable: the connection was refused before the request was sent"),
    ]) {
      const harness = recoveryHarness(OWNER, undefined, {
        bindingImpl: async (_args, context) => { context!.dispatch!.attempted = true; throw thrown; },
      });
      expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "tool_failed", retryable: true, details: { outcome: "not-executed", nextAction: "new-request-permitted" } });
      expect(await harness.store.lookup("send_message:recover-1")).toMatchObject({ stage: "not-executed" });
      expect(harness.recoverCalls).toHaveLength(0);
    }
    const beforeTransport = recoveryHarness(OWNER, undefined, {
      bindingImpl: async () => { throw new Error("cwd is required"); },
    });
    expect(await beforeTransport.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "tool_failed", details: { outcome: "not-executed" } });
    expect(await beforeTransport.store.lookup("send_message:recover-1")).toMatchObject({ stage: "not-executed" });

    /* A late error from the original response after a recovery already saw
       success: the terminal answer was written when it was seen, so it is
       what the original's own call gets, and the row is never closed. */
    const store = new MemoryMcpReceiptStore();
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => { fail = resolve; });
    const original = recoveryHarness(OWNER, store, {
      bindingImpl: async (_args, context) => { context!.dispatch!.attempted = true; await failing; throw new Error("socket closed after the answer was written"); },
      evidence: { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_late_success" }, facts: { state: "delivered" } },
    });
    const pending = original.service.callTool("send_message", SEND);
    await Bun.sleep(5);
    const observer = recoveryHarness(OWNER, store, { evidence: original.evidence });
    expect(await observer.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "settled", operationId: "op_late_success" });
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ stage: "settled", result: { ok: true, outcome: "settled", operationId: "op_late_success" } });
    fail();
    expect(await pending).toMatchObject({ ok: true, outcome: "settled", operationId: "op_late_success", replayed: true });
    expect(await observer.service.callTool("send_message", SEND)).toMatchObject({ ok: true, outcome: "settled", operationId: "op_late_success", replayed: true });
  });

  test("an uncertain dispatch leaves the claim open, answers from evidence, and is never redispatched", async () => {
    const harness = recoveryHarness(OWNER, undefined, {
      bindingImpl: async () => { throw new McpDispatchUncertainError("the connection failed after the request may have been sent"); },
    });
    const lost = await harness.service.callTool("send_message", SEND);
    expect(lost).toMatchObject({
      ok: false,
      code: "outcome_unknown",
      retryable: false,
      replayed: false,
      details: { outcome: "unknown", nextAction: "original-key-lookup", evidence: "none" },
    });
    expect(String((lost as { error: string }).error)).toContain("may have been sent");
    expect(await harness.store.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });
    expect(harness.recoverCalls).toHaveLength(1);

    /* Later calls under the key read evidence only. */
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "outcome_unknown", replayed: true });
    harness.evidence = { outcome: "accepted", evidence: "delivery-record", reason: "accepted for delivery", ids: { operationId: "op_found" }, facts: { state: "in-flight" } };
    expect(await harness.service.callTool("send_message", { ...SEND, recoveryOnly: true }))
      .toMatchObject({ ok: true, recovered: true, outcome: "accepted", operationId: "op_found", nextAction: "original-key-lookup", replayed: true });
    /* Open evidence never becomes a stored result: the row stays open for the
       original response, and nothing pretends to know more than it does. */
    expect(await harness.store.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });
    harness.evidence = { outcome: "settled", evidence: "delivery-journal", reason: null, ids: { operationId: "op_found" }, facts: { state: "delivered", resend: "not-needed" } };
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: true, outcome: "settled", resend: "not-needed", nextAction: "follow-disposition" });
    expect(harness.bindingCalls).toHaveLength(1);
    /* TERMINAL evidence is the row's answer from now on, so nothing that
       arrives later can replace it. */
    expect(await harness.store.lookup("send_message:recover-1")).toMatchObject({ stage: "settled", result: { ok: true, recovered: true, outcome: "settled", operationId: "op_found" } });
    harness.evidence = { outcome: "unknown", evidence: "none", reason: "gone", ids: {} };
    expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: true, outcome: "settled", operationId: "op_found", replayed: true });
  });

  test("terminal evidence recovered while the original still dispatches is persisted, so a delayed admitted error cannot replace it — across store instances and a reopen", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-recovery-late-error-"));
    scratch.push(directory);
    const filename = path.join(directory, "mcp-receipts.sqlite");
    const first = new SqliteMcpReceiptStore(filename);
    const second = new SqliteMcpReceiptStore(filename);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    /* The original's dispatch answers late, and with a 409 that names the
       admitted operation. Admission does not establish a terminal outcome;
       the already recovered delivery must remain the answer. */
    const original = recoveryHarness(OWNER, first, {
      bindingImpl: async () => {
        await held;
        throw new McpDispatchVerdictError("delivery was started and never settled", { status: 409, operationId: "op_late_error", resend: "verify-first", actuation: "started" });
      },
    });
    const pending = original.service.callTool("send_message", SEND);
    await Bun.sleep(5);
    expect(await first.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });

    /* Another process recovers under the key while the dispatch is open and
       the durable delivery record already proves delivery. */
    const observer = recoveryHarness(OWNER, second, {
      evidence: { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_late_error" }, facts: { state: "delivered", resend: "not-needed", duplicateRisk: false } },
    });
    const recovered = await observer.service.callTool("send_message", { ...SEND, recoveryOnly: true });
    expect(recovered).toMatchObject({ ok: true, recovered: true, outcome: "settled", state: "delivered", resend: "not-needed", operationId: "op_late_error", replayed: true });
    expect(observer.bindingCalls).toHaveLength(0);
    expect(await second.lookup("send_message:recover-1")).toMatchObject({ stage: "settled", result: { ok: true, outcome: "settled", state: "delivered" } });

    /* The delayed error arrives: the row already holds the terminal answer,
       so the original's own call gets that answer, never the regression. */
    release();
    const late = await pending;
    expect(late).toMatchObject({ ok: true, outcome: "settled", state: "delivered", resend: "not-needed", operationId: "op_late_error", replayed: true });
    expect(JSON.stringify(late)).not.toContain("verify-first");
    for (const harness of [original, observer]) {
      expect(await harness.service.callTool("send_message", SEND)).toMatchObject({ ok: true, outcome: "settled", state: "delivered", resend: "not-needed", replayed: true });
    }
    expect(original.bindingCalls).toHaveLength(1);
    first.close();
    second.close();

    /* After a restart against the same file the answer is the same. */
    const reopened = new SqliteMcpReceiptStore(filename);
    const restarted = recoveryHarness(OWNER, reopened, { evidence: { outcome: "unknown", evidence: "none", reason: "gone", ids: {} } });
    expect(await restarted.service.callTool("send_message", SEND)).toMatchObject({ ok: true, outcome: "settled", state: "delivered", resend: "not-needed", replayed: true });
    expect(await restarted.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "settled", state: "delivered", operationId: "op_late_error" });
    expect(restarted.bindingCalls).toHaveLength(0);
    reopened.close();
  });

  test("a receipt record that cannot be read is answered unknown with original-key guidance: nothing claimed, dispatched or disclosed", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-recovery-unreadable-"));
    scratch.push(directory);
    const expectUnknown = async (harness: RecoveryHarness, args: Record<string, unknown>, replayed: boolean) => {
      const answer = await harness.service.callTool("send_message", args);
      expect(answer).toMatchObject({
        ok: false,
        code: "outcome_unknown",
        retryable: false,
        replayed,
        details: { outcome: "unknown", evidence: "mcp-receipt-unreadable", nextAction: "original-key-lookup", reason: expect.stringContaining("could not be read") },
      });
      expect(JSON.stringify(answer)).not.toContain("op_");
      expect(harness.bindingCalls).toHaveLength(0);
      expect(harness.recoverCalls).toHaveLength(0);
    };

    /* A store that faults on every read. */
    const faulting = new MemoryMcpReceiptStore();
    faulting.lookup = () => { throw new Error("disk read failed"); };
    faulting.claim = () => { throw new Error("disk read failed"); };
    const faultingHarness = recoveryHarness(OWNER, faulting, {
      evidence: { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_hidden" } },
    });
    await expectUnknown(faultingHarness, { ...SEND, recoveryOnly: true }, false);
    await expectUnknown(faultingHarness, SEND, false);

    /* A corrupted file record. */
    const filePath = path.join(directory, "receipts.json");
    const fileHarness = recoveryHarness(OWNER, new FileMcpReceiptStore(filePath), {
      evidence: { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_hidden" } },
    });
    await fileHarness.service.callTool("send_message", SEND);
    expect(fileHarness.bindingCalls).toHaveLength(1);
    const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as { mutationReceipts: Record<string, { binding: unknown }> };
    state.mutationReceipts["send_message:recover-1"]!.binding = { version: 1, toolName: "send_message" };
    fs.writeFileSync(filePath, JSON.stringify(state));
    fileHarness.bindingCalls.length = 0;
    await expectUnknown(fileHarness, { ...SEND, recoveryOnly: true }, false);
    await expectUnknown(fileHarness, SEND, false);

    /* A corrupted SQLite record, and the same answer after a reopen. */
    const sqlitePath = path.join(directory, "mcp-receipts.sqlite");
    const sqlite = new SqliteMcpReceiptStore(sqlitePath);
    const sqliteHarness = recoveryHarness(OWNER, sqlite, {
      evidence: { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_hidden" } },
    });
    await sqliteHarness.service.callTool("send_message", SEND);
    const raw = new Database(sqlitePath, { strict: true });
    raw.query("UPDATE mcp_receipts SET binding_json = ? WHERE receipt_key = ?").run("{not json", "send_message:recover-1");
    raw.close();
    sqliteHarness.bindingCalls.length = 0;
    await expectUnknown(sqliteHarness, { ...SEND, recoveryOnly: true }, false);
    await expectUnknown(sqliteHarness, SEND, false);
    sqlite.close();
    const reopened = recoveryHarness(OWNER, new SqliteMcpReceiptStore(sqlitePath));
    await expectUnknown(reopened, SEND, false);
    (reopened.store as SqliteMcpReceiptStore).close();
  });

  test("a server refusal before dispatch settles as not-executed; one carrying an admitted id keeps it", async () => {
    const refused = recoveryHarness(OWNER, undefined, {
      bindingImpl: async () => { throw new McpToolRefusal("directory does not exist", { status: 400 }); },
    });
    expect(await refused.service.callTool("send_message", SEND)).toMatchObject({
      ok: false,
      code: "tool_failed",
      retryable: true,
      details: { status: 400, outcome: "not-executed", nextAction: "new-request-permitted" },
    });
    expect(await refused.store.lookup("send_message:recover-1")).toMatchObject({ stage: "not-executed" });
    expect(await refused.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "tool_failed", replayed: true, details: { outcome: "not-executed" } });
    expect(refused.bindingCalls).toHaveLength(1);

    const admitted = recoveryHarness(OWNER, undefined, {
      bindingImpl: async () => { throw new McpToolRefusal("delivery was started and never settled", { operationId: "op_ambiguous", resend: "verify-first", actuation: "started" }); },
    });
    expect(await admitted.service.callTool("send_message", SEND)).toMatchObject({
      ok: false,
      code: "outcome_unknown",
      retryable: false,
      details: { operationId: "op_ambiguous", outcome: "unknown", nextAction: "original-key-lookup" },
    });
    expect(await admitted.store.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });
  });

  test("a claim whose owner died before dispatch is closed as not-executed; a live owner's claim stays unknown", async () => {
    const store = new MemoryMcpReceiptStore();
    const harness = recoveryHarness(OWNER, store);
    const digest = (await (async () => {
      /* Produce the exact digest the service computes by claiming through it once. */
      const probe = recoveryHarness(OWNER, new MemoryMcpReceiptStore());
      await probe.service.callTool("send_message", SEND);
      return (await probe.store.lookup("send_message:recover-1"))!.digest;
    })());
    const binding = (context: Partial<McpRequestBinding["owner"]>): McpRequestBinding => ({
      version: 1,
      toolName: "send_message",
      clientRequestId: "recover-1",
      caller: OWNER,
      target: { project: "proj-a", identity: "conversation_target" },
      downstreamKey: "key:recover-1",
      owner: { pid: process.pid, startIdentity: null, ...context },
      claimedAt: new Date().toISOString(),
    });

    /* Live owner: the dispatch may be a moment away — unknown, nothing closed. */
    expect(store.claim("send_message:recover-1", digest, "durable", binding({}))).toEqual({ kind: "fresh" });
    const live = await harness.service.callTool("send_message", SEND);
    expect(live).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown", evidence: "mcp-receipt" } });
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ stage: "claimed", result: null });
    expect(harness.bindingCalls).toHaveLength(0);
    expect(harness.recoverCalls).toHaveLength(0);

    /* Dead owner: closed for good, and the closure is what proves zero effect. */
    const dead = new MemoryMcpReceiptStore();
    const deadHarness = recoveryHarness(OWNER, dead);
    expect(dead.claim("send_message:recover-1", digest, "durable", binding({ pid: 2 ** 22 - 1 }))).toEqual({ kind: "fresh" });
    const closed = await deadHarness.service.callTool("send_message", { ...SEND, recoveryOnly: true });
    expect(closed).toMatchObject({ ok: false, code: "not_executed", details: { outcome: "not-executed", evidence: "mcp-receipt" }, replayed: true });
    expect(await dead.lookup("send_message:recover-1")).toMatchObject({ stage: "not-executed" });
    expect(dead.markDispatching("send_message:recover-1", digest)).toBe(false);
    expect(await deadHarness.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "not_executed", replayed: true });
    expect(deadHarness.bindingCalls).toHaveLength(0);
  });

  test("a legacy claim without a binding discloses its result only when downstream evidence establishes ownership", async () => {
    const store = new MemoryMcpReceiptStore();
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({ operationId: "op_legacy" })])) as unknown as McpToolBindings;
    /* The row as a pre-#1490 server wrote it: no binding, no stage. */
    await createMcpToolService(bindings, store).callTool("send_message", SEND);
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ binding: null, stage: "settled" });

    const unowned = recoveryHarness(OWNER, store, {
      evidence: { outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_legacy" }, ownership: "unknown" },
    });
    for (const args of [SEND, { ...SEND, recoveryOnly: true }]) {
      const answer = await unowned.service.callTool("send_message", args);
      expect(answer).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown", evidence: "legacy-receipt-unbound" } });
      expect(JSON.stringify(answer)).not.toContain("op_legacy");
    }
    expect(unowned.recoverCalls.map((call) => call.legacy)).toEqual([true, true]);
    expect(unowned.bindingCalls).toHaveLength(0);
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ binding: null, stage: "settled" });

    const owned = recoveryHarness(OWNER, store, {
      evidence: { outcome: "settled", evidence: "spawn-receipt", reason: null, ids: { launchId: "launch_legacy" }, ownership: "established" },
    });
    expect(await owned.service.callTool("send_message", SEND)).toMatchObject({ ok: true, operationId: "op_legacy", replayed: true });
    expect(await owned.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: true, recovered: true, outcome: "settled", launchId: "launch_legacy" });
    expect(await owned.service.callTool("send_message", { ...SEND, text: "changed" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
  });

  test("the original response completing after a recovery settles once, and a later error cannot overwrite it", async () => {
    const store = new MemoryMcpReceiptStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = recoveryHarness(OWNER, store, {
      bindingImpl: async () => { await held; return { operationId: "op_late" }; },
    });
    const pending = original.service.callTool("send_message", SEND);
    await Bun.sleep(5);
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ stage: "dispatching", result: null });

    const observer = recoveryHarness(OWNER, store, {
      evidence: { outcome: "accepted", evidence: "delivery-record", reason: "accepted", ids: { operationId: "op_late" } },
    });
    expect(await observer.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "accepted", operationId: "op_late" });
    expect(observer.bindingCalls).toHaveLength(0);

    release();
    expect(await pending).toMatchObject({ ok: true, operationId: "op_late", replayed: false });
    expect(await store.lookup("send_message:recover-1")).toMatchObject({ stage: "settled" });
    expect(await observer.service.callTool("send_message", SEND)).toMatchObject({ ok: true, operationId: "op_late", replayed: true });

    /* A terminal answer already recorded wins over any later write. */
    const digest = (await store.lookup("send_message:recover-1"))!.digest;
    const late = { ok: false as const, toolName: "send_message", clientRequestId: "recover-1", replayed: false, error: "late", code: "tool_failed", retryable: true };
    expect(store.settle("send_message:recover-1", digest, late)).toMatchObject({ ok: true, operationId: "op_late" });
    expect(store.fenceUndispatched("send_message:recover-1", digest, late)).toBe(false);
    expect((await store.lookup("send_message:recover-1"))?.result).toMatchObject({ ok: true, operationId: "op_late" });
  });

  test("the file and SQLite stores persist the binding and stage, transition conditionally, and migrate in place", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-recovery-stores-"));
    scratch.push(directory);
    const binding: McpRequestBinding = {
      version: 1,
      toolName: "send_message",
      clientRequestId: "durable-1",
      caller: OWNER,
      target: { project: "proj-a", identity: "conversation_target" },
      downstreamKey: "durable-1",
      owner: { pid: process.pid, startIdentity: null },
      claimedAt: "2026-09-05T08:00:00.000Z",
    };
    const digest = "c".repeat(64);
    const result: McpToolResult = { ok: true, toolName: "send_message", clientRequestId: "durable-1", replayed: false, operationId: "op_durable" };
    const closed: McpToolResult = { ok: false, toolName: "send_message", clientRequestId: "durable-1", replayed: false, error: "closed", code: "not_executed", retryable: true };

    /* An existing SQLite database from before the columns existed. */
    const sqlitePath = path.join(directory, "mcp-receipts.sqlite");
    const raw = new Database(sqlitePath, { create: true, strict: true });
    raw.exec(`
      CREATE TABLE mcp_receipt_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE mcp_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_key TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        retention TEXT NOT NULL CHECK(retention IN ('bounded', 'durable')),
        result_json TEXT,
        storage_bytes INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL
      );
    `);
    raw.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at) VALUES (?, ?, 'durable', ?, 1, 1)")
      .run("send_message:legacy-1", digest, JSON.stringify({ ...result, clientRequestId: "legacy-1" }));
    raw.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at) VALUES (?, ?, 'durable', NULL, 1, 1)")
      .run("send_message:legacy-pending", digest);
    raw.close();

    const stores: { name: string; store: McpRecoveryReceiptStore }[] = [
      { name: "file", store: new FileMcpReceiptStore(path.join(directory, "receipts.json")) },
      { name: "sqlite", store: new SqliteMcpReceiptStore(sqlitePath) },
    ];
    for (const { name, store } of stores) {
      const key = `send_message:durable-1`;
      expect(await store.claim(key, digest, "durable", binding)).toEqual({ kind: "fresh" });
      expect(await store.lookup(key)).toEqual({ digest, result: null, binding, stage: "claimed" });
      expect(await store.claim(key, digest, "durable", binding)).toMatchObject({ kind: "pending", record: { stage: "claimed", binding } });
      expect(await store.claim(key, "d".repeat(64), "durable", binding)).toMatchObject({ kind: "conflict", record: { binding } });
      expect(await store.markDispatching(key, "d".repeat(64))).toBe(false);
      expect(await store.markDispatching(key, digest)).toBe(true);
      expect(await store.markDispatching(key, digest)).toBe(false);
      expect(await store.fenceUndispatched(key, digest, closed)).toBe(false);
      expect((await store.lookup(key))?.stage).toBe("dispatching");
      expect(await store.settle(key, digest, result)).toEqual(result);
      expect(await store.settle(key, digest, closed)).toEqual(result);
      expect(await store.lookup(key)).toMatchObject({ result, stage: "settled", binding });
      expect(await store.claim(key, digest, "durable", binding)).toMatchObject({ kind: "replay", result, record: { stage: "settled" } });

      const undispatched = `send_message:undispatched-${name}`;
      const undispatchedBinding = { ...binding, clientRequestId: `undispatched-${name}` };
      expect(await store.claim(undispatched, digest, "durable", undispatchedBinding)).toEqual({ kind: "fresh" });
      expect(await store.fenceUndispatched(undispatched, digest, { ...closed, clientRequestId: `undispatched-${name}` })).toBe(true);
      expect(await store.markDispatching(undispatched, digest)).toBe(false);
      expect(await store.lookup(undispatched)).toMatchObject({ stage: "not-executed" });
    }
    /* Rows from before the columns existed read as legacy: no binding, no
       claim stage, and their results intact. */
    const sqlite = stores[1]!.store;
    expect(await sqlite.lookup("send_message:legacy-1")).toMatchObject({ binding: null, stage: "settled", result: { operationId: "op_durable" } });
    expect(await sqlite.lookup("send_message:legacy-pending")).toEqual({ digest, result: null, binding: null, stage: null });
    (sqlite as SqliteMcpReceiptStore).close();

    /* The file store's bytes survive a reopen with the binding intact, and
       the legacy JSON import carries binding and stage into SQLite. */
    const reopened = new FileMcpReceiptStore(path.join(directory, "receipts.json"));
    expect(await reopened.lookup("send_message:durable-1")).toMatchObject({ binding, stage: "settled" });
    const imported = new SqliteMcpReceiptStore(path.join(directory, "imported.sqlite"), { legacyFilePath: path.join(directory, "receipts.json") });
    expect(imported.lookup("send_message:durable-1")).toMatchObject({ binding, stage: "settled", result });
    expect(imported.lookup("send_message:undispatched-file")).toMatchObject({ stage: "not-executed" });
    imported.close();

    /* A malformed binding fails closed on read. */
    const corrupt = path.join(directory, "corrupt.json");
    fs.writeFileSync(corrupt, JSON.stringify({
      version: 2,
      readReceipts: {},
      mutationReceipts: { "send_message:bad": { digest, binding: { version: 1, toolName: "send_message" }, stage: "claimed" } },
    }));
    await expect(new FileMcpReceiptStore(corrupt).lookup("send_message:bad")).rejects.toThrow("invalid MCP receipt file");
  });

  test("two SQLite store instances racing one key yield one dispatch owner", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-recovery-race-"));
    scratch.push(directory);
    const filename = path.join(directory, "mcp-receipts.sqlite");
    const first = new SqliteMcpReceiptStore(filename);
    const second = new SqliteMcpReceiptStore(filename);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const a = recoveryHarness(OWNER, first, { bindingImpl: async () => { await held; return { operationId: "op_race" }; } });
    const b = recoveryHarness(OWNER, second, {
      evidence: { outcome: "unknown", evidence: "none", reason: "nothing recorded yet", ids: {} },
      bindingImpl: async () => { throw new Error("the second process must never dispatch"); },
    });
    const winner = a.service.callTool("send_message", SEND);
    await Bun.sleep(5);
    expect(await b.service.callTool("send_message", SEND)).toMatchObject({ ok: false, code: "outcome_unknown", replayed: true });
    expect(await b.service.callTool("send_message", { ...SEND, recoveryOnly: true })).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(b.bindingCalls).toHaveLength(0);
    release();
    expect(await winner).toMatchObject({ ok: true, operationId: "op_race", replayed: false });
    expect(await b.service.callTool("send_message", SEND)).toMatchObject({ ok: true, operationId: "op_race", replayed: true });
    expect(a.bindingCalls).toHaveLength(1);
    first.close();
    second.close();
  });

  test("a recoverable tool requires a store that can recover", () => {
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    const legacyStore: McpReceiptStore = { claim: () => ({ kind: "fresh" }), complete: () => {} };
    const tool: McpRecoverableTool = {
      bind: () => ({ caller: OWNER, target: { project: null, identity: null }, downstreamKey: "k" }),
      recover: async () => ({ outcome: "unknown", evidence: "none", reason: null, ids: {} }),
    };
    const service = createMcpToolService(bindings, legacyStore, undefined, { recovery: { send_message: tool } });
    expect(service.callTool("send_message", SEND)).rejects.toThrow("cannot recover send_message");
  });
});

for (const tool of ["send_message", "spawn_agent"] as const) {
  for (const response of ["timeout", "reset", "error", "success", "recovery", "not-executed", "write-failure"] as const) {
    test(`${tool}: delayed ${response} preserves concurrently stored terminal evidence and IDs`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-terminal-race-"));
      scratch.push(directory);
      const filename = path.join(directory, "receipts.sqlite");
      const first = new SqliteMcpReceiptStore(filename);
      const second = new SqliteMcpReceiptStore(filename);
      let release!: () => void;
      let reached!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { reached = resolve; });
      const args = tool === "send_message" ? SEND : SPAWN;
      const ids: Record<string, string> = tool === "send_message" ? { operationId: "op_terminal" } : { launchId: "launch_terminal", conversationId: "conversation_terminal" };
      const terminal: McpRecoveryEvidence = { outcome: "settled", evidence: "durable-fixture", reason: null, ids, facts: { state: tool === "send_message" ? "delivered" : "completed" } };
      const original = recoveryHarness(OWNER, first, {
        bindingImpl: async () => {
          reached();
          await held;
          if (response === "success" || response === "write-failure") return { ...ids, outcome: "queued" };
          if (response === "not-executed") throw new McpDispatchNotExecutedError("late refusal");
          if (response === "error") throw new McpDispatchVerdictError("late error", { status: 503, ...ids });
          throw new McpDispatchUncertainError(response);
        },
      });
      const observer = recoveryHarness(OWNER, second, { evidence: terminal });
      try {
        const pending = original.service.callTool(tool, args);
        await entered;
        expect(await observer.service.callTool(tool, { ...args, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "settled", ...ids });
        // The original's evidence reader has only unknown. Terminal state must
        // survive both an explicit lookup and every delayed response class.
        if (response === "recovery") {
          expect(await original.service.callTool(tool, { ...args, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "settled", ...ids });
        }
        if (response === "write-failure") first.settle = () => { throw new Error("receipt write unavailable"); };
        release();
        expect(await pending).toMatchObject({ ok: true, outcome: "settled", ...ids });
        expect(original.bindingCalls).toHaveLength(1);
        expect(observer.bindingCalls).toHaveLength(0);
      } finally {
        release();
        first.close();
        second.close();
      }
      const reopened = new SqliteMcpReceiptStore(filename);
      try {
        const restarted = recoveryHarness(OWNER, reopened);
        for (const recoveryOnly of [true, false]) expect(await restarted.service.callTool(tool, { ...args, recoveryOnly })).toMatchObject({ ok: true, outcome: "settled", ...ids });
        expect(restarted.bindingCalls).toHaveLength(0);
      } finally { reopened.close(); }
    });
  }
}

for (const tool of ["send_message", "spawn_agent"] as const) {
  test(`${tool}: a pending evidence read cannot hide terminal recovery committed before that read returns`, async () => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const heldEvidence = new Promise<McpRecoveryEvidence>((resolve) => {
      release = () => resolve({ outcome: "unknown", evidence: "none", reason: null, ids: {} });
    });
    const store = new MemoryMcpReceiptStore();
    const args = tool === "send_message" ? SEND : SPAWN;
    const original = recoveryHarness(OWNER, store, {
      bindingImpl: async () => { reached(); throw new McpDispatchUncertainError("reset"); },
      evidence: heldEvidence as unknown as McpRecoveryEvidence,
    });
    const pending = original.service.callTool(tool, args);
    await waiting;
    const observer = recoveryHarness(OWNER, store, { evidence: { outcome: "settled", evidence: "durable-fixture", reason: null, ids: { operationId: "op_read_race" } } });
    expect(await observer.service.callTool(tool, { ...args, recoveryOnly: true })).toMatchObject({ ok: true, outcome: "settled", operationId: "op_read_race" });
    release();
    expect(await pending).toMatchObject({ ok: true, outcome: "settled", operationId: "op_read_race" });
    expect(original.bindingCalls).toHaveLength(1);
    expect(observer.bindingCalls).toHaveLength(0);
  });
}

for (const tool of ["send_message", "spawn_agent"] as const) {
  for (const backend of ["memory", "file", "sqlite"] as const) {
    test(`${tool}: ${backend} preserves ordinary acceptance and stronger terminal recovery separately`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-accepted-terminal-"));
      scratch.push(directory);
      const filename = path.join(directory, backend === "sqlite" ? "receipts.sqlite" : "receipts.json");
      const memory = new MemoryMcpReceiptStore();
      const open = () => backend === "memory" ? memory : backend === "file"
        ? new FileMcpReceiptStore(filename) : new SqliteMcpReceiptStore(filename);
      let store = open();
      const args = tool === "send_message" ? SEND : SPAWN;
      const ids: Record<string, string> = tool === "send_message" ? { operationId: "op_accepted" }
        : { launchId: "launch_accepted", conversationId: "conversation_accepted" };
      const terminal: McpRecoveryEvidence = { outcome: "settled", evidence: "durable-fixture", reason: null, ids,
        facts: { state: tool === "send_message" ? "failed" : "completed", resend: "verify-first", duplicateRisk: true } };
      const original = recoveryHarness(OWNER, store, { bindingImpl: async () => ({ ...ids, state: "queued" }) });
      const accepted = await original.service.callTool(tool, args);
      original.evidence = terminal;
      const recovered = await original.service.callTool(tool, { ...args, recoveryOnly: true });
      expect(recovered).toMatchObject({ ok: true, outcome: "settled", ...ids, resend: "verify-first", duplicateRisk: true });
      expect(await original.service.callTool(tool, args)).toEqual({ ...accepted, replayed: true });
      expect(original.bindingCalls).toHaveLength(1);
      const key = `${tool}:${args.clientRequestId}`;
      const record = (await store.lookup(key))!;
      expect(record.result).toEqual(accepted);
      expect(record.recoveryResult).toEqual(recovered);
      if (backend === "file") {
        const imported = new SqliteMcpReceiptStore(path.join(directory, "imported.sqlite"), { legacyFilePath: filename });
        try { expect(imported.lookup(key)).toMatchObject({ result: accepted, recoveryResult: recovered }); }
        finally { imported.close(); }
      }
      // Conflicting terminal writes from a second owner cannot regress the first.
      const contender = open();
      expect(await contender.settle(key, record.digest, { ...recovered, state: "contradictory" } as McpToolResult, "settled", true)).toEqual(recovered);
      await expect(Promise.resolve().then(() => contender.settle(key, "changed-digest", recovered, "settled", true))).rejects.toThrow("ownership changed");
      if (contender instanceof SqliteMcpReceiptStore) contender.close();
      if (store instanceof SqliteMcpReceiptStore) store.close();
      store = open();
      try {
        const restarted = recoveryHarness(OWNER, store);
        for (const evidence of [
          { outcome: "unknown", evidence: "none", reason: "absent", ids: {} },
          "unreadable",
        ]) {
          restarted.evidence = (evidence === "unreadable" ? Promise.reject(new Error("downstream unreadable")) : evidence) as McpRecoveryEvidence;
          expect(await restarted.service.callTool(tool, { ...args, recoveryOnly: true })).toMatchObject({
            ok: true, outcome: "settled", evidence: "mcp-receipt", ...ids, resend: "verify-first", duplicateRisk: true,
          });
          expect(await restarted.service.callTool(tool, args)).toEqual({ ...accepted, replayed: true });
        }
        const stranger = recoveryHarness(OTHER, store);
        expect(await stranger.service.callTool(tool, { ...args, recoveryOnly: true })).toMatchObject({ code: "recovery_not_permitted" });
        expect(restarted.bindingCalls).toHaveLength(0);
      } finally { if (store instanceof SqliteMcpReceiptStore) store.close(); }
    });
  }
}
