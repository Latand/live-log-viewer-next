import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerHealthEvidence, ViewerHealthProbeObservation } from "@/lib/runtime/contracts";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import { HOT_STATE_BACKEND } from "@/lib/state/hotStateAuthority";
import { proxy } from "@/proxy";
import { GET as deploymentCapability } from "@/app/api/runtime/deployments/capabilities/v1/route";
import {
  markStructuredDeliveryControllerReady,
  markStructuredDeliveryControllerUnavailable,
  markStructuredHostStartupProgress,
  markStructuredHostStartupReady,
} from "@/lib/runtime/startupStatus";
import { RuntimeJournal } from "@/runtime-host/journal";

import {
  candidateLogExcerpt,
  hasViewerDeploymentCapability,
  probeExcerpt,
  viewerDeploymentRegistryBackendMode,
  viewerDeploymentReleaseReady,
  viewerDeploymentStructuredHostStartup,
  viewerHealthFailureDetail,
  viewerHealthRequestPlan,
  waitForViewerReadiness,
} from "./deploymentHealth";

const originalToken = process.env.LLV_TOKEN;
afterEach(() => {
  markStructuredDeliveryControllerUnavailable();
  if (originalToken === undefined) delete process.env.LLV_TOKEN;
  else process.env.LLV_TOKEN = originalToken;
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

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId) => journal.retryOperation(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) =>
      journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
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
    url: "http://127.0.0.1:18001/api/runtime/deployments/capabilities/v1",
    headers: plan.authenticated.headers,
  });
  expect(authorized.headers.get("x-middleware-next")).toBe("1");
  expect(unauthorized.status).toBe(403);
});

test("deployment capability requires the candidate-owned versioned endpoint", async () => {
  markStructuredDeliveryControllerReady();
  const response = deploymentCapability();
  const body = await response.text();

  expect(hasViewerDeploymentCapability(404, "")).toBe(false);
  expect(hasViewerDeploymentCapability(200, JSON.stringify({ deployments: [] }))).toBe(false);
  expect(response.status).toBe(200);
  expect(hasViewerDeploymentCapability(response.status, body)).toBe(true);
  expect(viewerDeploymentRegistryBackendMode(response.status, body)).toBe("off");
  expect(viewerDeploymentRegistryBackendMode(200, JSON.stringify({
    capability: "viewer-deployments",
    version: 1,
    registryBackendMode: "invalid",
  }))).toBeNull();
  expect(viewerDeploymentReleaseReady(200, JSON.stringify({
    capability: "viewer-deployments",
    version: 1,
  }))).toBe(true);
  expect(viewerDeploymentReleaseReady(200, JSON.stringify({
    capability: "viewer-deployments",
    version: 1,
    releaseReady: false,
  }))).toBe(false);
});

test("deployment capability publishes bounded structured-host adoption progress", async () => {
  try {
    markStructuredDeliveryControllerReady();
    markStructuredHostStartupProgress({
      phase: "adopting Claude hosts",
      completedHosts: 7,
      totalHosts: 19,
    });
    const response = deploymentCapability();
    const body = await response.text();

    expect(viewerDeploymentStructuredHostStartup(response.status, body)).toMatchObject({
      state: "pending",
      phase: "adopting Claude hosts",
      completedHosts: 7,
      totalHosts: 19,
    });
    expect(viewerDeploymentStructuredHostStartup(200, JSON.stringify({
      capability: "viewer-deployments",
      version: 1,
      structuredHostStartup: {
        state: "pending",
        phase: "invalid/control/phase",
        completedHosts: 20,
        totalHosts: 19,
      },
    }))).toBeNull();
  } finally {
    markStructuredHostStartupReady();
  }
});

