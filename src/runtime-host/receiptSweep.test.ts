import { expect, test } from "bun:test";

import {
  ReceiptSweepReporter,
  receiptSweepDebugEnabled,
  RECEIPT_SWEEP_SUMMARY_INTERVAL_MS,
} from "./receiptSweep";

const SWEEP_TICK_MS = 10_000;
const TICKS_PER_WINDOW = RECEIPT_SWEEP_SUMMARY_INTERVAL_MS / SWEEP_TICK_MS;

function sweep(
  reporter: ReceiptSweepReporter,
  ticks: readonly number[],
  deleted: (tick: number) => number,
): string[] {
  const lines: string[] = [];
  for (const tick of ticks) {
    const line = reporter.record(
      { scanned: 4_096, deleted: deleted(tick), cycled: true },
      tick * SWEEP_TICK_MS,
    );
    if (line) lines.push(line);
  }
  return lines;
}

function ticks(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
}

/* The sweep ticks every 10s. One line per cycle buried a whole deployment in
   the runtime-host log, which is why #1216 could not be diagnosed from it. */
test("a continuously deleting sweep logs one aggregated line per window", () => {
  const reporter = new ReceiptSweepReporter();
  const lines = sweep(reporter, ticks(1, TICKS_PER_WINDOW * 2 + 1), () => 7);

  expect(lines).toEqual([
    `[runtime journal] receipt sweep removed ${7 * (TICKS_PER_WINDOW + 1)} stale producer receipts across ${TICKS_PER_WINDOW + 1} cycles in the last 15m`,
    `[runtime journal] receipt sweep removed ${7 * TICKS_PER_WINDOW} stale producer receipts across ${TICKS_PER_WINDOW} cycles in the last 15m`,
  ]);
});

test("a sweep with nothing to remove stays silent", () => {
  const reporter = new ReceiptSweepReporter();
  expect(sweep(reporter, ticks(1, TICKS_PER_WINDOW * 3), () => 0)).toEqual([]);
});

test("the per-cycle line survives only under the journal debug flag", () => {
  const reporter = new ReceiptSweepReporter({ debug: true });
  expect(sweep(reporter, ticks(1, 3), () => 5)).toEqual([
    "[runtime journal] receipt sweep cycle removed 5 stale producer receipts",
    "[runtime journal] receipt sweep cycle removed 5 stale producer receipts",
    "[runtime journal] receipt sweep cycle removed 5 stale producer receipts",
  ]);
  expect(receiptSweepDebugEnabled({ LLV_RUNTIME_JOURNAL_DEBUG: "1" })).toBe(true);
  expect(receiptSweepDebugEnabled({})).toBe(false);
});

test("an idle stretch does not carry a stale window into the next deletion", () => {
  const reporter = new ReceiptSweepReporter();
  const idle = TICKS_PER_WINDOW * 4;
  const lines = sweep(
    reporter,
    ticks(1, idle + TICKS_PER_WINDOW + 1),
    (tick) => tick > idle ? 3 : 0,
  );

  expect(lines).toEqual([
    `[runtime journal] receipt sweep removed ${3 * TICKS_PER_WINDOW} stale producer receipts across ${TICKS_PER_WINDOW} cycles in the last 15m`,
  ]);
});
