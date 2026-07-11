import { expect, test } from "bun:test";

import type { ViewerHealthEvidence } from "@/lib/runtime/contracts";

import { waitForViewerReadiness } from "./deploymentHealth";

function evidence(ok: boolean): ViewerHealthEvidence {
  return {
    checkedAt: "2026-07-11T00:00:00.000Z",
    endpoint: "http://127.0.0.1:18001",
    processReady: true,
    rootStatus: ok ? 200 : 0,
    authenticatedStatus: null,
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
