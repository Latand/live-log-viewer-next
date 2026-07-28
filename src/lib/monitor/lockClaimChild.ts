/**
 * One contender for the monitor's single-flight lock, as its own process.
 *
 * Used by `journalStore.test.ts`: in-process claims prove nothing about
 * atomicity, because a read-then-write race needs two schedulers. Each child
 * prints one JSON line saying whether it won.
 *
 *   bun src/lib/monitor/lockClaimChild.ts <lockPath> <startAtEpochMs>
 */

import { claimMonitorRun } from "./journalStore";

const [lockPath, startAt] = process.argv.slice(2);
if (!lockPath) {
  console.error("lock path is required");
  process.exit(2);
}

/* Spin to a shared start instant so the contenders actually collide instead of
   arriving one after another. */
const target = Number(startAt);
if (Number.isFinite(target)) {
  while (Date.now() < target) {
    // busy-wait: the window being contended is sub-millisecond
  }
}

try {
  const claim = claimMonitorRun({ lockPath });
  console.log(JSON.stringify({ pid: process.pid, claimed: claim.claimed }));
  /* A winner that exits immediately is no test: the next contender would find
     a lock owned by a dead pid and legitimately reclaim it. Hold it for longer
     than the others take to arrive, so the contention is real. */
  if (claim.claimed) await Bun.sleep(1_500);
} catch (error) {
  console.log(JSON.stringify({ pid: process.pid, claimed: false, error: error instanceof Error ? error.message : "failed" }));
}
