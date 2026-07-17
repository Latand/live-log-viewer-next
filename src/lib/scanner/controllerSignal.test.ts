import { expect, test } from "bun:test";

import { registerFileControllerTick, requestFileControllerTick } from "./controllerSignal";

test("file controller signals coalesce concurrent requests", async () => {
  let calls = 0;
  const unregister = registerFileControllerTick(async () => { calls += 1; });

  requestFileControllerTick();
  requestFileControllerTick();
  await Promise.resolve();
  await Promise.resolve();

  expect(calls).toBe(1);
  unregister();
});
