import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Sandbox the state directory BEFORE anything under the spawn lane is loaded:
   this file imports the real /api/spawn route to prove what its production
   dependencies do NOT carry, and the operator's own registry is not ours to
   touch. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-spawn-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { after } = await import("next/server");
const { reportSpawnOverrides, startDeferredSpawnWork } = await import("./reportSpawn");
const { SCHEDULED_REPORT_SESSION_CLASS } = await import("@/lib/agent/mcpAllowlist");
const { POST } = await import("@/app/api/spawn/route");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

test("the timer's deferred launch does not go through Next's request-scoped after()", async () => {
  /* The defect this covers: `executeSpawnRequest` hands its structured launch
     to `defer`, and the production `defer` is `after()`. A scheduled run has no
     request scope, so that call throws and every timer-fired structured launch
     settles launch_failed. */
  expect(() => after(async () => undefined)).toThrow();

  let ran = false;
  startDeferredSpawnWork(async () => { ran = true; });
  await Promise.resolve();
  expect(ran).toBe(true);

  /* A launch whose deferred work rejects must not take the timer tick with it:
     the failure is already durable on the receipt. */
  expect(() => startDeferredSpawnWork(async () => { throw new Error("launch failed"); })).not.toThrow();
  await Promise.resolve();
});

test("the report grant is resolved by admission, from the class, at call time", () => {
  let connected = true;
  const overrides = reportSpawnOverrides(() => connected);

  expect(overrides.internalGrant()).toEqual({
    sessionClass: SCHEDULED_REPORT_SESSION_CLASS,
    mcpServers: ["viewer", "telegram"],
  });

  /* The same overrides object, asked again after a logout: the grant follows
     the state at the moment admission asks, not the state at launch assembly. */
  connected = false;
  expect(overrides.internalGrant().mcpServers).toEqual(["viewer"]);
});

test("nothing arriving over /api/spawn can select the report session class", () => {
  /* The route hands `executeSpawnRequest` no dependencies at all, and the
     production dependencies carry no internal grant — so the branch that
     honours the report class is unreachable from any request body, header or
     query. It exists only for an in-process caller that passes its own. */
  expect(POST.productionDependencies.internalGrant).toBeUndefined();
  expect(POST.withDependencies.length).toBeGreaterThanOrEqual(1);
});
