import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { globalCache } from "@/lib/scanner/caches";

import {
  scanUserAuthoredMessagesCooperatively,
  type AuthorshipScanBudget,
} from "./reader";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reader-performance-"));
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

interface Checkpoint {
  offset: number;
  count: number;
  done: boolean;
}

function checkpointFor(pathname: string): Checkpoint | undefined {
  return globalCache<Checkpoint>("authorship-scan-checkpoint-v1").get(pathname);
}

/** A logical 3 GiB transcript without an owner message: agent rows at the
    head, a sparse hole for the bulk. */
function virtualTranscript(name: string, logicalBytes = 3 * GIB): string {
  const pathname = path.join(SANDBOX, name);
  const fd = fs.openSync(pathname, "w");
  try {
    for (let row = 0; row < 16; row += 1) {
      fs.writeSync(fd, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: `progress ${row}` } })}\n`);
    }
    fs.ftruncateSync(fd, logicalBytes);
  } finally {
    fs.closeSync(fd);
  }
  return pathname;
}

test("a 3 GiB ownerless transcript stops at the exact per-pass byte ceiling and resumes", async () => {
  const pathname = virtualTranscript("owner-absent.jsonl");
  const budget: AuthorshipScanBudget = { remaining: 32 * MIB };

  const first = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    maxBytes: 4 * MIB,
    budget,
  });

  expect(first).toEqual({ count: 0, complete: false });
  expect(checkpointFor(pathname)!.offset).toBe(4 * MIB);
  expect(budget.remaining).toBe(28 * MIB);

  // A later cycle resumes from the recorded offset instead of restarting.
  const second = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    maxBytes: 4 * MIB,
    budget,
  });

  expect(second).toEqual({ count: 0, complete: false });
  // The resumed pass pays its 64 KiB head-fingerprint validation and then
  // continues forward; the first 4 MiB are never re-scanned.
  expect(checkpointFor(pathname)!.offset).toBe(8 * MIB - 64 * 1024);
  expect(budget.remaining).toBe(24 * MIB);
});

test("an exhausted shared budget refuses the pass without touching the transcript", async () => {
  const pathname = virtualTranscript("budget-exhausted.jsonl", 16 * MIB);
  const budget: AuthorshipScanBudget = { remaining: 0 };

  const scan = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    maxBytes: 4 * MIB,
    budget,
  });

  expect(scan).toEqual({ count: 0, complete: false });
  expect(budget.remaining).toBe(0);
});

test("an exhausted shared budget preserves a resumable checkpoint without validating its head", async () => {
  const pathname = virtualTranscript("resumed-budget-exhausted.jsonl", 16 * MIB);

  const first = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    maxBytes: 4 * MIB,
  });
  expect(first).toEqual({ count: 0, complete: false });
  const checkpoint = checkpointFor(pathname)!;
  expect(checkpoint.offset).toBe(4 * MIB);

  const budget: AuthorshipScanBudget = { remaining: 0 };
  const resumed = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    maxBytes: 4 * MIB,
    budget,
  });

  expect(resumed).toEqual({ count: 0, complete: false });
  expect(budget.remaining).toBe(0);
  expect(checkpointFor(pathname)).toEqual(checkpoint);
});

test("a pre-aborted resumed scan preserves its checkpoint without validating its head", async () => {
  const pathname = virtualTranscript("resumed-pre-aborted.jsonl", 16 * MIB);
  await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    maxBytes: 4 * MIB,
  });
  const checkpoint = checkpointFor(pathname)!;
  const budget: AuthorshipScanBudget = { remaining: 128 * 1024 };
  const abort = new AbortController();
  abort.abort();

  const resumed = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    maxBytes: 4 * MIB,
    budget,
    signal: abort.signal,
  });

  expect(resumed).toEqual({ count: checkpoint.count, complete: false });
  expect(budget.remaining).toBe(128 * 1024);
  expect(checkpointFor(pathname)).toEqual(checkpoint);
});

test("cancellation lands on a 64 KiB chunk boundary and keeps the checkpoint resumable", async () => {
  const pathname = virtualTranscript("aborted.jsonl");
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 0);

  const scan = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    signal: abort.signal,
  });

  expect(scan.complete).toBe(false);
  const checkpoint = checkpointFor(pathname)!;
  expect(checkpoint.done).toBe(false);
  expect(checkpoint.offset).toBeLessThan(3 * GIB);
  expect(checkpoint.offset % (64 * 1024)).toBe(0);
});

test("a truncated transcript resets its checkpoint instead of replaying stale evidence", async () => {
  const pathname = virtualTranscript("truncated.jsonl", 8 * MIB);
  const first = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, {
    resume: true,
    maxBytes: 4 * MIB,
  });
  expect(first).toEqual({ count: 0, complete: false });
  expect(checkpointFor(pathname)!.offset).toBe(4 * MIB);

  // Replace the file with a short transcript that contains a human message.
  fs.writeFileSync(pathname, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`);

  const second = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, { resume: true });
  expect(second.count).toBe(1);
});

test("a same-size in-place tail rewrite invalidates completed authorship evidence", async () => {
  const pathname = path.join(SANDBOX, "same-size-rewrite.jsonl");
  const prefix = `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(70 * 1024) } })}\n`;
  const assistantTail = `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "done" } })}\n`;
  const userTail = `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`;
  expect(userTail.length).toBe(assistantTail.length);
  fs.writeFileSync(pathname, prefix + assistantTail);

  const first = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, { resume: true });
  expect(first).toEqual({ count: 0, complete: true });
  const before = fs.statSync(pathname);

  const fd = fs.openSync(pathname, "r+");
  try {
    fs.writeSync(fd, userTail, before.size - Buffer.byteLength(assistantTail), "utf8");
  } finally {
    fs.closeSync(fd);
  }
  fs.utimesSync(pathname, before.atime, new Date(before.mtimeMs + 2_000));
  const rewritten = fs.statSync(pathname);
  expect(rewritten.ino).toBe(before.ino);
  expect(rewritten.size).toBe(before.size);
  expect(rewritten.mtimeMs).not.toBe(before.mtimeMs);

  const second = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, { resume: true });
  expect(second).toEqual({ count: 1, complete: true });
});

test("a finished scan replays its verdict from the checkpoint without re-reading", async () => {
  const pathname = path.join(SANDBOX, "finished.jsonl");
  fs.writeFileSync(pathname, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "done" } })}\n`);

  const first = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, { resume: true });
  expect(first).toEqual({ count: 0, complete: true });
  expect(checkpointFor(pathname)!.done).toBe(true);

  const budget: AuthorshipScanBudget = { remaining: 128 };
  const second = await scanUserAuthoredMessagesCooperatively(pathname, "codex", 1, { resume: true, budget });
  expect(second).toEqual({ count: 0, complete: true });
  // Only the head-fingerprint validation window was read.
  expect(budget.remaining).toBe(128 - fs.statSync(pathname).size);
});
