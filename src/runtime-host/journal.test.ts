import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeHost, RuntimeHostFence } from "./host";
import { RuntimeJournal, RuntimeJournalFault } from "./journal";
import { serveRuntimeHost } from "./socket";

function sandbox(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-${name}-`));
}

test("journal assigns global sequences, consecutive scoped revisions, and idempotent producer keys", () => {
  const dir = sandbox("sequence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const first = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" }, producerKey: "native:a" });
  const duplicate = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" }, producerKey: "native:a" });
  const second = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: { turnId: "a" } });
  const third = journal.append({ scope: runtimeScope("flow", "one"), kind: "flow.ready", payload: {} });
  expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 1]);
  expect(duplicate).toEqual(first);
  expect(journal.snapshot()).toEqual({
    snapshotSeq: 3,
    scopes: {
      "flow:one": { revision: 1, state: { revision: 1, lastKind: "flow.ready", payload: {} } },
      "session:one": { revision: 2, state: { revision: 2, lastKind: "turn.completed", payload: { turnId: "a" } } },
    },
  });
  journal.close();
});

test("journal compaction emits a deterministic retention reset and leaves an anchor-verified tail", () => {
  const dir = sandbox("compact");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  for (let i = 0; i < 4; i += 1) journal.append({ scope: runtimeScope("session", "one"), kind: "item.completed", payload: { i } });
  expect(journal.replay(0)).toEqual({ reset: true, floorSeq: 2, events: [] });
  expect(journal.replay(2).events.map((event) => event.seq)).toEqual([3, 4]);
  journal.close();
  const reopened = new RuntimeJournal(filename, { maxEvents: 2 });
  expect(reopened.replay(2).events).toHaveLength(2);
  reopened.close();
});

test("journal detects a modified hash chain and fails closed", () => {
  const dir = sandbox("fault");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename);
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: {} });
  journal.close();
  const database = new Database(filename);
  database.exec("UPDATE events SET hash = 'broken' WHERE seq = 1");
  database.close();
  const corrupted = new RuntimeJournal(filename);
  expect(() => corrupted.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: {} })).toThrow(RuntimeJournalFault);
  corrupted.close();
});

test("Unix socket host isolates a singleton writer and serves a fake Viewer client", async () => {
  const dir = sandbox("socket");
  const socketPath = path.join(dir, "runtime.sock");
  const fence = new RuntimeHostFence(`${socketPath}.lock`);
  fence.acquire();
  expect(() => new RuntimeHostFence(`${socketPath}.lock`).acquire()).toThrow("singleton fence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"));
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  await client.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: {} });
  expect((await client.snapshot()).snapshotSeq).toBe(1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  journal.close();
  fence.release();
});
