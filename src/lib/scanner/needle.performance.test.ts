import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileHasNeedle, findNeedle, type NeedleScanBudget } from "./needle";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-needle-performance-"));
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

const realReadSync = fs.readSync;
let observedBytes = 0;

function instrumentReads(): void {
  observedBytes = 0;
  (fs as { readSync: typeof fs.readSync }).readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const read = (realReadSync as (...inner: Parameters<typeof fs.readSync>) => number)(...args);
    observedBytes += read;
    return read;
  }) as typeof fs.readSync;
}

afterEach(() => {
  (fs as { readSync: typeof fs.readSync }).readSync = realReadSync;
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** A logical 3 GiB append-only transcript: real JSONL rows at the head, a
    sparse hole for the bulk. Reads stay cheap while sizes match production. */
function virtualTranscript(name: string, logicalBytes = 3 * GIB): string {
  const pathname = path.join(SANDBOX, name);
  const fd = fs.openSync(pathname, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } })}\n`);
    fs.ftruncateSync(fd, logicalBytes);
  } finally {
    fs.closeSync(fd);
  }
  return pathname;
}

test("an absent needle in a 3 GiB candidate consumes exactly the generation budget", () => {
  const pathname = virtualTranscript("absent-needle.jsonl");
  const budget: NeedleScanBudget = { remaining: 256 * 1024 };
  instrumentReads();

  expect(fileHasNeedle("toolu_deadbeef", pathname, budget)).toBe(false);

  expect(observedBytes).toBe(256 * 1024);
  expect(budget.remaining).toBe(0);
  // An exhausted budget refuses further reads outright.
  expect(fileHasNeedle("toolu_deadbeef", pathname, budget)).toBe(false);
  expect(observedBytes).toBe(256 * 1024);
});

test("a candidate pass is capped at 1 MiB even under a larger generation budget", () => {
  const pathname = virtualTranscript("pass-capped.jsonl");
  const budget: NeedleScanBudget = { remaining: 8 * MIB };
  instrumentReads();

  expect(fileHasNeedle("toolu_pass_cap", pathname, budget)).toBe(false);

  expect(observedBytes).toBe(MIB);
  expect(budget.remaining).toBe(7 * MIB);
});

test("budgeted scanning resumes deterministically and proves lineage once reached", () => {
  const pathname = virtualTranscript("resumable.jsonl", 4 * MIB);
  const needle = "toolu_resume_proof";
  const fd = fs.openSync(pathname, "r+");
  try {
    const proof = Buffer.from(`{"toolUseId":"${needle}"}\n`);
    fs.writeSync(fd, proof, 0, proof.length, Math.floor(2.5 * MIB));
  } finally {
    fs.closeSync(fd);
  }

  // Generation 1 and 2 exhaust their 1 MiB budgets before the proof offset.
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(false);
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(false);
  // Generation 3 reaches 2.5 MiB and proves the lineage.
  expect(fileHasNeedle(needle, pathname, { remaining: MIB })).toBe(true);
  // The proven hit is cached: an exhausted budget still answers true.
  expect(fileHasNeedle(needle, pathname, { remaining: 0 })).toBe(true);
});

test("findNeedle shares one generation budget across candidate files", () => {
  const first = virtualTranscript("shared-a.jsonl", 4 * MIB);
  const second = virtualTranscript("shared-b.jsonl", 4 * MIB);
  const budget: NeedleScanBudget = { remaining: 1.5 * MIB };
  instrumentReads();

  expect(findNeedle("toolu_shared_budget", [first, second], budget)).toBe(null);

  // First candidate consumed its 1 MiB pass cap, the second the remainder.
  expect(observedBytes).toBe(1.5 * MIB);
  expect(budget.remaining).toBe(0);
});

test("a truncated candidate restarts its observation instead of skipping content", () => {
  const pathname = path.join(SANDBOX, "truncated.jsonl");
  fs.writeFileSync(pathname, "x".repeat(2 * MIB));
  expect(fileHasNeedle("toolu_truncated", pathname)).toBe(false);

  fs.writeFileSync(pathname, `prefix toolu_truncated suffix\n`);
  expect(fileHasNeedle("toolu_truncated", pathname)).toBe(true);
});
