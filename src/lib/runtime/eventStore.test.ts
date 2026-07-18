import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import type { RuntimeEvent } from "./engineHost";
import { FileRuntimeEventStore, reconcileRuntimeEventCursor } from "./eventStore";

test("runtime event store durably replays ordered events and ignores a partial tail", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-events-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("thread/unsafe", { kind: "session-status", status: "idle", seq: 1 });
  store.append("thread/unsafe", { kind: "turn-started", turnId: "turn-1", seq: 2 });
  const filename = path.join(directory, "thread%2Funsafe.jsonl");
  fs.appendFileSync(filename, "{partial");
  store.append("thread/unsafe", { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 });

  expect(store.load("thread/unsafe")).toEqual([
    { kind: "session-status", status: "idle", seq: 1 },
    { kind: "turn-started", turnId: "turn-1", seq: 2 },
    { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 },
  ]);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
});

test("runtime event store repairs a crash tail after the production 942-record contiguous prefix", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-crash-tail-"));
  const filename = path.join(directory, "crash-tail.jsonl");
  const prefix = Array.from({ length: 942 }, (_, index) => JSON.stringify({
    kind: "session-status",
    status: "idle",
    seq: index + 1,
  })).join("\n");
  fs.writeFileSync(filename, `${prefix}\n{\"kind\":\"session-status\",\"status\":`, { mode: 0o600 });
  const store = new FileRuntimeEventStore(directory);

  store.append("crash-tail", { kind: "turn-started", turnId: "recovered-turn", seq: 943 });

  const restored = store.load("crash-tail");
  expect(restored).toHaveLength(943);
  expect(restored.slice(-2)).toEqual([
    { kind: "session-status", status: "idle", seq: 942 },
    { kind: "turn-started", turnId: "recovered-turn", seq: 943 },
  ]);
  expect(fs.readFileSync(filename, "utf8").endsWith("\n")).toBeTrue();
});

test("runtime event store fails closed on gaps, duplicates, and malformed middle records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-gaps-"));
  const filename = path.join(directory, "gap-thread.jsonl");
  fs.writeFileSync(filename, [
    JSON.stringify({ kind: "session-status", status: "idle", seq: 1 }),
    JSON.stringify({ kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 }),
    "",
  ].join("\n"));
  const store = new FileRuntimeEventStore(directory);
  expect(() => store.load("gap-thread")).toThrow("sequence gap after 1");

  fs.writeFileSync(filename, [
    JSON.stringify({ kind: "session-status", status: "idle", seq: 1 }),
    JSON.stringify({ kind: "session-status", status: "active", seq: 1 }),
    "",
  ].join("\n"));
  expect(() => store.load("gap-thread")).toThrow("sequence gap after 1");

  fs.writeFileSync(filename, `${JSON.stringify({ kind: "session-status", status: "idle", seq: 1 })}\n{broken}\n`);
  expect(() => store.load("gap-thread")).toThrow("malformed JSON");
});

test("runtime event store appends without re-reading the owned ledger (#367 live-turn starvation)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-hot-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("hot-thread", { kind: "session-status", status: "idle", seq: 1 });

  const reads = spyOn(fs, "readFileSync");
  try {
    for (let seq = 2; seq <= 200; seq += 1) {
      store.append("hot-thread", { kind: "delta", turnId: "turn-1", text: "streamed structured output", seq });
    }
    expect(reads.mock.calls.length).toBe(0);
  } finally {
    reads.mockRestore();
  }
  const events = store.load("hot-thread");
  expect(events).toHaveLength(200);
  expect(events.at(-1)).toEqual({ kind: "delta", turnId: "turn-1", text: "streamed structured output", seq: 200 });
});

test("runtime event store derives its durable tail once and re-reconciles only on external divergence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-tail-"));
  const filename = path.join(directory, "owned-thread.jsonl");
  fs.writeFileSync(filename, [
    JSON.stringify({ kind: "session-status", status: "idle", seq: 1 }),
    JSON.stringify({ kind: "turn-started", turnId: "turn-1", seq: 2 }),
    "",
  ].join("\n"), { mode: 0o600 });

  const store = new FileRuntimeEventStore(directory);
  expect(() => store.append("owned-thread", { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 4 }))
    .toThrow("sequence gap after 2");
  store.append("owned-thread", { kind: "turn-ended", turnId: "turn-1", status: "completed", seq: 3 });

  fs.writeFileSync(filename, `${JSON.stringify({ kind: "session-status", status: "idle", seq: 1 })}\n`, { mode: 0o600 });
  store.append("owned-thread", { kind: "turn-started", turnId: "turn-2", seq: 2 });

  expect(store.load("owned-thread")).toEqual([
    { kind: "session-status", status: "idle", seq: 1 },
    { kind: "turn-started", turnId: "turn-2", seq: 2 },
  ]);
});

