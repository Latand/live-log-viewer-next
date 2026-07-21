import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { tickFlows } from "@/lib/flows/engine";
import { listFilesWithProjectCatalog } from "@/lib/scanner";
import type { FileEntry } from "@/lib/types";

import { registerPipelineTick } from "./controllerSignal";
import { tickPipelines } from "./engine";

export type FlowPipelineControllerPhase = "pipelines" | "scan" | "flows" | "idle";
export type FlowPipelineControllerHeartbeatState =
  | "running"
  | "completed"
  | "timed-out"
  | "failed"
  | "blocked"
  | "idle";

export interface FlowPipelineControllerHeartbeat {
  schemaVersion: 1;
  controller: "flow-pipeline";
  cycle: number;
  pass: number;
  trigger: string;
  phase: FlowPipelineControllerPhase;
  state: FlowPipelineControllerHeartbeatState;
  phaseStartedAt: string;
  updatedAt: string;
  ageMs: number;
  deadlineMs: number;
}

interface TickResult {
  changed: boolean;
}

type TimeoutHandle = unknown;

export interface FlowPipelineControllerPorts {
  scan?: () => Promise<{ files: FileEntry[]; complete: boolean }>;
  tickPipelines: (entries: FileEntry[]) => Promise<TickResult>;
  tickFlows: (entries: FileEntry[]) => Promise<TickResult>;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimeout?: (timer: TimeoutHandle) => void;
  publishHeartbeat?: (heartbeat: FlowPipelineControllerHeartbeat) => void;
  log?: (message: string, error?: unknown) => void;
}

export interface FlowPipelineControllerOptions {
  phaseDeadlineMs?: number;
  maxPasses?: number;
}

interface ActivePhase<T = unknown> {
  startedAt: number;
  promise: Promise<T>;
}

type PhaseOutcome<T> =
  | { state: "completed"; value: T }
  | { state: "timed-out" | "blocked" }
  | { state: "failed"; error: unknown };

const DEFAULT_PHASE_DEADLINE_MS = 15_000;
const DEFAULT_MAX_PASSES = 8;
export const FLOW_PIPELINE_WATCHDOG_MS = 30_000;
const HEARTBEAT_FILE = "flow-pipeline-controller-heartbeat.json";

