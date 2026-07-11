import { expect, test } from "bun:test";

import { registerAccountMigrationTick, requestAccountMigrationTick } from "./controllerSignal";

test("migration controller signals coalesce concurrent requests", async () => {
  let calls = 0;
  const unregister = registerAccountMigrationTick(async () => { calls += 1; });

  requestAccountMigrationTick();
  requestAccountMigrationTick();
  await Promise.resolve();
  await Promise.resolve();

  expect(calls).toBe(1);
  unregister();
});
