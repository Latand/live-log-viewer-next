import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  codexThreadIdFromPath,
  isNativeCodexSubagentTranscript,
  nativeCodexForkSourceThreadId,
  nativeCodexParentThreadId,
} from "./codexNative";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-native-test-"));

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const SOURCE_ID = "019f9557-0000-\x37000-8000-00000000aaaa";
const FORK_ID = "019f9c11-0000-\x37000-8000-00000000bbbb";
const PARENT_ID = "019f421e-0000-\x37000-8000-00000000cccc";

function rollout(name: string, rows: unknown[]): string {
  const pathname = path.join(SANDBOX, `rollout-${name}.jsonl`);
  fs.writeFileSync(pathname, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  return pathname;
}

function sizeOf(pathname: string): number {
  return fs.statSync(pathname).size;
}

test("a fork reports the source thread from its first session_meta row", () => {
  const pathname = rollout(`fork-${FORK_ID}`, [
    { type: "session_meta", payload: { id: FORK_ID, forked_from_id: SOURCE_ID, cwd: "/repo" } },
  ]);

  expect(nativeCodexForkSourceThreadId(pathname, sizeOf(pathname))).toBe(SOURCE_ID);
});

test("the replayed ancestor session_meta on row two never overrides row one", () => {
  /* A Codex fork is a full snapshot: its own header comes first, and the source
     conversation's own `session_meta` is replayed straight after it. A reader
     that kept scanning would take the second row's id-with-no-fork-edge and
     attribute the fork to itself, losing the edge back to the source. */
  const pathname = rollout(`replayed-${FORK_ID}`, [
    { type: "session_meta", payload: { id: FORK_ID, forked_from_id: SOURCE_ID, cwd: "/repo" } },
    { type: "session_meta", payload: { id: SOURCE_ID, cwd: "/repo" } },
    { type: "response_item", payload: { type: "message", role: "user" } },
  ]);

  expect(nativeCodexForkSourceThreadId(pathname, sizeOf(pathname))).toBe(SOURCE_ID);
});

test("a fork of a fork names the fork it was taken from, not the original root", () => {
  const middleId = "019f9c13-0000-\x37000-8000-00000000dddd";
  const pathname = rollout("fork-of-fork", [
    { type: "session_meta", payload: { id: "019f9c15-0000-\x37000-8000-00000000eeee", forked_from_id: middleId } },
    { type: "session_meta", payload: { id: middleId, forked_from_id: SOURCE_ID } },
  ]);

  expect(nativeCodexForkSourceThreadId(pathname, sizeOf(pathname))).toBe(middleId);
});

test("a fork is not a subagent and a subagent is not a fork", () => {
  const forkPath = rollout("fork-vs-subagent", [
    { type: "session_meta", payload: { id: FORK_ID, forked_from_id: SOURCE_ID } },
  ]);
  const subagentPath = rollout("subagent", [
    { type: "session_meta", payload: { id: FORK_ID, parent_thread_id: PARENT_ID } },
  ]);
  const nestedSubagentPath = rollout("nested-subagent", [
    { type: "session_meta", payload: { id: FORK_ID, source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID } } } } },
  ]);

  expect(nativeCodexParentThreadId(forkPath, sizeOf(forkPath))).toBeNull();
  expect(isNativeCodexSubagentTranscript(forkPath, sizeOf(forkPath))).toBeFalse();
  expect(nativeCodexForkSourceThreadId(subagentPath, sizeOf(subagentPath))).toBeNull();
  expect(nativeCodexParentThreadId(subagentPath, sizeOf(subagentPath))).toBe(PARENT_ID);
  expect(nativeCodexParentThreadId(nestedSubagentPath, sizeOf(nestedSubagentPath))).toBe(PARENT_ID);
});

test("an ordinary rollout and an unreadable path report no fork source", () => {
  const plain = rollout("plain", [{ type: "session_meta", payload: { id: SOURCE_ID, cwd: "/repo" } }]);

  expect(nativeCodexForkSourceThreadId(plain, sizeOf(plain))).toBeNull();
  expect(nativeCodexForkSourceThreadId(path.join(SANDBOX, "absent.jsonl"), 10)).toBeNull();
});

test("the thread id of a rollout comes from its filename", () => {
  expect(codexThreadIdFromPath(`/sessions/2026/07/26/rollout-2026-07-26T01-37-15-${FORK_ID}.jsonl`)).toBe(FORK_ID);
  expect(codexThreadIdFromPath("/sessions/notes.txt")).toBeNull();
});
