import { afterEach, expect, test } from "bun:test";

import { registerFlowTick, requestFlowTick } from "./controllerSignal";

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
});

test("route-triggered flow ticks coalesce duplicate ids", async () => {
  const calls: string[] = [];
  unregister = registerFlowTick(async (id) => {
    calls.push(id);
  });

  requestFlowTick("flow-a");
  requestFlowTick("flow-a");
  requestFlowTick("flow-b");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toEqual(["flow-a", "flow-b"]);
});
