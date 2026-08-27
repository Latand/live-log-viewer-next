import { expect, test } from "bun:test";

import {
  acquireRuntimeHostFence,
  RUNTIME_HOST_FENCE_PARK_ENV,
  RUNTIME_HOST_FENCE_WAIT_ENV,
  runtimeHostFenceWaitPlan,
} from "./fenceWait";

function heldFence(releaseAfterAttempts: number): { acquire(): void; attempts(): number } {
  let attempts = 0;
  return {
    acquire() {
      attempts += 1;
      if (attempts <= releaseAfterAttempts) throw new Error("runtime host singleton fence is held");
    },
    attempts: () => attempts,
  };
}

test("issue 518: a staged successor waits out its bounded budget for the predecessor's exit", async () => {
  const plan = runtimeHostFenceWaitPlan({ [RUNTIME_HOST_FENCE_WAIT_ENV]: "600000" });
  const fence = heldFence(4);
  let elapsedMs = 0;

  expect(plan).toEqual({ parked: false, budgetMs: 600_000 });
  const acquired = await acquireRuntimeHostFence({
    acquire: () => fence.acquire(),
    plan,
    container: "llv-runtime-host-abcdef012345-0123456789ab",
    now: () => elapsedMs,
    sleep: async (milliseconds) => { elapsedMs += milliseconds; },
    pollMs: 500,
  });

  expect(acquired).toEqual({ waitedMs: 2_000 });
  expect(fence.attempts()).toBe(5);
});

test("issue 518: a bounded wait that expires names the generation and the budget it spent", async () => {
  const plan = runtimeHostFenceWaitPlan({ [RUNTIME_HOST_FENCE_WAIT_ENV]: "600000" });
  let elapsedMs = 0;

  await expect(acquireRuntimeHostFence({
    acquire: () => { throw new Error("runtime host singleton fence is held"); },
    plan,
    container: "llv-runtime-host-abcdef012345-0123456789ab",
    now: () => elapsedMs,
    sleep: async (milliseconds) => { elapsedMs += milliseconds; },
    pollMs: 60_000,
  })).rejects.toThrow(
    "runtime-host successor llv-runtime-host-abcdef012345-0123456789ab never acquired the singleton fence"
    + "; waited 600s of 600s"
    + "; the predecessor generation still holds it",
  );
});

test("an ordinary boot carries no budget and still fails on the fence's own error", async () => {
  const plan = runtimeHostFenceWaitPlan({});

  expect(plan).toEqual({ parked: false, budgetMs: 0 });
  await expect(acquireRuntimeHostFence({
    acquire: () => { throw new Error("runtime host singleton fence is held"); },
    plan,
    sleep: async () => { throw new Error("an ordinary boot must not wait"); },
  })).rejects.toThrow("runtime host singleton fence is held");
});

/* The reopened #1216 defect, one level down: `--stage` advertises an idle
   successor that the operator hands over whenever they are ready, and the #518
   budget turned that container into a ten-minute dockerd restart loop. A
   parked generation has no hand-over in flight for a deadline to detect. */
test("issue 1216: a parked successor never gives up on the fence and says why on a cadence", async () => {
  const plan = runtimeHostFenceWaitPlan({
    [RUNTIME_HOST_FENCE_PARK_ENV]: "1",
    [RUNTIME_HOST_FENCE_WAIT_ENV]: "600000",
  });
  const fence = heldFence(7_200);
  const reports: string[] = [];
  let elapsedMs = 0;

  /* The park outranks a bounded wait inherited from the same environment. */
  expect(plan).toEqual({ parked: true, budgetMs: 0 });
  const acquired = await acquireRuntimeHostFence({
    acquire: () => fence.acquire(),
    plan,
    container: "llv-runtime-host-abcdef012345-0123456789ab",
    now: () => elapsedMs,
    sleep: async (milliseconds) => { elapsedMs += milliseconds; },
    report: (line) => { reports.push(line); },
    pollMs: 500,
    reportEveryMs: 60_000,
  });

  /* An hour past the #518 budget, and the container is still the one the
     operator staged rather than the sixth restart of it. */
  expect(acquired).toEqual({ waitedMs: 3_600_000 });
  expect(reports[0]).toBe(
    "[runtime host] runtime-host successor llv-runtime-host-abcdef012345-0123456789ab"
    + " is parked on the singleton fence with no deadline"
    + "; waited 0s"
    + "; the predecessor still serves and has not been asked to exit"
    + "; run scripts/bootstrap-runtime-host.ts --hand-over to release it",
  );
  expect(reports).toHaveLength(60);
  expect(reports[59]).toContain("; waited 3540s;");
});

test("issue 1216: a bounded wait reports what it is waiting for and how long it has waited", async () => {
  const plan = runtimeHostFenceWaitPlan({ [RUNTIME_HOST_FENCE_WAIT_ENV]: "600000" });
  const fence = heldFence(2);
  const reports: string[] = [];
  let elapsedMs = 0;

  await acquireRuntimeHostFence({
    acquire: () => fence.acquire(),
    plan,
    container: "llv-runtime-host-abcdef012345-0123456789ab",
    now: () => elapsedMs,
    sleep: async (milliseconds) => { elapsedMs += milliseconds; },
    report: (line) => { reports.push(line); },
    pollMs: 60_000,
    reportEveryMs: 60_000,
  });

  expect(reports).toEqual([
    "[runtime host] runtime-host successor llv-runtime-host-abcdef012345-0123456789ab"
    + " is waiting for the singleton fence; waited 0s of 600s; the predecessor has not released it yet",
    "[runtime host] runtime-host successor llv-runtime-host-abcdef012345-0123456789ab"
    + " is waiting for the singleton fence; waited 60s of 600s; the predecessor has not released it yet",
  ]);
});

test("issue 1216: an unparsable fence budget is read as no budget rather than as an unbounded wait", () => {
  expect(runtimeHostFenceWaitPlan({ [RUNTIME_HOST_FENCE_WAIT_ENV]: "later" })).toEqual({ parked: false, budgetMs: 0 });
  expect(runtimeHostFenceWaitPlan({ [RUNTIME_HOST_FENCE_WAIT_ENV]: "-1" })).toEqual({ parked: false, budgetMs: 0 });
  expect(runtimeHostFenceWaitPlan({ [RUNTIME_HOST_FENCE_PARK_ENV]: "0" })).toEqual({ parked: false, budgetMs: 0 });
});
