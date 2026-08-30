import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Database } from "bun:sqlite";

import {
  accountControllerDelayMs,
  activateViewerRuntimeWhenCurrent,
  completeViewerRuntimeActivation,
  completeViewerReleaseDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
  initializeOperatorSpawnCapabilityAtStartup,
  runIdentityWaveMigrationWithoutBlockingStartup,
  runStructuredHostStartup,
  scheduleAccountMigrationController,
  startCurrentReleaseControllers,
  startWakatimeIntegrationIfEnabled,
  viewerReleaseOwnsTraffic,
} from "@/lib/viewerInstrumentation";
import { HOT_STATE_BACKEND, readHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { operatorSpawnCapabilityPath } from "@/lib/agent/operatorCapability";
import {
  FLOW_PIPELINE_WATCHDOG_MS,
  FlowPipelineController,
  startFlowPipelineControllerRuntime,
} from "@/lib/pipelines/controller";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
import { didStructuredHostStartupFail, markStructuredHostStartupReady } from "@/lib/runtime/startupStatus";
import {
  discardWakatimeEnvironmentCredential,
  WAKATIME_CREDENTIAL_ENV,
  withoutWakatimeCredential,
} from "@/lib/wakatime/credential";
import { registerNodeViewerRuntime } from "./instrumentation";

test("account controller delay defaults to immediate startup and retains the explicit escape hatch", () => {
  expect(accountControllerDelayMs({})).toBe(0);
  expect(accountControllerDelayMs({ LLV_ACCOUNT_CONTROLLER_DELAY_MS: "250" })).toBe(250);
  expect(accountControllerDelayMs({ LLV_ACCOUNT_CONTROLLER_DELAY_MS: "invalid" })).toBe(0);
});

test("WakaTime startup remains disabled unless the server opt-in is exact", async () => {
  let starts = 0;
  const start = async () => { starts += 1; };

  await startWakatimeIntegrationIfEnabled({}, start);
  await startWakatimeIntegrationIfEnabled({ LLV_WAKATIME_ENABLED: "true" }, start);
  expect(starts).toBe(0);

  await startWakatimeIntegrationIfEnabled({ LLV_WAKATIME_ENABLED: "1" }, start);
  expect(starts).toBe(1);
});

test("WakaTime startup failure stays local and secret-safe", async () => {
  const logs: unknown[][] = [];
  await startWakatimeIntegrationIfEnabled(
    { LLV_WAKATIME_ENABLED: "1" },
    async () => { throw new Error("credential-shaped internal detail"); },
    (...args) => { logs.push(args); },
  );
  expect(logs).toEqual([["[wakatime] startup_failed", {}]]);
});

test("identity-wave evidence failure leaves later startup phases available", () => {
  const events: unknown[][] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let attempts = 0;
  runIdentityWaveMigrationWithoutBlockingStartup(
    () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary evidence read failure");
    },
    (...args) => { events.push(args); },
    {
      initialRetryMs: 25,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return { unref() {} };
      },
    },
  );
  events.push(["controllers-started"]);

  expect(events).toEqual([[
    "[identity-wave] registry migration failed; retry scheduled",
    { attempt: 1, retryInMs: 25, error: expect.any(Error) },
  ], ["controllers-started"]]);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.delayMs).toBe(25);

  scheduled[0]!.callback();
  expect(attempts).toBe(2);
  expect(scheduled).toHaveLength(1);
});

