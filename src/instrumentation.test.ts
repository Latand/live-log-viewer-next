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
  startWakatimeIntegrationIfEnabled,
  viewerReleaseOwnsTraffic,
} from "@/lib/viewerInstrumentation";
import { operatorSpawnCapabilityPath } from "@/lib/agent/operatorCapability";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
import { didStructuredHostStartupFail, markStructuredHostStartupReady } from "@/lib/runtime/startupStatus";
import { discardWakatimeEnvironmentCredential, WAKATIME_CREDENTIAL_ENV } from "@/lib/wakatime/credential";
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

test("node bootstrap discards WakaTime credentials before runtime imports snapshot or spawn", async () => {
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
      ], { stdout: "ignore", stderr: "ignore" });
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
