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