export function writeFlowPipelineControllerHeartbeat(
  heartbeat: FlowPipelineControllerHeartbeat,
  filename = statePath(HEARTBEAT_FILE),
): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(heartbeat, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function productionPorts(): FlowPipelineControllerPorts {
  return {
    scan: async () => listFilesWithProjectCatalog(undefined, { persist: true }),
    tickPipelines,
    tickFlows,
    publishHeartbeat: writeFlowPipelineControllerHeartbeat,
  };
}

export class FlowPipelineController {
  private running: Promise<void> | null = null;
  private trailingCycleRequested = false;
  private trailingTrigger = "signal";
  private cycle = 0;
  private readonly activePhases = new Map<Exclude<FlowPipelineControllerPhase, "idle">, ActivePhase>();
  private readonly ports: Required<FlowPipelineControllerPorts>;
  private readonly phaseDeadlineMs: number;
  private readonly maxPasses: number;

  constructor(ports: FlowPipelineControllerPorts, options: FlowPipelineControllerOptions = {}) {
    this.ports = {
      ...ports,
      scan: ports.scan ?? (async () => ({ files: [], complete: true })),
      now: ports.now ?? Date.now,
      scheduleTimeout: ports.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimeout: ports.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
      publishHeartbeat: ports.publishHeartbeat ?? (() => undefined),
      log: ports.log ?? ((message, error) => {
        if (error === undefined) console.error(message);
        else console.error(message, error);
      }),
    };
    this.phaseDeadlineMs = options.phaseDeadlineMs ?? DEFAULT_PHASE_DEADLINE_MS;
    this.maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  }

  tick(trigger = "signal"): Promise<void> {
    if (this.running) {
      this.trailingCycleRequested = true;
      this.trailingTrigger = trigger;
      return this.running;
    }
    this.running = this.runRequestedCycles(trigger).finally(() => {
      this.running = null;
      if (this.trailingCycleRequested) return this.tick(this.trailingTrigger);
    });
    return this.running;
  }

  poll(): Promise<void> {
    return this.running ?? this.tick("watchdog");
  }

  recover(): Promise<void> {
    return this.tick("startup");
  }

  private async runRequestedCycles(initialTrigger: string): Promise<void> {
    let trigger = initialTrigger;
    do {
      this.trailingCycleRequested = false;
      await this.runCycle(trigger);
      trigger = this.trailingTrigger;
    } while (this.trailingCycleRequested);
  }

  private async runCycle(trigger: string): Promise<void> {
    const cycle = ++this.cycle;
    let lastPass = 0;
    let entries: FileEntry[] = [];
    let scanComplete = false;
    for (let pass = 1; pass <= this.maxPasses; pass += 1) {
      lastPass = pass;
      const pipelineOutcome = await this.runPhase(
        "pipelines",
        cycle,
        pass,
        trigger,
        () => this.ports.tickPipelines(entries),
      );
      const scanOutcome = pass === 1
        ? await this.runPhase("scan", cycle, pass, trigger, this.ports.scan)
        : null;
      if (scanOutcome?.state === "failed") throw scanOutcome.error;
      if (scanOutcome?.state === "completed" && scanOutcome.value.complete) {
        entries = scanOutcome.value.files;
        scanComplete = true;
      }
      const flowOutcome = scanComplete
        ? await this.runPhase("flows", cycle, pass, trigger, () => this.ports.tickFlows(entries))
        : null;
      const failure = pipelineOutcome.state === "failed"
        ? pipelineOutcome.error
        : flowOutcome?.state === "failed" ? flowOutcome.error : null;
      if (failure !== null) throw failure;
      const changed = (pipelineOutcome.state === "completed" && pipelineOutcome.value.changed)
        || (flowOutcome?.state === "completed" && flowOutcome.value.changed);
      if (!changed) break;
    }
    const blocked = [...this.activePhases.entries()]
      .sort((left, right) => left[1].startedAt - right[1].startedAt)[0];
    if (blocked) {
      this.publish({
        cycle,
        pass: lastPass,
        trigger,
        phase: blocked[0],
        state: "blocked",
        startedAt: blocked[1].startedAt,
      });
    } else {
      this.publish({
        cycle,
        pass: lastPass,
        trigger,
        phase: "idle",
        state: "idle",
        startedAt: this.ports.now(),
      });
    }
  }

  private async runPhase<T>(
    phase: Exclude<FlowPipelineControllerPhase, "idle">,
    cycle: number,
    pass: number,
    trigger: string,
    work: () => Promise<T>,
  ): Promise<PhaseOutcome<T>> {
    const active = this.activePhases.get(phase);
    if (active) {
      this.publish({ cycle, pass, trigger, phase, state: "blocked", startedAt: active.startedAt });
      return { state: "blocked" };
    }

    const startedAt = this.ports.now();
    this.publish({ cycle, pass, trigger, phase, state: "running", startedAt });
    const promise = Promise.resolve().then(work);
    const lease: ActivePhase<T> = { startedAt, promise };
    this.activePhases.set(phase, lease);
    void promise.then(
      () => { if (this.activePhases.get(phase) === lease) this.activePhases.delete(phase); },
      () => { if (this.activePhases.get(phase) === lease) this.activePhases.delete(phase); },
    );

    let releaseDeadline = () => {};
    const deadline = new Promise<{ state: "timed-out" }>((resolve) => { releaseDeadline = () => resolve({ state: "timed-out" }); });
    const timer = this.ports.scheduleTimeout(releaseDeadline, this.phaseDeadlineMs);
    const outcome = await Promise.race<PhaseOutcome<T>>([
      promise.then(
        (value) => ({ state: "completed", value }),
        (error) => ({ state: "failed", error }),
      ),
      deadline,
    ]);
    this.ports.clearTimeout(timer);
    this.publish({ cycle, pass, trigger, phase, state: outcome.state, startedAt });
    if (outcome.state === "failed") {
      this.ports.log(`[flow pipeline controller] ${phase} phase failed`, outcome.error);
    } else if (outcome.state === "timed-out") {
      this.ports.log(`[flow pipeline controller] ${phase} phase exceeded its deadline`);
    }
    return outcome;
  }

  private publish(input: {
    cycle: number;
    pass: number;
    trigger: string;
    phase: FlowPipelineControllerPhase;
    state: FlowPipelineControllerHeartbeatState;
    startedAt: number;
  }): void {
    const updatedAt = this.ports.now();
    try {
      this.ports.publishHeartbeat({
        schemaVersion: 1,
        controller: "flow-pipeline",
        cycle: input.cycle,
        pass: input.pass,
        trigger: input.trigger,
        phase: input.phase,
        state: input.state,
        phaseStartedAt: new Date(input.startedAt).toISOString(),
        updatedAt: new Date(updatedAt).toISOString(),
        ageMs: Math.max(0, updatedAt - input.startedAt),
        deadlineMs: this.phaseDeadlineMs,
      });
    } catch (error) {
      this.ports.log("[flow pipeline controller] durable heartbeat publication failed", error);
    }
  }
}

interface FlowPipelineWatchdogHandle {
  unref?(): unknown;
}

interface FlowPipelineControllerRuntimePorts {
  registerTick: (tick: () => Promise<void>) => () => void;
  scheduleInterval: (callback: () => void, delayMs: number) => FlowPipelineWatchdogHandle;
  log: (message: string, error: unknown) => void;
}

interface FlowPipelineControllerRuntimeState {
  __llvFlowPipelineWatchdog?: FlowPipelineWatchdogHandle;
  __llvFlowPipelineUnregister?: () => void;
}

export function startFlowPipelineControllerRuntime(
  controller: FlowPipelineController,
  state: FlowPipelineControllerRuntimeState,
  ports: FlowPipelineControllerRuntimePorts,
): void {
  state.__llvFlowPipelineUnregister?.();
  state.__llvFlowPipelineUnregister = ports.registerTick(() => controller.tick("signal"));
  if (!state.__llvFlowPipelineWatchdog) {
    state.__llvFlowPipelineWatchdog = ports.scheduleInterval(() => void controller.poll().catch((error) => {
      ports.log("[flow pipeline controller] watchdog reconciliation failed", error);
    }), FLOW_PIPELINE_WATCHDOG_MS);
    state.__llvFlowPipelineWatchdog.unref?.();
  }
  void controller.recover().catch((error) => {
    ports.log("[flow pipeline controller] startup reconciliation failed", error);
  });
}

const controllerHost = globalThis as typeof globalThis & {
  __llvFlowPipelineController?: FlowPipelineController;
  __llvFlowPipelineWatchdog?: ReturnType<typeof setInterval>;
  __llvFlowPipelineUnregister?: () => void;
};

export function flowPipelineController(): FlowPipelineController {
  return controllerHost.__llvFlowPipelineController ??= new FlowPipelineController(productionPorts());
}

export function startFlowPipelineController(): void {
  startFlowPipelineControllerRuntime(
    flowPipelineController(),
    controllerHost,
    {
      registerTick: registerPipelineTick,
      scheduleInterval: (callback, delayMs) => setInterval(callback, delayMs),
      log: (message, error) => console.error(message, error),
    },
  );
}
