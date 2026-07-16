import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  accountControllerDelayMs,
  activateViewerRuntimeWhenCurrent,
  initializeOperatorSpawnCapabilityAtStartup,
  runStructuredHostStartup,
  scheduleAccountMigrationController,
  viewerReleaseOwnsTraffic,
} from "./instrumentation";
import { operatorSpawnCapabilityPath } from "@/lib/agent/operatorCapability";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import { didStructuredHostStartupFail, markStructuredHostStartupReady } from "@/lib/runtime/startupStatus";

test("account controller delay defaults to immediate startup and retains the explicit escape hatch", () => {
  expect(accountControllerDelayMs({})).toBe(0);
  expect(accountControllerDelayMs({ LLV_ACCOUNT_CONTROLLER_DELAY_MS: "250" })).toBe(250);
  expect(accountControllerDelayMs({ LLV_ACCOUNT_CONTROLLER_DELAY_MS: "invalid" })).toBe(0);
});

test("deployment candidates stay passive until their endpoint owns the durable release target", () => {
  const target = JSON.stringify({ endpoint: "http://127.0.0.1:19892" });
  expect(viewerReleaseOwnsTraffic({ PORT: "19892" }, () => target)).toBe(true);
  expect(viewerReleaseOwnsTraffic({ PORT: "19115" }, () => target)).toBe(false);
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
  expect(scheduled).toHaveLength(0);
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
  expect(scheduled).toHaveLength(0);
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

test("structured-host startup logs the thrown adoption error object", async () => {
  const failure = new Error("container adoption failed");
  const logged: unknown[][] = [];

  try {
    await runStructuredHostStartup(
      async () => { throw failure; },
      (...args) => { logged.push(args); },
    );

    expect(logged).toEqual([["[structured hosts] startup adoption failed", failure]]);
    expect(didStructuredHostStartupFail()).toBe(true);
    await runStructuredHostStartup(async () => undefined, (...args) => { logged.push(args); });
    expect(didStructuredHostStartupFail()).toBe(false);
    expect(logged).toHaveLength(1);
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
