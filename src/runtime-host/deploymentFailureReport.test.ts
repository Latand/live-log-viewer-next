import { expect, test } from "bun:test";

import type { ViewerDeploymentStatus, ViewerHealthEvidence } from "@/lib/runtime/contracts";

import { deploymentFailureReport } from "./deploymentFailureReport";

const CANDIDATE = "http://127.0.0.1:19106";

function status(health: ViewerHealthEvidence[]): ViewerDeploymentStatus {
  return {
    deploymentId: "deploy-1",
    idempotencyKey: "deploy-key-1",
    requestedRevision: "b".repeat(40),
    revision: "b".repeat(40),
    phase: "failed",
    terminal: true,
    candidate: {
      image: "agent-log-viewer:deploy-candidate",
      container: "llv-deploy-candidate",
      endpoint: CANDIDATE,
      revision: "b".repeat(40),
    },
    previous: null,
    mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
    health,
    error: "candidate readiness timed out",
    owner: { pid: 4, startIdentity: null },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:34.000Z",
    revisionNumber: 5,
  };
}

/* Tonight's failure in #790: a candidate that answered 500 on every route, was
   retired on rollback, and left one sentence behind. */
test("a failed candidate health gate renders the requests, the answers, the budget and the candidate's own output", () => {
  const report = deploymentFailureReport(status([{
    checkedAt: "2026-08-28T00:00:33.000Z",
    endpoint: CANDIDATE,
    processReady: true,
    rootStatus: 500,
    authenticatedStatus: 500,
    unauthorizedStatus: 500,
    assets: [],
    observations: [
      { name: "root", url: `${CANDIDATE}/`, status: 500, elapsedMs: 6, expected: "200", ok: false, body: "Internal Server Error" },
      { name: "unauthorized", url: `${CANDIDATE}/`, status: 500, elapsedMs: 4, expected: "403", ok: false },
      {
        name: "capability",
        url: `${CANDIDATE}/api/runtime/deployments/capabilities/v1`,
        status: 500,
        elapsedMs: 5,
        expected: "200 with capability viewer-deployments version 1",
        ok: false,
      },
    ],
    readiness: { attempts: 30, maxAttempts: 30, delayMs: 1_000, elapsedMs: 33_580 },
    containerLog: ["TypeError: a route module failed to load"],
    ok: false,
    detail: "candidate readiness timed out after 30 attempts over 33.6s",
  }]));

  expect(report).toEqual([
    `candidate ${"b".repeat(12)} at ${CANDIDATE} (container llv-deploy-candidate)`,
    "health at 2026-08-28T00:00:33.000Z: 30 of 30 attempts over 33.6s, 1000 ms apart",
    `  FAIL root ${CANDIDATE}/ -> HTTP 500 in 6 ms, expected 200`,
    `  FAIL unauthorized ${CANDIDATE}/ -> HTTP 500 in 4 ms, expected 403`,
    `  FAIL capability ${CANDIDATE}/api/runtime/deployments/capabilities/v1 -> HTTP 500 in 5 ms, expected 200 with capability viewer-deployments version 1`,
    "  assets: 0 referenced, 0 not 200",
    "  root body: Internal Server Error",
    "candidate output (last 1 lines):",
    "  TypeError: a route module failed to load",
  ]);
});

test("a record written before the gate carried evidence still reports what it has", () => {
  const report = deploymentFailureReport(status([{
    checkedAt: "2026-08-28T00:00:33.000Z",
    endpoint: CANDIDATE,
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [{ path: "/_next/static/app.js", status: 404 }],
    ok: false,
    detail: "Viewer health or referenced asset gate failed",
  }]));

  expect(report).toEqual([
    `candidate ${"b".repeat(12)} at ${CANDIDATE} (container llv-deploy-candidate)`,
    "health at 2026-08-28T00:00:33.000Z: no readiness accounting was recorded",
    "  root 200 authenticated 200 unauthorized 403",
    "  assets: 1 referenced, 1 not 200 (/_next/static/app.js -> 404)",
    "candidate output: none was captured before the candidate was retired",
  ]);
});

test("a deployment that failed before any health check says so instead of rendering nothing", () => {
  expect(deploymentFailureReport(status([]))).toEqual([
    `candidate ${"b".repeat(12)} at ${CANDIDATE} (container llv-deploy-candidate)`,
    "no health evidence was recorded before the failure",
  ]);
  expect(deploymentFailureReport(null)).toEqual([]);
});


/* Three deploys failed on this gate and the printed report named no cause. */
test("a refused MCP read is printed with the reason the candidate's own runtime gave", () => {
  const report = deploymentFailureReport(status([{
    checkedAt: "2026-08-28T01:31:13.231Z",
    endpoint: CANDIDATE,
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [{ path: "/_next/static/chunks/main.js", status: 200 }],
    mcpRuntime: {
      checkedAt: "2026-08-28T01:31:13.238Z",
      revision: "b".repeat(40),
      artifactDigest: "c".repeat(64),
      processReady: true,
      tools: ["board_snapshot", "deployment_status"],
      calls: { deploymentStatus: true, boardSnapshot: false },
      callFailures: [{
        tool: "board_snapshot",
        code: "tool_failed",
        error: "file scanner worker exited before completion (1): Module not found ~/release/fileScanner.worker.ts",
      }],
      ok: false,
      detail: "MCP runtime read probes failed",
    },
    ok: false,
    detail: "MCP runtime read probes failed",
  }]));

  expect(report).toContain(
    "  mcp board_snapshot refused (tool_failed): file scanner worker exited before completion (1):"
    + " Module not found ~/release/fileScanner.worker.ts",
  );
});

test("issue 1272: a runtime-host gate refusal renders all of its durable evidence", () => {
  const report = deploymentFailureReport(status([{
    checkedAt: "2026-08-28T18:11:40.000Z",
    endpoint: CANDIDATE,
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [{ path: "/_next/static/chunks/main.js", status: 200 }],
    runtimeHost: {
      checkedAt: "2026-08-28T18:12:31.000Z",
      runtime: "bun 1.4.0",
      succession: { predecessorReadyMs: 1_390, successorTookOverMs: 0, completed: false },
      listener: { windowMs: 15_000, polls: 24, answered: 12, abandoned: 12 },
      socket: { polls: 6, answered: 3, abandoned: 3 },
      ok: false,
      detail: "the stable listener stopped answering 6.0s into the hold window",
      log: ["error: write EPIPE", "at failWrite (node:net)"],
    },
    ok: false,
    detail: "candidate runtime-host gate failed",
  }]));

  expect(report).toContain(
    "  runtime host: bun 1.4.0; succession incomplete; predecessor ready 1390 ms; successor took over 0 ms"
    + " - the stable listener stopped answering 6.0s into the hold window",
  );
  expect(report).toContain("  runtime host listener: 12 of 24 answered over 15000 ms; 12 callers abandoned");
  expect(report).toContain("  runtime host socket: 3 of 6 answered; 3 callers abandoned");
  expect(report).toContain("runtime host output (last 2 lines):");
  expect(report).toContain("  error: write EPIPE");
  expect(report).toContain("  at failWrite (node:net)");
});
