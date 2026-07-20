import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { HandoffQueue, type HandoffRow, type HandoffRowInput } from "./handoffQueue";
import { SqliteHandoffQueueStore } from "./handoffQueueStore";

const SQLITE_CHILD = path.join(import.meta.dir, "handoffQueueStore.sqliteChild.ts");

function waitForFile(filename: string): void {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filename)}`);
    Bun.sleepSync(5);
  }
}

function rowInput(overrides: Partial<HandoffRowInput> = {}): HandoffRowInput {
  return {
    operationId: overrides.operationId ?? "handoff_root_1",
    conversationId: overrides.conversationId ?? "conversation_root",
    engine: overrides.engine ?? "codex",
    engineSessionId: overrides.engineSessionId ?? "session_root",
    kind: overrides.kind ?? "root",
    parentConversationId: overrides.parentConversationId ?? null,
    hostGeneration: overrides.hostGeneration ?? "gen-blue",
    accountId: overrides.accountId ?? "acct-a",
    turnState: overrides.turnState ?? "idle",
    pendingDeliveries: overrides.pendingDeliveries ?? [],
  };
}

function storedRow(input: HandoffRowInput, overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    ...input,
    status: "pending",
    predecessorGeneration: null,
    successorGeneration: null,
    replayedDeliveryIds: [],
    interruptionOutcome: null,
    lastError: null,
    enqueuedAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

test("SQLite store survives a container replace and preserves an idempotent replay", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-"));
  const filename = path.join(directory, "handoff-queue.sqlite");

  const outgoing = new HandoffQueue(new SqliteHandoffQueueStore(filename));
  outgoing.enqueue([rowInput({ pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }] })]);
  outgoing.beginDrain("gen-blue");
  const claimed = outgoing.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
  expect(claimed.replay.map((d) => d.deliveryId)).toEqual(["d1"]);
  expect(outgoing.acknowledgeReplay("handoff_root_1", "gen-green", ["d1"])).toBe(true);

  // A fresh process (the successor container) opens the same durable file.
  const successor = new HandoffQueue(new SqliteHandoffQueueStore(filename));
  const row = successor.row("handoff_root_1")!;
  expect(row.status).toBe("claimed");
  expect(row.hostGeneration).toBe("gen-green");
  expect(row.predecessorGeneration).toBe("gen-blue");
  // The persisted acknowledgement completes this delivery across restart.
  const replay = successor.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
  expect(replay.ok).toBe(true);
  expect(replay.replay).toEqual([]);
  expect(successor.rows()).toHaveLength(1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("SQLite serializes independent candidate claims without losing a concurrent delivery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-cas-"));
  const filename = path.join(directory, "handoff-queue.sqlite");
  const releaseFile = path.join(directory, "release");
  const queue = new HandoffQueue(new SqliteHandoffQueueStore(filename));
  queue.enqueue([
    rowInput(),
    rowInput({
      operationId: "handoff_unrelated",
      conversationId: "conversation_unrelated",
      engineSessionId: "session_unrelated",
    }),
  ]);
  queue.beginDrain("gen-blue");

  const specs = [
    { action: "claim", value: "gen-green", delay: "0" },
    { action: "admit", value: "delivery-unrelated", delay: "75" },
    { action: "claim", value: "gen-teal", delay: "150" },
  ];
  const children = specs.map((spec, index) => {
    const readyFile = path.join(directory, `ready-${index}`);
    const child = Bun.spawn([
      process.execPath,
      SQLITE_CHILD,
      filename,
      readyFile,
      releaseFile,
      spec.action,
      spec.value,
      spec.delay,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    return { child, readyFile };
  });

  try {
    for (const { readyFile } of children) waitForFile(readyFile);
    fs.writeFileSync(releaseFile, "go");
    const results = await Promise.all(children.map(async ({ child }) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as { ok?: boolean; admitted?: boolean };
    }));

    expect(results.filter((result) => result.ok === true)).toHaveLength(1);
    expect(results.find((result) => result.admitted !== undefined)?.admitted).toBe(true);

    const restarted = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    expect(restarted.rows()).toHaveLength(2);
    expect(restarted.row("handoff_unrelated")?.pendingDeliveries.map((delivery) => delivery.deliveryId))
      .toEqual(["delivery-unrelated"]);
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite restart keeps one active conversation lease and its completed handoff history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-history-"));
  const filename = path.join(directory, "handoff-queue.sqlite");

  try {
    const first = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    first.enqueue([rowInput({ pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }] })]);
    first.beginDrain("gen-blue");
    first.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    first.acknowledgeReplay("handoff_root_1", "gen-green", ["d1"]);
    first.enqueue([rowInput({
      operationId: "handoff_root_2",
      hostGeneration: "gen-green",
      pendingDeliveries: [{ deliveryId: "d2", clientMessageId: "c2", seq: 1 }],
    })]);

    const restarted = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    expect(restarted.rows().map((row) => row.operationId)).toEqual(["handoff_root_2"]);
    expect(restarted.history()).toEqual([expect.objectContaining({
      operationId: "handoff_root_1",
      predecessorGeneration: "gen-blue",
      successorGeneration: "gen-green",
    })]);
    restarted.beginDrain("gen-green");
    expect(restarted.claim("handoff_root_2", {
      fromGeneration: "gen-green",
      toGeneration: "gen-teal",
    }).replay.map((delivery) => delivery.deliveryId)).toEqual(["d2"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite restart preserves a drain-window turn refresh before claim", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-turn-"));
  const filename = path.join(directory, "handoff-queue.sqlite");

  try {
    const outgoing = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    outgoing.enqueue([rowInput({ turnState: "busy" })]);
    outgoing.beginDrain("gen-blue");
    expect(outgoing.refreshTurnState("handoff_root_1", "gen-blue", "terminal")).toBe(true);

    const restarted = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    expect(restarted.claim("handoff_root_1", {
      fromGeneration: "gen-blue",
      toGeneration: "gen-green",
    }).row).toMatchObject({
      turnState: "terminal",
      status: "terminal",
      interruptionOutcome: "completed",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite restart keeps drain admission closed with zero eligible rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-empty-drain-"));
  const filename = path.join(directory, "handoff-queue.sqlite");

  try {
    const outgoing = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    outgoing.beginDrain("gen-empty");
    expect(outgoing.isAdmittingNewHosts("gen-empty")).toBe(false);

    const restarted = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    expect(restarted.isAdmittingNewHosts("gen-empty")).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite restart keeps drain admission closed after every row reaches a boundary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-finished-drain-"));
  const filename = path.join(directory, "handoff-queue.sqlite");

  try {
    const outgoing = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    outgoing.enqueue([
      rowInput({ operationId: "terminal", conversationId: "conversation_terminal", turnState: "terminal" }),
      rowInput({ operationId: "failed", conversationId: "conversation_failed", engineSessionId: "session_failed" }),
    ]);
    outgoing.beginDrain("gen-blue");
    outgoing.claim("terminal", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    outgoing.markRetryableFailure("failed", "resume unavailable");
    expect(outgoing.retirable("gen-blue")).toBe(true);

    const restarted = new HandoffQueue(new SqliteHandoffQueueStore(filename));
    expect(restarted.isAdmittingNewHosts("gen-blue")).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite migration preserves duplicate legacy rows as one active lease plus history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-migrate-"));
  const filename = path.join(directory, "handoff-queue.sqlite");
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const database = new sqlite.Database(filename, { create: true, strict: true });
  database.exec(`
    CREATE TABLE handoff_rows (
      operation_id TEXT PRIMARY KEY,
      row_order INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
  `);
  const first = storedRow(rowInput(), {
    status: "claimed",
    hostGeneration: "gen-green",
    predecessorGeneration: "gen-blue",
    successorGeneration: "gen-green",
  });
  const second = storedRow(rowInput({ operationId: "handoff_root_2", hostGeneration: "gen-green" }), {
    status: "draining",
  });
  const insert = database.query<unknown, [string, number, string]>(
    "INSERT INTO handoff_rows(operation_id, row_order, value_json) VALUES (?, ?, ?)",
  );
  insert.run(first.operationId, 0, JSON.stringify(first));
  insert.run(second.operationId, 1, JSON.stringify(second));
  database.close();

  try {
    const migrated = new SqliteHandoffQueueStore(filename);
    expect(migrated.load()).toEqual([second]);
    expect(migrated.loadHistory()).toEqual([first]);
    expect(migrated.loadDrainingGenerations()).toEqual(["gen-green"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
