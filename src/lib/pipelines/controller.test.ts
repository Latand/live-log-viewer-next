import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { AccountMigrationController } from "@/lib/accounts/migration/controller";

import {
  FLOW_PIPELINE_WATCHDOG_MS,
  FlowPipelineController,
  startFlowPipelineControllerRuntime,
  type FlowPipelineControllerHeartbeat,
  type FlowPipelineControllerPorts,
  writeFlowPipelineControllerHeartbeat,
} from "./controller";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-pipeline-controller-"));

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function accountControllerWedgedInRuntime(): Promise<void> {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`));
  let markRuntimeStarted = () => {};
  const runtimeStarted = new Promise<void>((resolve) => { markRuntimeStarted = resolve; });
  const wedged = new Promise<void>(() => {});
  const controller = new AccountMigrationController(
    registry,
    { tick: async () => undefined },
    null,
    {
      scan: async () => ({ files: [], projectCatalog: [], complete: true }),
      reconcileInventory: async () => registry.snapshot(),
      reconcileFlowOwnership: async () => undefined,
      reconcileWorkflowOwnership: async () => undefined,
      reconcileHandoffOwnership: async () => undefined,
      reconcileFiles: async () => undefined,
      reconcileRuntime: async () => {
        markRuntimeStarted();
        await wedged;
      },
      reconcileTaskStore: async () => undefined,
      syncRouting: async () => undefined,
      reconcileMigrationCycle: async () => undefined,
    },
  );
  void controller.tick();
  return runtimeStarted;
}

test("a terminal event advances once and launches one reviewer while the account runtime phase is wedged", async () => {
  await accountControllerWedgedInRuntime();
  let state: "terminal" | "review-pending" | "review-spawning" | "reviewing" = "terminal";
  let passTransitions = 0;
  let reviewerLaunches = 0;
  const controller = new FlowPipelineController({
    tickPipelines: async () => {
      if (state === "terminal") {
        state = "review-pending";
        passTransitions += 1;
        return { changed: true };
      }
      if (state === "review-pending") {
        state = "review-spawning";
        return { changed: true };
      }
      return { changed: false };
    },
    tickFlows: async () => {
      if (state === "review-spawning") {
        state = "reviewing";
        reviewerLaunches += 1;
        return { changed: true };
      }
      return { changed: false };
    },
  });

  await Promise.all([
    controller.tick("terminal-event"),
    controller.tick("terminal-event"),
    controller.tick("terminal-event"),
  ]);

  expect(state as string).toBe("reviewing");
  expect(passTransitions).toBe(1);
  expect(reviewerLaunches).toBe(1);
});

test("a phase deadline releases the controller and later watchdog ticks keep pipelines moving", async () => {
  type ManualTimer = { active: boolean; callback: () => void };
  const timers: ManualTimer[] = [];
  const heartbeats: FlowPipelineControllerHeartbeat[] = [];
  const heartbeatFile = path.join(sandbox, "wedged-heartbeat.json");
  let now = 1_000;
  let flowCalls = 0;
  let pipelineCalls = 0;
  let markFlowStarted = () => {};
  const flowStarted = new Promise<void>((resolve) => { markFlowStarted = resolve; });
  const wedged = new Promise<never>(() => {});
  const ports: FlowPipelineControllerPorts = {
    tickPipelines: async () => {
      pipelineCalls += 1;
      return { changed: false };
    },
    tickFlows: async () => {
      flowCalls += 1;
      markFlowStarted();
      return wedged;
    },
    now: () => now,
    scheduleTimeout: (callback) => {
      const timer = { active: true, callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { (timer as ManualTimer).active = false; },
    publishHeartbeat: (heartbeat) => {
      heartbeats.push(heartbeat);
      writeFlowPipelineControllerHeartbeat(heartbeat, heartbeatFile);
    },
  };
  const controller = new FlowPipelineController(ports, { phaseDeadlineMs: 500 });

  const first = controller.tick("terminal-event");
  await flowStarted;
  now = 1_500;
  timers.find((timer) => timer.active)!.callback();
  await first;

  expect(flowCalls).toBe(1);
  expect(pipelineCalls).toBe(2);
  expect(heartbeats).toContainEqual(expect.objectContaining({
    phase: "flows",
    state: "timed-out",
    ageMs: 500,
    deadlineMs: 500,
  }));
  expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8"))).toMatchObject({
    phase: "flows",
    state: "blocked",
    ageMs: 500,
    deadlineMs: 500,
  });

  await controller.poll();
  expect(flowCalls).toBe(1);
  expect(pipelineCalls).toBe(4);
  expect(heartbeats).toContainEqual(expect.objectContaining({
    phase: "flows",
    state: "blocked",
    ageMs: 500,
  }));
});

test("a blocked flow phase still lets the completed scan feed pipeline settlement (#529)", async () => {
  type ManualTimer = { active: boolean; callback: () => void };
  const timers: ManualTimer[] = [];
  const entry = { path: "/sessions/completed-builder.jsonl" } as never;
  const pipelineEntries: unknown[][] = [];
  let scans = 0;
  let markFlowStarted = () => {};
  const flowStarted = new Promise<void>((resolve) => { markFlowStarted = resolve; });
  const wedged = new Promise<never>(() => {});
  const controller = new FlowPipelineController({
    scan: async () => {
      scans += 1;
      return { files: [entry], complete: true };
    },
    tickPipelines: async (entries) => {
      pipelineEntries.push(entries);
      return { changed: false };
    },
    tickFlows: async () => {
      markFlowStarted();
      return wedged;
    },
    scheduleTimeout: (callback) => {
      const timer = { active: true, callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { (timer as ManualTimer).active = false; },
  }, { phaseDeadlineMs: 500 });

  const tick = controller.tick("durable-pass-verdict");
  await flowStarted;
  timers.find((timer) => timer.active)!.callback();
  await tick;

  expect(scans).toBe(1);
  expect(pipelineEntries).toEqual([[], [entry]]);
});

test("startup recovery and the watchdog converge a pending transition without duplicate effects", async () => {
  let pending = true;
  let transitions = 0;
  const controller = new FlowPipelineController({
    tickPipelines: async () => {
      if (!pending) return { changed: false };
      pending = false;
      transitions += 1;
      return { changed: true };
    },
    tickFlows: async () => ({ changed: false }),
  });

  await controller.recover();
  await controller.poll();
  await controller.poll();

  expect(transitions).toBe(1);
});

test("a wake during controller settlement runs one additional cycle without duplicate transition effects", async () => {
  const idleCycles: number[] = [];
  let transitionPending = false;
  let transitionEffects = 0;
  let settlementWake: Promise<void> | null = null;
  const controller = new FlowPipelineController({
    tickPipelines: async () => {
      if (!transitionPending) return { changed: false };
      transitionPending = false;
      transitionEffects += 1;
      return { changed: true };
    },
    tickFlows: async () => ({ changed: false }),
    publishHeartbeat: (heartbeat) => {
      if (heartbeat.phase !== "idle") return;
      idleCycles.push(heartbeat.cycle);
      if (heartbeat.cycle !== 1) return;
      queueMicrotask(() => {
        queueMicrotask(() => {
          transitionPending = true;
          settlementWake = controller.tick("settlement-wake");
        });
      });
    },
  });

  await controller.tick("initial");
  if (settlementWake === null) throw new Error("settlement wake was not scheduled");
  await settlementWake;

  expect(idleCycles).toEqual([1, 2]);
  expect(transitionEffects).toBe(1);
});

test("controller runtime registers startup recovery and one deterministic watchdog", async () => {
  const calls: string[] = [];
  const signals: Array<() => Promise<void>> = [];
  const watchdogs: Array<{ callback: () => void; delayMs: number; unrefCalls: number }> = [];
  let unregisterCalls = 0;
  const controller = {
    tick: async (trigger: string) => { calls.push(trigger); },
    recover: async () => { calls.push("startup"); },
    poll: async () => { calls.push("watchdog"); },
  } as unknown as FlowPipelineController;
  const state = {};
  const start = () => startFlowPipelineControllerRuntime(controller, state, {
    registerTick: (tick) => {
      signals.push(tick);
      return () => { unregisterCalls += 1; };
    },
    scheduleInterval: (callback, delayMs) => {
      const watchdog = {
        callback,
        delayMs,
        unrefCalls: 0,
        unref() { this.unrefCalls += 1; },
      };
      watchdogs.push(watchdog);
      return watchdog;
    },
    log: () => undefined,
  });

  start();
  await Promise.resolve();
  expect(calls).toEqual(["startup"]);
  expect(watchdogs).toHaveLength(1);
  expect(watchdogs[0]).toMatchObject({ delayMs: FLOW_PIPELINE_WATCHDOG_MS, unrefCalls: 1 });

  watchdogs[0]!.callback();
  await Promise.resolve();
  await signals[0]!();
  expect(calls).toEqual(["startup", "watchdog", "signal"]);

  start();
  await Promise.resolve();
  expect(unregisterCalls).toBe(1);
  expect(signals).toHaveLength(2);
  expect(watchdogs).toHaveLength(1);
  expect(calls).toEqual(["startup", "watchdog", "signal", "startup"]);
});

test("pipeline settlement leads the cycle and one scanner snapshot feeds every flow pass", async () => {
  const entry = { path: "/sessions/reviewer.jsonl" };
  const calls: string[] = [];
  let pipelineChanged = true;
  const ports = {
    scan: async () => {
      calls.push("scan");
      return { files: [entry], complete: true };
    },
    tickPipelines: async (...args: unknown[]) => {
      const files = args[0] as unknown[] | undefined;
      calls.push(`pipelines:${files?.length ?? 0}`);
      const changed = pipelineChanged;
      pipelineChanged = false;
      return { changed };
    },
    tickFlows: async (...args: unknown[]) => {
      const files = args[0] as unknown[] | undefined;
      calls.push(`flows:${files?.length ?? 0}`);
      expect(files).toEqual([entry]);
      return { changed: false };
    },
  } as unknown as FlowPipelineControllerPorts;

  await new FlowPipelineController(ports).tick("terminal-event");

  expect(calls).toEqual([
    "pipelines:0",
    "scan",
    "flows:1",
    "pipelines:1",
    "flows:1",
  ]);
});
