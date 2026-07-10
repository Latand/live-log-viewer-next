import { expect, test } from "bun:test";

import { consumeRuntimeEvent } from "./consumers";
import { axesForEvent, type RuntimeEvent, type RuntimeSessionAxes } from "./contracts";

test("a hosted turn advances a flow without scanner polling", async () => {
  const calls: string[] = [];
  const ports = {
    flowReady: (id: string, note: string | null) => { calls.push(`${id}:${note}`); },
    workflowStageCompleted: () => { throw new Error("unexpected workflow call"); },
    taskDeliveryAcknowledged: () => { throw new Error("unexpected task call"); },
  };
  const event: RuntimeEvent = {
    seq: 4, revision: 3, scope: "session:implementer", kind: "turn.completed", payload: { flowId: "flow-1", readyNote: "REVIEW_READY: done" }, createdAt: 1, prevHash: "a", hash: "b",
  };
  await consumeRuntimeEvent(event, ports);
  expect(calls).toEqual(["flow-1:REVIEW_READY: done"]);
});

test("issue 51 axes keep an active turn running through prose and item completion", () => {
  const initial: RuntimeSessionAxes = { host: "running", turn: "running", attention: "none", freshness: "fresh" };
  const prose = axesForEvent(initial, { kind: "item.completed", payload: { text: "REVIEW_READY: still running tools" } });
  const tool = axesForEvent(prose, { kind: "item.completed", payload: { itemType: "commandExecution" } });
  const terminal = axesForEvent(tool, { kind: "turn.completed", payload: {} });
  expect(prose.turn).toBe("running");
  expect(tool.turn).toBe("running");
  expect(terminal.turn).toBe("completed");
});
