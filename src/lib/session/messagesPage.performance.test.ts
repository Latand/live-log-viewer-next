import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateCodexRollout } from "../../../scripts/conversation-messages-fixture";
import { readMessagesPage, type MessagesPageCursor } from "./messagesPage";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-messages-performance-"));
const pathname = path.join(directory, "generated-rollout.jsonl");

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a page from a generated 100 MB rollout reads only bounded tail windows", () => {
  generateCodexRollout(pathname, 100 * 1024 * 1024, 1311);
  const descriptor = fs.openSync(pathname, "r");
  const size = fs.fstatSync(descriptor).size;
  expect(size).toBeGreaterThanOrEqual(100 * 1024 * 1024);

  const originalReadSync = fs.readSync;
  let observedBytes = 0;
  const countingReadSync = ((...args: unknown[]) => {
    const read = Reflect.apply(originalReadSync, fs, args) as number;
    observedBytes += read;
    return read;
  }) as typeof fs.readSync;
  const readSpy = spyOn(fs, "readSync").mockImplementation(countingReadSync);
  const read = (cursor: MessagesPageCursor | null) => readMessagesPage({ descriptor, size, engine: "codex" }, {
    kinds: new Set(["message"]),
    roles: new Set(["user", "assistant", "system", "tool"]),
    limit: 20,
    maxChars: 4_000,
    cursor,
  });

  try {
    const first = read(null);
    expect(first.records).toHaveLength(20);
    expect(observedBytes).toBe(first.scanned.bytes);
    expect(observedBytes).toBeLessThan(4 * 1024 * 1024);
    expect(observedBytes).toBeLessThan(size * 0.05);

    let cursor = first.cursor;
    for (let page = 1; page < 9; page += 1) cursor = read(cursor).cursor;
    observedBytes = 0;
    const tenth = read(cursor);
    expect(tenth.records).toHaveLength(20);
    expect(observedBytes).toBe(tenth.scanned.bytes);
    expect(observedBytes).toBeLessThan(4 * 1024 * 1024);
    expect(observedBytes).toBeLessThan(size * 0.05);
  } finally {
    readSpy.mockRestore();
    fs.closeSync(descriptor);
  }
});
