import { expect, test } from "bun:test";

import type { ViewerHealthEvidence, ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import { bootstrapViewerRelease, type ViewerBootstrapAdapter } from "./deploymentBootstrap";

const candidate: ViewerReleaseIdentity = {
  revision: "a".repeat(40),
  image: "viewer:bootstrap",
  container: "viewer-bootstrap",
  endpoint: "http://127.0.0.1:18001",
};

function health(ok: boolean): ViewerHealthEvidence {
  return {
    checkedAt: "2026-07-11T00:00:00.000Z",
    endpoint: candidate.endpoint,
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: null,
    unauthorizedStatus: null,
    assets: [{ path: "/_next/static/app.js", status: 200 }],
    ok,
  };
}

function adapter(calls: string[], healthy = true): ViewerBootstrapAdapter {
  return {
    targetExists: () => false,
    resolveRevision: async () => { calls.push("resolve"); return candidate.revision; },
    buildCandidate: async () => { calls.push("build"); return candidate; },
    startCandidate: async () => { calls.push("start"); },
    verifyCandidate: async () => { calls.push("verify"); return health(healthy); },
    publishTarget: async () => { calls.push("publish"); },
    retireCandidate: async () => { calls.push("retire"); },
  };
}

test("bootstrap verifies an alternate release before publishing the initial target", async () => {
  const calls: string[] = [];
  const result = await bootstrapViewerRelease("origin/main", "bootstrap-1", adapter(calls));

  expect(result).toEqual({ candidate, health: health(true) });
  expect(calls).toEqual(["resolve", "build", "start", "verify", "publish"]);
});

test("bootstrap retires an unhealthy candidate without publishing a target", async () => {
  const calls: string[] = [];

  await expect(bootstrapViewerRelease("origin/main", "bootstrap-2", adapter(calls, false))).rejects.toThrow("health verification failed");
  expect(calls).toEqual(["resolve", "build", "start", "verify", "retire"]);
});

test("bootstrap refuses to replace an existing release target", async () => {
  const calls: string[] = [];
  const implementation = adapter(calls);
  implementation.targetExists = () => true;

  await expect(bootstrapViewerRelease("origin/main", "bootstrap-3", implementation)).rejects.toThrow("already exists");
  expect(calls).toEqual([]);
});
