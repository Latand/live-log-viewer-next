import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { FileRuntimeEventStore } from "./eventStore";

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

test("runtime event store rejects a non-contiguous append", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-event-append-"));
  const store = new FileRuntimeEventStore(directory);
  store.append("append-thread", { kind: "session-status", status: "idle", seq: 1 });
  expect(() => store.append("append-thread", { kind: "turn-started", turnId: "turn-3", seq: 3 }))
    .toThrow("sequence gap after 1");
  expect(store.load("append-thread")).toEqual([{ kind: "session-status", status: "idle", seq: 1 }]);
});
