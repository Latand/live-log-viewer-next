import { expect, test } from "bun:test";
import { performance } from "node:perf_hooks";

import { accountControllerDelayMs, scheduleAccountMigrationController } from "./instrumentation";

test("account controller delay defaults to immediate startup and retains the explicit escape hatch", () => {
  expect(accountControllerDelayMs({})).toBe(0);
  expect(accountControllerDelayMs({ LLV_ACCOUNT_CONTROLLER_DELAY_MS: "250" })).toBe(250);
  expect(accountControllerDelayMs({ LLV_ACCOUNT_CONTROLLER_DELAY_MS: "invalid" })).toBe(0);
});

test("cold boot enables the controller while readiness receives the first runtime turn", async () => {
  let controllerStarts = 0;
  const startedAt = performance.now();
  scheduleAccountMigrationController(async () => {
    controllerStarts += 1;
    const busyUntil = performance.now() + 150;
    while (performance.now() < busyUntil) {
      // Synthetic first reconciliation work begins after readiness gets a turn.
    }
  }, 0);
  const readinessAt = await new Promise<number>((resolve) => setTimeout(() => resolve(performance.now()), 0));
  expect(readinessAt - startedAt).toBeLessThan(100);

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(controllerStarts).toBe(1);
}, 5_000);
