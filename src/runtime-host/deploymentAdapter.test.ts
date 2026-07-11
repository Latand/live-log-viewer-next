import { expect, test } from "bun:test";

import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";

test("host adapter exposes fixed actions and carries structured release data", async () => {
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  const release = { image: "viewer:abc", container: "candidate-abc", endpoint: "http://127.0.0.1:18001", revision: "a".repeat(40) };
  const adapter = new HostCommandViewerDeploymentAdapter(async (action, input) => {
    calls.push({ action, input });
    if (action === "resolve-revision") return { revision: "a".repeat(40) };
    if (action === "build-candidate" || action === "current-release") return release;
    if (action.startsWith("verify-")) return {
      checkedAt: "2026-07-11T00:00:00.000Z",
      endpoint: release.endpoint,
      processReady: true,
      rootStatus: 200,
      authenticatedStatus: 200,
      assets: [{ path: "/_next/static/app.js", status: 200 }],
      ok: true,
    };
    return {};
  });

  const revision = await adapter.resolveRevision("origin/main");
  const candidate = await adapter.buildCandidate("deploy-1", revision);
  await adapter.startCandidate(candidate);
  await adapter.verifyCandidate(candidate);
  await adapter.promote(candidate);
  await adapter.verifyPromoted(candidate);
  await adapter.rollback(release, candidate);

  expect(calls.map((call) => call.action)).toEqual([
    "resolve-revision", "build-candidate", "start-candidate", "verify-candidate", "promote", "verify-promoted", "rollback",
  ]);
  expect(calls[1]?.input).toEqual({ deploymentId: "deploy-1", revision: "a".repeat(40) });
  expect(calls.every((call) => !Object.hasOwn(call.input, "command") && !Object.hasOwn(call.input, "args"))).toBe(true);
});
