import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ViewerHealthEvidence } from "@/lib/runtime/contracts";
import { proxy } from "@/proxy";
import { POST as deploymentAdmission } from "@/app/api/runtime/deployments/route";

import { hasViewerDeploymentCapability, viewerHealthRequestPlan, waitForViewerReadiness } from "./deploymentHealth";

const originalToken = process.env.LLV_TOKEN;
const originalRuntimeEvents = process.env.LLV_RUNTIME_EVENTS;
const originalRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
afterEach(() => {
  if (originalToken === undefined) delete process.env.LLV_TOKEN;
  else process.env.LLV_TOKEN = originalToken;
  if (originalRuntimeEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = originalRuntimeEvents;
  if (originalRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = originalRuntimeSocket;
});

function evidence(ok: boolean): ViewerHealthEvidence {
  return {
    checkedAt: "2026-07-11T00:00:00.000Z",
    endpoint: "http://127.0.0.1:18001",
    processReady: true,
    rootStatus: ok ? 200 : 0,
    authenticatedStatus: null,
    unauthorizedStatus: null,
    assets: ok ? [{ path: "/_next/static/app.js", status: 200 }] : [],
    ok,
  };
}

test("candidate readiness polls through delayed startup until routes and assets pass", async () => {
  let probes = 0;
  let sleeps = 0;
  const result = await waitForViewerReadiness({
    endpoint: "http://127.0.0.1:18001",
    inspect: async () => "running",
    probe: async () => evidence(++probes === 3),
    sleep: async () => { sleeps += 1; },
    maxAttempts: 3,
  });

  expect(result.ok).toBe(true);
  expect(probes).toBe(3);
  expect(sleeps).toBe(2);
});

test("candidate readiness stops immediately after container exit", async () => {
  let probes = 0;
  let sleeps = 0;
  const result = await waitForViewerReadiness({
    endpoint: "http://127.0.0.1:18001",
    inspect: async () => "exited",
    probe: async () => { probes += 1; return evidence(false); },
    sleep: async () => { sleeps += 1; },
    maxAttempts: 30,
  });

  expect(result).toMatchObject({ ok: false, processReady: false, rootStatus: 0, detail: "candidate container exited before readiness" });
  expect(probes).toBe(0);
  expect(sleeps).toBe(0);
});

test("health request plan exercises remote authorization and rejection", () => {
  process.env.LLV_TOKEN = "viewer-token";
  const plan = viewerHealthRequestPlan("http://127.0.0.1:18001", "viewer-token");
  if (!plan.authenticated || !plan.unauthorized) throw new Error("authenticated request plan is missing");

  const authorized = proxy(new NextRequest(plan.authenticated.url, { headers: plan.authenticated.headers }));
  const unauthorized = proxy(new NextRequest(plan.unauthorized.url, { headers: plan.unauthorized.headers }));

  expect(plan.root.headers).toEqual({});
  expect(plan.capability).toEqual({
    url: "http://127.0.0.1:18001/api/runtime/deployments",
    headers: { ...plan.authenticated.headers, "content-type": "application/json" },
    method: "POST",
    body: "{}",
  });
  expect(authorized.headers.get("x-middleware-next")).toBe("1");
  expect(unauthorized.status).toBe(403);
});

test("deployment capability requires the candidate admission route", async () => {
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = "/state/runtime-host.sock";
  const plan = viewerHealthRequestPlan("http://127.0.0.1:18001", "viewer-token");
  const response = await deploymentAdmission(new NextRequest(plan.capability.url, {
    method: plan.capability.method,
    headers: { ...plan.capability.headers, host: "127.0.0.1:18001" },
    body: plan.capability.body,
  }));

  expect(hasViewerDeploymentCapability(404, "")).toBe(false);
  expect(hasViewerDeploymentCapability(200, JSON.stringify({ deployments: [] }))).toBe(false);
  expect(hasViewerDeploymentCapability(400, JSON.stringify({ error: "invalid JSON" }))).toBe(false);
  expect(response.status).toBe(400);
  expect(hasViewerDeploymentCapability(response.status, await response.text())).toBe(true);
});
