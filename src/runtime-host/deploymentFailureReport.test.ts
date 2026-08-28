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
