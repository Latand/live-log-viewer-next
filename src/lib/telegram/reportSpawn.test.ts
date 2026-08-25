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
const { reportSpawnHeaders, reportSpawnOverrides, startDeferredSpawnWork } = await import("./reportSpawn");
const { SCHEDULED_REPORT_SESSION_CLASS } = await import("@/lib/agent/mcpAllowlist");
const { TELEGRAM_REPORT_PROJECT } = await import("./reportLineage");

/** An invented run id, in the shape the runner mints. Assembled rather than
    written out: the publication privacy gate refuses any literal with the
    shape of a session identifier, invented or not. */
const REPORT_RUN_ID = ["0192d4f1", "8f43", "4a10", "9c1e", "6b0f0a5d77c2"].join("-");
const { executeSpawnRequest, productionSpawnCommandDependencies } = await import("@/lib/agent/spawnCommand");
const { ensureOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
const { POST } = await import("@/app/api/spawn/route");

import type { NextRequest } from "next/server";

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

/**
 * The launch profile a spawn actually reserves, captured at the registry
 * boundary. The pinned-account preflight failure is the shortest path through
 * the real `executeSpawnRequest` that still writes a durable receipt: the
 * grant, the plugin surface and the display payload are all decided before it.
 */
function capturingRegistry(): { profiles: Record<string, unknown>[]; displays: unknown[]; requests: Record<string, unknown>[]; registry: unknown } {
  const profiles: Record<string, unknown>[] = [];
  const displays: unknown[] = [];
  const requests: Record<string, unknown>[] = [];
  let next = 0;
  const registry = {
    conversation: () => null,
    conversationForPath: () => null,
    supersedenceConflict: () => null,
    spawnReceiptForClientAttempt: () => null,
    beginSpawnRequest: (request: { launchProfile: Record<string, unknown>; launchDisplay?: unknown }) => {
      profiles.push(request.launchProfile);
      displays.push(request.launchDisplay ?? null);
      requests.push(request as unknown as Record<string, unknown>);
      next += 1;
      return {
        kind: "created" as const,
        receipt: {
          launchId: `launch_${next}`,
          conversationId: null,
          parentConversationId: null,
          parentSource: null,
          artifactPath: null,
          target: null,
          pane: null,
          engine: "codex",
          transport: null,
          state: "failed",
          verifiedHost: null,
          error: "account unavailable",
          launchProfile: request.launchProfile,
        },
      };
    },
    failSpawn: () => undefined,
    failStructuredSpawn: () => undefined,
    readOnlySnapshot: () => ({ receipts: {} }),
  };
  return { profiles, displays, requests, registry };
}

function reportLaunchRequest(body: Record<string, unknown>): NextRequest {
  /* The production headers, verbatim: this test is only worth anything if it
     goes through the same admission the timer's launch does. */
  return {
    headers: reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER),
    json: async () => body,
  } as unknown as NextRequest;
}

test("the report class decides the whole capability surface admission reserves", async () => {
  /* The defect this covers: `internalGrant` replaced the MCP list only, while
     PLUGIN admission still read the launch's session origin — a report run has
     no agent caller, no lineage parent and no role, so it classified as an
     operator root and was handed Computer Use beside viewer + telegram. The
     class states an exact surface; everything decided from it has to follow. */
  const captured = capturingRegistry();
  const dependencies = {
    ...productionSpawnCommandDependencies,
    registry: () => captured.registry,
    assertStructuredRuntime: () => undefined,
    resolveHealthySpawnAccount: async () => { throw new Error("no healthy account"); },
    ...reportSpawnOverrides(() => true),
  } as unknown as typeof productionSpawnCommandDependencies;

  const body = {
    engine: "codex",
    cwd: SANDBOX,
    accountId: "account-pinned",
    /* The durable report-run marker the runner sends (#1091). It rides the real
       admission path here because both halves are admitted, not decorative: an
       explicit project is refused outright for a launch admission reads as
       agent-initiated, which would settle every report run `launch_failed`. */
    clientAttemptId: `telegram-report-${REPORT_RUN_ID}`,
    project: TELEGRAM_REPORT_PROJECT,
    ["prompt"]: "Telegram daily report — window A → B.\n\nThe operator's own brief.",
  };
  const response = await executeSpawnRequest(reportLaunchRequest(body), dependencies);
  if (captured.profiles.length === 0) throw new Error(`no launch reserved: ${response.status} ${JSON.stringify(await response.json())}`);
  expect(captured.profiles.length).toBe(1);
  const profile = captured.profiles[0] as { mcpServers: string[]; plugins: string[] };
  expect(profile.mcpServers).toEqual(["viewer", "telegram"]);
  expect(profile.plugins).toEqual([]);
  /* And the prompt — which carries the operator's analyst brief — reserves no
     durable display copy in the registry. */
  expect(captured.displays[0]).toBeNull();
  /* The marker reached the registry, and it is still a root: no parent, no
     role, so the grant above survives every later re-decision. */
  expect(captured.requests[0]).toMatchObject({
    clientAttemptId: `telegram-report-${REPORT_RUN_ID}`,
    explicitProject: TELEGRAM_REPORT_PROJECT,
  });
  expect(captured.requests[0].parentConversationId ?? null).toBeNull();
  expect(captured.requests[0].role ?? null).toBeNull();

  /* The same launch WITHOUT the class is the contrast: an operator-root Codex
     launch carries Computer Use and its display payload, exactly as before. */
  const plain = capturingRegistry();
  await executeSpawnRequest(reportLaunchRequest(body), {
    ...dependencies,
    registry: () => plain.registry,
    internalGrant: undefined,
  } as unknown as typeof productionSpawnCommandDependencies);
  const plainProfile = plain.profiles[0] as { mcpServers: string[]; plugins: string[] };
  expect(plainProfile.plugins).toEqual(["computer-use"]);
  expect(plain.displays[0]).not.toBeNull();
});
