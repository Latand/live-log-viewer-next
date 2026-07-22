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

test("a route bundle realm reaches the instrumentation migration controller exactly once", async () => {
  const legacyHost = globalThis as typeof globalThis & { __llvAccountMigrationSignal?: unknown };
  delete legacyHost.__llvAccountMigrationSignal;
  const instrumentation: typeof import("./controllerSignal") = await import(
    "./controllerSignal.ts?realm=instrumentation" as string
  );
  let calls = 0;
  const unregister = instrumentation.registerAccountMigrationTick(async () => { calls += 1; });
  try {
    delete legacyHost.__llvAccountMigrationSignal;
    const route: typeof import("./controllerSignal") = await import(
      "./controllerSignal.ts?realm=route" as string
    );
    route.requestAccountMigrationTick();
    route.requestAccountMigrationTick();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(1);
  } finally {
    unregister();
  }
});