test("issue 572: serving health follows the process delivery controller", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-controller-health-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const previousStateDirectory = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  try {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    markStructuredHostStartupReady();

    const absent = deploymentCapability();
    expect(absent.status).toBe(503);
    expect(await absent.json()).toMatchObject({
      error: "structured delivery controller is unavailable",
      structuredHostStartup: { state: "ready" },
    });

    await bindStructuredDeliveryQueue([], {
      registry,
      client: runtimeClient(journal),
      deferStartupWork: true,
    });
    const recovered = deploymentCapability();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      capability: "viewer-deployments",
      version: 1,
      structuredDeliveryController: "ready",
    });

    await bindStructuredDeliveryQueue([], { registry, client: null });
    expect(deploymentCapability().status).toBe(503);

    process.env.LLV_STATE_DIR = directory;
    process.env.PORT = "19002";
    fs.writeFileSync(path.join(directory, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:19001",
      revision: "5".repeat(40),
      hotStateBackend: HOT_STATE_BACKEND,
    }));
    const passiveCandidate = deploymentCapability();
    expect(passiveCandidate.status).toBe(200);
    expect(await passiveCandidate.json()).toMatchObject({
      capability: "viewer-deployments",
      structuredDeliveryController: "unavailable",
    });
  } finally {
    if (previousStateDirectory === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDirectory;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await bindStructuredDeliveryQueue([], { registry, client: null });
    markStructuredHostStartupReady();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const CANDIDATE = "http://127.0.0.1:19106";

function observation(
  name: ViewerHealthProbeObservation["name"],
  status: number,
  expected: string,
  extra: Partial<ViewerHealthProbeObservation> = {},
): ViewerHealthProbeObservation {
  return {
    name,
    url: name === "capability" ? `${CANDIDATE}/api/runtime/deployments/capabilities/v1` : `${CANDIDATE}/`,
    status,
    elapsedMs: 6,
    expected,
    ok: false,
    ...extra,
  };
}

function outcome(overrides: Partial<Parameters<typeof viewerHealthFailureDetail>[0]> = {}) {
  return {
    observations: [],
    assets: [],
    deploymentCapable: true,
    registryBackendMatches: true,
    expectedRegistryBackendMode: "sqlite",
    observedRegistryBackendMode: "sqlite" as string | null,
    releaseReady: true,
    expectedAssetsMatch: true,
    ...overrides,
  };
}

/* The production shape of #790: every route of a candidate answered 500, and
   the gate reported the capability route - the one thing that was not itself
   broken. */
test("a candidate answering 500 on every route is reported as a failed surface, not as the capability gate", () => {
  const detail = viewerHealthFailureDetail(outcome({
    observations: [
      observation("root", 500, "200", { body: "Internal Server Error" }),
      observation("authenticated", 500, "200"),
      observation("unauthorized", 500, "403"),
      observation("capability", 500, "200 with capability viewer-deployments version 1"),
    ],
    deploymentCapable: false,
    registryBackendMatches: false,
    observedRegistryBackendMode: null,
    releaseReady: false,
  }));

  expect(detail).toStartWith("Viewer HTTP surface failed: ");
  expect(detail).toContain(`root GET ${CANDIDATE}/ -> HTTP 500 in 6 ms, expected 200`);
  expect(detail).toContain("unauthorized GET");
  expect(detail).toContain("expected 403");
  expect(detail).toContain(`capability GET ${CANDIDATE}/api/runtime/deployments/capabilities/v1 -> HTTP 500`);
  expect(detail).toContain("body: Internal Server Error");
});

test("a capability answer that misses the gate names the request, the answer and the time it took", () => {
  const detail = viewerHealthFailureDetail(outcome({
    observations: [
      observation("root", 200, "200", { ok: true }),
      observation("capability", 503, "200 with capability viewer-deployments version 1", {
        elapsedMs: 12,
        body: '{"error":"Viewer hot-state activation is incomplete"}',
      }),
    ],
    assets: [{ path: "/_next/static/app.js", status: 200 }],
    deploymentCapable: false,
  }));

  expect(detail).toBe(
    "Viewer deployment capability gate failed: capability GET "
    + `${CANDIDATE}/api/runtime/deployments/capabilities/v1 -> HTTP 503 in 12 ms, `
    + "expected 200 with capability viewer-deployments version 1; "
    + 'body: {"error":"Viewer hot-state activation is incomplete"}',
  );
});

test("a candidate that never answers names the transport failure rather than a gate", () => {
  const detail = viewerHealthFailureDetail(outcome({
    observations: [observation("root", 0, "200", { error: "no answer within 5000 ms", elapsedMs: 5_001 })],
    deploymentCapable: false,
  }));

  expect(detail).toBe(
    `Viewer candidate did not answer: root GET ${CANDIDATE}/ -> no response (no answer within 5000 ms) in 5001 ms, expected 200`,
  );
});

test("a served page with no build assets reports the asset gate instead of a generic failure", () => {
  expect(viewerHealthFailureDetail(outcome({
    observations: [observation("root", 200, "200", { ok: true })],
  }))).toBe("Viewer asset gate failed: the served page referenced no build assets");
  expect(viewerHealthFailureDetail(outcome({
    observations: [observation("root", 200, "200", { ok: true })],
    assets: [{ path: "/_next/static/app.js", status: 200 }, { path: "/_next/static/app.css", status: 404 }],
  }))).toBe("Viewer asset gate failed: 1 of 2 referenced assets did not answer 200 (/_next/static/app.css -> 404)");
});

test("readiness timeout names the attempts it spent, the elapsed time and the budget", async () => {
  let clock = 1_000;
  const result = await waitForViewerReadiness({
    endpoint: CANDIDATE,
    inspect: async () => "running",
    probe: async () => ({ ...evidence(false), detail: "Viewer HTTP surface failed: root GET / -> HTTP 500 in 6 ms, expected 200" }),
    sleep: async () => { clock += 1_000; },
    now: () => clock,
    maxAttempts: 30,
  });

  expect(result.ok).toBe(false);
  expect(result.readiness).toEqual({ attempts: 30, maxAttempts: 30, delayMs: 1_000, elapsedMs: 29_000 });
  expect(result.detail).toBe(
    "candidate readiness timed out after 30 attempts over 29.0s (budget 30 attempts 1000 ms apart): "
    + "Viewer HTTP surface failed: root GET / -> HTTP 500 in 6 ms, expected 200",
  );
});

test("readiness timeout keeps the first attempt when the symptom changed while waiting", async () => {
  let clock = 0;
  let probes = 0;
  const details = ["candidate answered no response", "Viewer release startup is incomplete"];
  const result = await waitForViewerReadiness({
    endpoint: CANDIDATE,
    inspect: async () => "running",
    probe: async () => ({ ...evidence(false), detail: details[Math.min(probes++, details.length - 1)] as string }),
    sleep: async () => { clock += 1_000; },
    now: () => clock,
    maxAttempts: 3,
  });

  expect(result.readiness?.firstDetail).toBe("candidate answered no response");
  expect(result.detail).toContain("after 3 attempts over 2.0s (budget 3 attempts 1000 ms apart)");
  expect(result.detail).toEndWith("; first attempt: candidate answered no response");
});

test("a container that disappears mid-wait reports how far the wait had got", async () => {
  let clock = 0;
  let states = 0;
  const result = await waitForViewerReadiness({
    endpoint: CANDIDATE,
    inspect: async () => (states++ === 0 ? "running" : "exited"),
    probe: async () => evidence(false),
    sleep: async () => { clock += 1_000; },
    now: () => clock,
    maxAttempts: 5,
  });

  expect(result.detail).toBe("candidate container exited before readiness");
  expect(result.readiness).toEqual({ attempts: 1, maxAttempts: 5, delayMs: 1_000, elapsedMs: 1_000 });
});

test("probe bodies and candidate output stay bounded and printable", () => {
  expect(probeExcerpt("  a\n\tmultiline\u0007 body  ")).toBe("a multiline body");
  expect(probeExcerpt("x".repeat(400))).toHaveLength(203);
  expect(candidateLogExcerpt("first\n\nsecond\nthird\n", { maxLines: 2 })).toEqual(["second", "third"]);
  expect(candidateLogExcerpt("y".repeat(300), { maxChars: 40 })).toEqual([`${"y".repeat(40)}...`]);
});
