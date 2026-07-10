import { expect, test } from "bun:test";

import { consumeRuntimeEvent } from "./consumers";
import { axesForEvent, runtimeScope, type RuntimeEvent, type RuntimeSessionAxes } from "./contracts";

test("a hosted turn advances a flow without scanner polling", async () => {
  const calls: string[] = [];
  const ports = {
    flowReady: (id: string, note: string | null) => { calls.push(`${id}:${note}`); },
    workflowStageCompleted: () => { throw new Error("unexpected workflow call"); },
    taskDeliveryAcknowledged: () => { throw new Error("unexpected task call"); },
  };
  const event: RuntimeEvent = {
    schemaVersion: 1,
    seq: 4,
    eventId: "evt-4",
    revision: 3,
    scope: runtimeScope("session", "implementer"),
    kind: "turn-ended",
    payload: { flowId: "flow-1", readyNote: "REVIEW_READY: done" },
    occurredAt: "2026-07-10T00:00:00.000Z",
    recordedAt: "2026-07-10T00:00:00.000Z",
    producer: { kind: "test" },
    causationId: null,
    correlationId: null,
  };
  await consumeRuntimeEvent(event, ports);
  expect(calls).toEqual(["flow-1:REVIEW_READY: done"]);
});

test("issue 51 axes keep an active turn running through prose and item completion", () => {
  const initial: RuntimeSessionAxes = { host: "hosted", turn: "running", attention: "none", freshness: "structured" };
  const prose = axesForEvent(initial, { kind: "item.completed", payload: { text: "REVIEW_READY: still running tools" } });
  const tool = axesForEvent(prose, { kind: "item.completed", payload: { itemType: "commandExecution" } });
  const terminal = axesForEvent(tool, { kind: "turn.completed", payload: {} });
  const disconnected = axesForEvent(tool, { kind: "host.disconnected", payload: {} });
  expect(prose.turn).toBe("running");
  expect(tool.turn).toBe("running");
  expect(terminal.turn).toBe("idle");
  expect(disconnected).toMatchObject({ host: "recovering", turn: "unknown", freshness: "replayed" });
});