test("node bootstrap discards WakaTime credentials before runtime imports and explicitly isolated Bun children", async () => {
  const placeholder = ["bootstrap", "fixture", "value"].join("-");
  let snapshot: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  let childExit = -1;
  discardWakatimeEnvironmentCredential();
  process.env[WAKATIME_CREDENTIAL_ENV] = placeholder;

  try {
    await registerNodeViewerRuntime(async () => {
      snapshot = { ...process.env };
      const child = Bun.spawn([
        process.execPath,
        "-e",
        `process.exit(process.env[${JSON.stringify(WAKATIME_CREDENTIAL_ENV)}] ? 17 : 0)`,
      ], {
        env: withoutWakatimeCredential(process.env),
        stdout: "ignore",
        stderr: "ignore",
      });
      childExit = await child.exited;
      return { registerViewerRuntime: async () => undefined };
    });

    expect(snapshot[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
    expect(Object.values(snapshot).some((value) => value?.includes(placeholder))).toBe(false);
    expect(childExit).toBe(0);
  } finally {
    discardWakatimeEnvironmentCredential();
  }
});

test("deployment candidates stay passive until their endpoint owns the durable release target", () => {
  const target = JSON.stringify({ endpoint: "http://127.0.0.1:19892" });
  expect(viewerReleaseOwnsTraffic({ PORT: "19892" }, () => target)).toBe(true);
  expect(viewerReleaseOwnsTraffic({ PORT: "19115" }, () => target)).toBe(false);
});

test("exact-SHA release probe grants background ownership to one serving endpoint", () => {
  const target = JSON.stringify({
    sha: "fixture-sha",
    endpoint: "http://127.0.0.1:19892",
    previous: { sha: "fixture-previous", endpoint: "http://127.0.0.1:19115" },
  });
  const owners = ["19892", "19115", "18888"]
    .filter((port) => viewerReleaseOwnsTraffic({ PORT: port }, () => target));
  expect(owners).toEqual(["19892"]);
});

test("release ownership keeps local boot active and fails closed on an unreadable durable target", () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  expect(viewerReleaseOwnsTraffic({}, () => { throw missing; })).toBe(true);
  expect(viewerReleaseOwnsTraffic({ PORT: "8898" }, () => { throw missing; })).toBe(true);
  expect(viewerReleaseOwnsTraffic({ PORT: "19115" }, () => "{broken")).toBe(false);
  expect(viewerReleaseOwnsTraffic({ PORT: "19115" }, () => JSON.stringify({ endpoint: "invalid" }))).toBe(false);
});

test("passive candidate activates runtime startup exactly once after promotion", async () => {
  let current = false;
  let activations = 0;
  const scheduled: Array<() => void> = [];
  const schedule = (callback: () => void) => {
    scheduled.push(callback);
    return { unref() {} };
  };

  await activateViewerRuntimeWhenCurrent(
    async () => { activations += 1; },
    () => current,
    { pollMs: 1, schedule },
  );
  expect(activations).toBe(0);
  expect(scheduled).toHaveLength(1);

  scheduled.shift()!();
  await Promise.resolve();
  expect(activations).toBe(0);
  expect(scheduled).toHaveLength(1);

  current = true;
  scheduled.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(activations).toBe(1);
  expect(scheduled).toHaveLength(1);
});

test("a promoted release continuously relinquishes background ownership after demotion", async () => {
  let current = true;
  let activations = 0;
  let demotions = 0;
  const scheduled: Array<() => void> = [];
  await activateViewerRuntimeWhenCurrent(
    async () => { activations += 1; },
    () => current,
    {
      pollMs: 1,
      schedule: (callback) => { scheduled.push(callback); return { unref() {} }; },
      onDemoted: () => { demotions += 1; },
    },
  );
  expect(activations).toBe(1);
  expect(scheduled).toHaveLength(1);
  current = false;
  scheduled.shift()!();
  expect(demotions).toBe(1);
});

test("a rollback fence checkpoints before demotion and suppresses the later mirror overwrite", async () => {
  let current = true;
  let fenceChecks = 0;
  const demotions: boolean[] = [];
  const scheduled: Array<() => void> = [];
  const fence = {
    schemaVersion: 1 as const,
    epoch: 4,
    mode: "fencing" as const,
    releaseRevision: "a".repeat(40),
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
  await activateViewerRuntimeWhenCurrent(
    async () => undefined,
    () => current,
    {
      pollMs: 1,
      schedule: (callback) => { scheduled.push(callback); return { unref() {} }; },
      fenceRequest: () => fence,
      onFenceRequested: async () => { fenceChecks += 1; },
      onDemoted: (context) => { demotions.push(context.fenced); },
    },
  );
  scheduled.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(fenceChecks).toBe(1);
  current = false;
  scheduled.shift()!();
  expect(demotions).toEqual([true]);
});

test("a current release monitors rollback fences while activation is still pending", async () => {
  const scheduled: Array<() => void> = [];
  let rejectActivation!: (error: Error) => void;
  const activation = activateViewerRuntimeWhenCurrent(
    () => new Promise<void>((_resolve, reject) => { rejectActivation = reject; }),
    () => true,
    {
      pollMs: 1,
      schedule: (callback) => { scheduled.push(callback); return { unref() {} }; },
      fenceRequest: () => ({
        schemaVersion: 1,
        epoch: 7,
        mode: "fencing",
        releaseRevision: "7".repeat(40),
        updatedAt: "2026-08-06T00:00:00.000Z",
      }),
      onFenceRequested: () => { checkpoints += 1; },
    },
  );
  let checkpoints = 0;
  expect(scheduled).toHaveLength(1);
  scheduled.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(checkpoints).toBe(1);
  rejectActivation(new Error("injected activation failure"));
  await expect(activation).rejects.toThrow("injected activation failure");
});

test("runtime activation completes the identity wave before publishing hot-state readiness", async () => {
  const events: string[] = [];
  await completeViewerRuntimeActivation({
    initializeOperatorCapability: async () => { events.push("operator-capability"); },
    runIdentityMigration: () => { events.push("identity-wave"); },
    startWakatime: async () => { events.push("wakatime"); },
    publishHotStateActivation: () => { events.push("hot-state-ready"); },
    startStructuredHosts: () => { events.push("structured-hosts"); },
    startControllers: async () => { events.push("controllers"); },
    publishViewerReleaseReady: () => { events.push("release-ready"); },
  });

  expect(events).toEqual([
    "operator-capability",
    "identity-wave",
    "wakatime",
    "hot-state-ready",
    "structured-hosts",
    "controllers",
    "release-ready",
  ]);
});

test("hot-state activation beats a slow structured-host startup and the promote deadline", async () => {
  let finishStructuredStartup!: () => void;
  let publishActivation!: () => void;
  const structuredStartup = new Promise<void>((resolve) => { finishStructuredStartup = resolve; });
  const published = new Promise<void>((resolve) => { publishActivation = resolve; });
  const activation = completeViewerRuntimeActivation({
    initializeOperatorCapability: async () => undefined,
    startWakatime: async () => undefined,
    startStructuredHosts: () => structuredStartup,
    startControllers: async () => undefined,
    publishHotStateActivation: publishActivation,
    publishViewerReleaseReady: () => undefined,
  });

  const outcome = await Promise.race([
    published.then(() => "activated"),
    Bun.sleep(25).then(() => "deployment adapter promote timed out while waiting for hot-state activation"),
  ]);
  finishStructuredStartup();
  await activation;

  expect(outcome).toBe("activated");
});

test("promoted serving readiness beats a legitimately slow structured-host adoption window", async () => {
  let finishStructuredStartup!: () => void;
  let publishReleaseReady!: () => void;
  let structuredStartupFinished = false;
  const structuredStartup = new Promise<void>((resolve) => {
    finishStructuredStartup = () => {
      structuredStartupFinished = true;
      resolve();
    };
  });
  const releaseReady = new Promise<void>((resolve) => { publishReleaseReady = resolve; });
  const activation = completeViewerRuntimeActivation({
    initializeOperatorCapability: async () => undefined,
    startWakatime: async () => undefined,
    startStructuredHosts: () => structuredStartup,
    startControllers: async () => undefined,
    publishHotStateActivation: () => undefined,
    publishViewerReleaseReady: publishReleaseReady,
  });

  const outcome = await Promise.race([
    releaseReady.then(() => "release-ready"),
    Bun.sleep(25).then(() => "verify-promoted-timeout"),
  ]);
  expect({ outcome, structuredStartupFinished }).toEqual({
    outcome: "release-ready",
    structuredStartupFinished: false,
  });

  finishStructuredStartup();
  await activation;
});

test("cutover import faults roll back all four collection markers and retry cleanly", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  try {
    for (let failAfter = 1; failAfter <= 4; failAfter += 1) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-hot-state-atomic-cutover-${failAfter}-`));
      const revision = String(failAfter).repeat(40);
      process.env.LLV_STATE_DIR = sandbox;
      process.env.PORT = "19007";
      try {
        fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ schemaVersion: 3, flows: [] }));
        fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
        fs.writeFileSync(path.join(sandbox, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
        fs.writeFileSync(path.join(sandbox, "workflows.json"), JSON.stringify({ workflows: [] }));
        fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
          endpoint: "http://127.0.0.1:19007",
          revision,
          hotStateBackend: HOT_STATE_BACKEND,
        }));
        const boundary = await establishHotStateCutoverBoundary(() => true, {
          pollMs: 0,
          stablePolls: 1,
          maxPolls: 2,
          schedule: (callback) => { callback(); return { unref() {} }; },
        });
        let imported = 0;
        await expect(initializeHotStateStoresAtStartup(boundary, {
          afterCollectionImport: () => {
            imported += 1;
            if (imported === failAfter) throw new Error(`injected import failure ${failAfter}`);
          },
        })).rejects.toThrow(`injected import failure ${failAfter}`);

        const database = new Database(path.join(sandbox, "state.sqlite"), { strict: true });
        expect(database.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM state_collections",
        ).get()!.count).toBe(0);
        database.close();
        expect(readHotStateAuthority(sandbox)).toMatchObject({ mode: "preparing", releaseRevision: revision });

        await initializeHotStateStoresAtStartup(boundary);
        const retried = new Database(path.join(sandbox, "state.sqlite"), { strict: true });
        expect(retried.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM state_collections",
        ).get()!.count).toBe(4);
        retried.close();
        expect(readHotStateAuthority(sandbox)).toMatchObject({ mode: "sqlite", releaseRevision: revision });
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});

test("release demotion reports checkpoint failure before exiting with failure status", async () => {
  const events: Array<[string, unknown?]> = [];
  await completeViewerReleaseDemotion(
    () => { throw new Error("injected fsync failure"); },
    (code) => { events.push(["exit", code]); },
    (...args) => { events.push([String(args[0]), args[1]]); },
  );

  expect(events[0]?.[0]).toBe("[viewer release] demotion cleanup failed");
  expect(events[0]?.[1]).toBeInstanceOf(Error);
  expect(events[1]).toEqual(["exit", 1]);
});

test("release demotion still checkpoints when structured host cleanup fails", async () => {
  const events: string[] = [];
  await completeViewerReleaseDemotion(
    () => { events.push("checkpoint"); },
    (code) => { events.push(`exit:${code}`); },
    () => { events.push("logged"); },
    async () => {
      events.push("release");
      throw new Error("injected structured host release failure");
    },
  );
  expect(events).toEqual(["release", "checkpoint", "logged", "exit:1"]);
});

test("release demotion exits successfully after its checkpoint", async () => {
  const exits: number[] = [];
  await completeViewerReleaseDemotion(
    () => undefined,
    (code) => { exits.push(code); },
    () => undefined,
  );
  expect(exits).toEqual([0]);
});

test("a restarted current release activates before register returns", async () => {
  let activations = 0;
  const scheduled: Array<() => void> = [];
  await activateViewerRuntimeWhenCurrent(
    async () => { activations += 1; },
    () => true,
    { schedule: (callback) => { scheduled.push(callback); return { unref() {} }; } },
  );
  expect(activations).toBe(1);
  expect(scheduled).toHaveLength(1);
});

test("current release starts flow and pipeline recovery and watchdog while account migration is disabled", async () => {
  const starts: string[] = [];
  const watchdogs: Array<{ callback: () => void; delayMs: number }> = [];
  const controller = {
    tick: async () => undefined,
    recover: async () => { starts.push("startup"); },
    poll: async () => { starts.push("watchdog"); },
  } as unknown as FlowPipelineController;
  const startFlowPipelineController = () => startFlowPipelineControllerRuntime(controller, {}, {
    registerTick: () => () => undefined,
    scheduleInterval: (callback, delayMs) => {
      const watchdog = { callback, delayMs, unref: () => undefined };
      watchdogs.push(watchdog);
      return watchdog;
    },
    log: () => undefined,
  });

  await startCurrentReleaseControllers(
    { LLV_ACCOUNT_CONTROLLER_DISABLED: "1" },
    {
      loadFlowPipelineController: async () => ({
        startFlowPipelineController,
      }),
      loadAccountMigrationController: async () => {
        starts.push("account-loaded");
        return { startAccountMigrationController: async () => { starts.push("account"); } };
      },
    },
  );
  await Promise.resolve();

  expect(starts).toEqual(["startup"]);
  expect(watchdogs).toHaveLength(1);
  expect(watchdogs[0]!.delayMs).toBe(FLOW_PIPELINE_WATCHDOG_MS);

  watchdogs[0]!.callback();
  await Promise.resolve();
  expect(starts).toEqual(["startup", "watchdog"]);
});

test("the Telegram report scheduler starts with the release that owns traffic", async () => {
  /* #1086: it used to start only when a browser polled /api/telegram, so a
     standalone Viewer nobody had open ran no report and caught up no missed
     slot. The controller lifecycle is what a cold start actually runs. */
  const started: string[] = [];
  await startCurrentReleaseControllers(
    { LLV_ACCOUNT_CONTROLLER_DISABLED: "1" },
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => { started.push("account"); } }),
      loadTelegramReportScheduler: async () => ({ ensureTelegramReportScheduler: () => { started.push("telegram-report"); } }),
    },
  );
  expect(started).toEqual(["pipelines", "telegram-report"]);
});

test("automatic host retirement starts with the release that owns traffic, not with the account controller", async () => {
  /* #747: ownership of a structured host and its live transports are
     process-scoped state of the process that bound the delivery queue, so the
     sweep can only run here. It used to hang off the account-migration
     reconciliation, which runs in a separate inventory sidecar process where
     every one of those reads answers nothing. Turning account migration off
     must not stop reclaiming hosts either — retirement has its own switch. */
  const started: string[] = [];
  await startCurrentReleaseControllers(
    { LLV_ACCOUNT_CONTROLLER_DISABLED: "1" },
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => { started.push("account"); } }),
      loadStructuredHostRetirement: async () => ({ startStructuredHostRetirement: () => { started.push("host-retirement"); } }),
    },
  );
  expect(started).toEqual(["pipelines", "host-retirement"]);
});

test("the seat tick starts with the release that owns traffic — one clock, one process", async () => {
  /* #1245: the thing that drove orchestrator sessions was a prompt an agent
     scheduled for itself, so it died with the session and every rotation
     dropped it silently. Starting the clock here is what makes "exactly one
     active ticker per seat" true without a cross-process lock: exactly one
     process owns traffic, and that process is the only one that starts it. */
  const started: string[] = [];
  await startCurrentReleaseControllers(
    { LLV_ACCOUNT_CONTROLLER_DISABLED: "1" },
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => { started.push("account"); } }),
      loadSeatTick: async () => ({ startSeatTick: () => { started.push("seat-tick"); return true; } }),
    },
  );
  expect(started).toEqual(["pipelines", "seat-tick"]);
});

test("a seat tick that cannot start does not take the other controllers down", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers(
    { LLV_ACCOUNT_CONTROLLER_DISABLED: "1" },
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => { started.push("account"); } }),
      loadStructuredHostRetirement: async () => ({ startStructuredHostRetirement: () => { started.push("host-retirement"); } }),
      loadSeatTick: async () => { throw new Error("seat state unavailable"); },
    },
  );
  expect(started).toEqual(["pipelines", "host-retirement"]);
});

test("a host retirement sweep that cannot start does not take the other controllers down", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers(
    {},
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => {
        started.push("account-loaded");
        return { startAccountMigrationController: async () => { started.push("account"); } };
      },
      loadStructuredHostRetirement: async () => { throw new Error("runtime state unavailable"); },
    },
  );
  /* The account controller is still reached: a sweep that cannot start is one
     feature down, not a release that never finished booting. */
  expect(started).toEqual(["pipelines", "account-loaded"]);
});

test("the release that owns traffic re-provisions the Telegram connector without holding startup", async () => {
  /* #1133: the connector dies with the viewer container it is a child of, and
     used to stay dead until a consumer tripped over it — which for the Daily
     Report was the run itself, failing the day's report. Startup must not WAIT
     for it either: verifying a connector takes tens of seconds and the release
     cannot hold its ready marker behind that. */
  const started: string[] = [];
  let provisioned = false;
  await startCurrentReleaseControllers(
    { LLV_ACCOUNT_CONTROLLER_DISABLED: "1" },
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => { started.push("account"); } }),
      loadTelegramReportScheduler: async () => ({ ensureTelegramReportScheduler: () => { started.push("telegram-report"); } }),
      loadTelegramConnectorBoot: async () => ({
        provisionTelegramConnectorAtStartup: async () => {
          started.push("telegram-connector");
          await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
          provisioned = true;
          return "provisioned" as const;
        },
      }),
    },
  );

  expect(started).toEqual(["pipelines", "telegram-connector", "telegram-report"]);
  /* Started, not awaited: the scheduler and the release went on ahead of it. */
  expect(provisioned).toBe(false);
});

test("a Telegram connector that cannot be provisioned does not take the other controllers down", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers(
    { LLV_ACCOUNT_CONTROLLER_DISABLED: "1" },
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => { started.push("account"); } }),
      loadTelegramReportScheduler: async () => ({ ensureTelegramReportScheduler: () => { started.push("telegram-report"); } }),
      loadTelegramConnectorBoot: async () => { throw new Error("telegram state unavailable"); },
    },
  );
  await Promise.resolve();

  expect(started).toEqual(["pipelines", "telegram-report"]);
});

test("a Telegram scheduler that cannot start does not take the other controllers down", async () => {
  const started: string[] = [];
  await startCurrentReleaseControllers(
    {},
    {
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { started.push("pipelines"); } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => { started.push("account"); } }),
      loadTelegramReportScheduler: async () => { throw new Error("telegram state unavailable"); },
    },
  );
  await Promise.resolve();
  expect(started).toContain("pipelines");
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

test("server startup mints the operator capability and rotates it on request", async () => {
  const previousStateDir = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-instrumentation-operator-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  try {
    await initializeOperatorSpawnCapabilityAtStartup({});
    const first = fs.readFileSync(operatorSpawnCapabilityPath(), "utf8");

    await initializeOperatorSpawnCapabilityAtStartup({});
    expect(fs.readFileSync(operatorSpawnCapabilityPath(), "utf8")).toBe(first);

    await initializeOperatorSpawnCapabilityAtStartup({ LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY: "1" });
    expect(fs.readFileSync(operatorSpawnCapabilityPath(), "utf8")).not.toBe(first);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("structured-host startup retries an arbitrary recoverable adoption error", async () => {
  const failure = new Error("container adoption failed");
  const logged: unknown[][] = [];
  const scheduled: Array<() => void> = [];
  let attempts = 0;

  try {
    await runStructuredHostStartup(
      async () => {
        attempts += 1;
        if (attempts === 1) throw failure;
      },
      (...args) => { logged.push(args); },
      {
        random: () => 0.5,
        schedule: (callback) => {
          scheduled.push(callback);
          return { unref() {} };
        },
      },
    );

    expect(logged).toEqual([["[structured hosts] startup adoption failed; retry scheduled", failure]]);
    expect(didStructuredHostStartupFail()).toBe(true);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()!();
    await Promise.resolve();
    await Promise.resolve();

    expect(attempts).toBe(2);
    expect(didStructuredHostStartupFail()).toBe(false);
    expect(logged).toEqual([
      ["[structured hosts] startup adoption failed; retry scheduled", failure],
      ["[structured hosts] startup adoption recovered", { attempts: 2 }],
    ]);
  } finally {
    markStructuredHostStartupReady();
  }
});

test("release activation can wait until structured-host adoption recovers", async () => {
  const scheduled: Array<() => void> = [];
  let attempts = 0;
  let settled = false;
  try {
    const startup = runStructuredHostStartup(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new RuntimeHostUnavailableError("runtime host is unavailable");
      },
      () => undefined,
      {
        waitUntilReady: true,
        random: () => 0.5,
        schedule: (callback) => { scheduled.push(callback); return { unref() {} }; },
      },
    ).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await startup;
    expect({ attempts, settled }).toEqual({ attempts: 2, settled: true });
  } finally {
    markStructuredHostStartupReady();
  }
});

test("structured-host startup self-heals after the runtime socket becomes ready", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const logged: unknown[][] = [];
  let attempts = 0;

  try {
    await runStructuredHostStartup(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new RuntimeHostUnavailableError("runtime host is unavailable");
      },
      (...args) => { logged.push(args); },
      {
        random: () => 0.5,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return { unref() {} };
        },
      },
    );

    expect(attempts).toBe(1);
    expect(didStructuredHostStartupFail()).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(100);

    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(attempts).toBe(2);
    expect(didStructuredHostStartupFail()).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(logged).toEqual([
      [
        "[structured hosts] startup adoption failed; retry scheduled",
        expect.any(RuntimeHostUnavailableError),
      ],
      ["[structured hosts] startup adoption recovered", { attempts: 2 }],
    ]);
  } finally {
    markStructuredHostStartupReady();
  }
});

test("structured-host startup uses bounded backoff with one pending retry", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const logged: unknown[][] = [];
  let attempts = 0;

  try {
    await runStructuredHostStartup(
      async () => {
        attempts += 1;
        if (attempts < 5) throw new RuntimeHostUnavailableError("runtime host is unavailable");
      },
      (...args) => { logged.push(args); },
      {
        initialRetryMs: 25,
        maxRetryMs: 50,
        random: () => 0.5,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return { unref() {} };
        },
      },
    );

    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([25]);
    for (const expectedDelay of [50, 50, 50]) {
      scheduled.shift()!.callback();
      await Promise.resolve();
      await Promise.resolve();
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.delayMs).toBe(expectedDelay);
    }

    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(attempts).toBe(5);
    expect(scheduled).toHaveLength(0);
    expect(didStructuredHostStartupFail()).toBe(false);
    expect(logged).toEqual([
      [
        "[structured hosts] startup adoption failed; retry scheduled",
        expect.any(RuntimeHostUnavailableError),
      ],
      ["[structured hosts] startup adoption recovered", { attempts: 5 }],
    ]);
  } finally {
    markStructuredHostStartupReady();
  }
});

test("structured-host startup applies bounded jitter to recoverable retries", async () => {
  const delays: number[] = [];

  try {
    await runStructuredHostStartup(
      async () => { throw new Error("transient registry contention"); },
      () => {},
      {
        initialRetryMs: 100,
        maxRetryMs: 1_000,
        jitterRatio: 0.2,
        random: () => 1,
        schedule: (_callback, delayMs) => {
          delays.push(delayMs);
          return { unref() {} };
        },
      },
    );

    expect(delays).toEqual([120]);
    expect(didStructuredHostStartupFail()).toBe(true);
  } finally {
    markStructuredHostStartupReady();
  }
});

test("unsupported structured runtime aborts server startup", async () => {
  const failure = new StructuredRuntimeRequirementError("structured hosts require Bun");
  const logged: unknown[][] = [];

  try {
    await expect(runStructuredHostStartup(
      async () => { throw failure; },
      (...args) => { logged.push(args); },
    )).rejects.toBe(failure);

    expect(logged).toEqual([["[structured hosts] startup adoption failed", failure]]);
    expect(didStructuredHostStartupFail()).toBe(true);
  } finally {
    markStructuredHostStartupReady();
  }
});

test("the instrumentation shim keeps node: imports out of its static graph (dev /api/files 500 regression)", () => {
  /* Next's dev fallback compiler builds src/instrumentation.ts without
     node:-scheme support: ANY node: builtin reachable from the entry — a
     top-level import, a re-export, or a dynamic import outside the statically
     pruned NEXT_RUNTIME === "nodejs" branch — fails the compile and 500s every
     request. The node-side runtime lives in @/lib/viewerInstrumentation and may
     only be reached through the guarded dynamic import. */
  const source = fs.readFileSync(new URL("./instrumentation.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/from\s+["']node:/);
  expect(source).not.toMatch(/^\s*import\s[^(]*viewerInstrumentation/m);
  expect(source).not.toMatch(/^\s*export\s.*\sfrom\s/m);
  expect(source).toMatch(/NEXT_RUNTIME === "nodejs"/);
});

test("runtime-host discards the unsupported credential before loading child-capable modules", () => {
  const source = fs.readFileSync(new URL("./runtime-host/main.ts", import.meta.url), "utf8");
  const discardAt = source.indexOf("discardWakatimeEnvironmentCredential()");
  const runtimeImportAt = source.indexOf('await import("@/lib/configDir")');

  expect(discardAt).toBeGreaterThanOrEqual(0);
  expect(runtimeImportAt).toBeGreaterThan(discardAt);
  expect(source.match(/^import .* from .*;$/gm)).toEqual([
    'import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";',
  ]);
});

test("runtime-host completes predecessor cleanup only after acquiring the singleton fence", () => {
  const source = fs.readFileSync(new URL("./runtime-host/main.ts", import.meta.url), "utf8");
  const fenceAt = source.indexOf("fence.acquire()");
  const cleanupAt = source.indexOf("await deploymentAdapter.completeRuntimeHostHandoff");
  const recoveryAt = source.indexOf("await host.recoverConsumers()");

  expect(fenceAt).toBeGreaterThanOrEqual(0);
  expect(cleanupAt).toBeGreaterThan(fenceAt);
  expect(recoveryAt).toBeGreaterThan(cleanupAt);
});