test("runtime event store rejects a non-contiguous append", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-append-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("append-thread", { kind: "session-status", status: "idle", seq: 1 });
  expect(() => store.append("append-thread", { kind: "turn-started", turnId: "turn-3", seq: 3 }))
    .toThrow("sequence gap after 1");
  expect(store.load("append-thread")).toEqual([{ kind: "session-status", status: "idle", seq: 1 }]);
});

test.each([2_906, 2_908])("runtime cursor recovery diagnoses registry cursor %i against durable tail 2907", (registryCursor) => {
  const diagnostics: unknown[] = [];
  const cursor = reconcileRuntimeEventCursor(
    "019f64a8-cfee-7b20-9a5a-259f13192ed1",
    2_907,
    registryCursor,
    (diagnostic) => diagnostics.push(diagnostic),
  );

  expect(cursor).toBe(2_907);
  expect(diagnostics).toEqual([{
    kind: "runtime-event-cursor-recovery",
    sessionId: "019f64a8-cfee-7b20-9a5a-259f13192ed1",
    durableTailSeq: 2_907,
    registryCursor,
    chosenNextSeq: 2_908,
    action: "use-durable-tail",
    relation: registryCursor < 2_907 ? "registry-behind" : "registry-ahead",
  }]);
});

test("runtime cursor recovery retains an established registry watermark when the durable ledger is empty", () => {
  const diagnostics: unknown[] = [];

  expect(reconcileRuntimeEventCursor("legacy-session", 0, 12, (diagnostic) => diagnostics.push(diagnostic))).toBe(12);
  expect(diagnostics).toEqual([expect.objectContaining({
    sessionId: "legacy-session",
    durableTailSeq: 0,
    registryCursor: 12,
    chosenNextSeq: 13,
    action: "use-registry-cursor",
    relation: "durable-ledger-empty",
  })]);
});

test("runtime cursor diagnostics stay bounded and cannot fail ledger recovery", () => {
  const diagnostics: Array<{ sessionId: string }> = [];
  const cursor = reconcileRuntimeEventCursor("s".repeat(500), 2_907, 2_908, (value) => {
    diagnostics.push(value);
    throw new Error("diagnostic sink unavailable");
  });

  expect(cursor).toBe(2_907);
  expect(diagnostics[0]?.sessionId).toHaveLength(160);
});

test.each([
  { durableTailSeq: Number.MAX_SAFE_INTEGER, registryCursor: Number.MAX_SAFE_INTEGER },
  { durableTailSeq: 0, registryCursor: Number.MAX_SAFE_INTEGER },
])("runtime cursor recovery rejects an exhausted authoritative cursor", ({ durableTailSeq, registryCursor }) => {
  expect(() => reconcileRuntimeEventCursor("exhausted-session", durableTailSeq, registryCursor))
    .toThrow("runtime event cursor cannot advance safely");
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "runtime cursor recovery rejects invalid registry cursor %p",
  (registryCursor) => {
    expect(() => reconcileRuntimeEventCursor("invalid-cursor", 0, registryCursor))
      .toThrow("runtime event registry cursor is invalid");
  },
);

test.each([1.5, Number.MAX_SAFE_INTEGER + 1])("runtime event store rejects unsafe append sequence %p", (seq) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-unsafe-append-"));
  const store = new FileRuntimeEventStore(directory);
  expect(() => store.append("unsafe-append", { kind: "session-status", status: "idle", seq } as RuntimeEvent))
    .toThrow("runtime event ledger append event is invalid");
  expect(store.load("unsafe-append")).toEqual([]);
});

test("runtime event store rejects every structurally invalid event variant", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-shapes-"));
  const filename = path.join(directory, "shape-thread.jsonl");
  const store = new FileRuntimeEventStore(directory);
  const invalid = [
    { kind: "unknown", seq: 1 },
    { kind: "turn-started", seq: 1 },
    { kind: "turn-started", turnId: "", seq: 1 },
    { kind: "delta", turnId: "turn-1", seq: 1 },
    { kind: "delta", turnId: "", text: "chunk", seq: 1 },
    { kind: "item", turnId: "turn-1", phase: "completed", seq: 1 },
    { kind: "item", turnId: "", item: {}, phase: "completed", seq: 1 },
    { kind: "turn-ended", turnId: "turn-1", status: "success", seq: 1 },
    { kind: "attention", id: "approval-1", attention: {}, seq: 1 },
    { kind: "attention", id: "", method: "approval", attention: {}, seq: 1 },
    { kind: "attention-resolved", id: "approval-1", resolution: "unknown", seq: 1 },
    { kind: "limits", seq: 1 },
    { kind: "session-status", status: "active", activeFlags: [42], seq: 1 },
    { kind: "session-status", status: "active", activeFlags: [""], seq: 1 },
  ];
  for (const event of invalid) {
    fs.writeFileSync(filename, `${JSON.stringify(event)}\n`);
    expect(() => store.load("shape-thread")).toThrow("invalid event");
  }
});
