import { expect, test } from "bun:test";

import { registerPipelineTick, requestPipelineTick } from "./controllerSignal";

test("pipeline controller signals coalesce concurrent requests", async () => {
  let calls = 0;
  const unregister = registerPipelineTick(async () => { calls += 1; });

  requestPipelineTick();
  requestPipelineTick();
  await Promise.resolve();
  await Promise.resolve();

  expect(calls).toBe(1);
  unregister();
});
