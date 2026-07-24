import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sleepingAdapter(): { executable: string; stateFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-adapter-process-"));
  sandboxes.push(dir);
  const executable = path.join(dir, "adapter.sh");
  fs.writeFileSync(executable, "#!/bin/sh\nsleep 60\nprintf '{\"revision\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\\n'\n", { mode: 0o700 });
  return { executable, stateFile: path.join(dir, "adapter-process.json") };
}

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filename)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("adapter process record was not written");
}

function recordedPid(filename: string): number {
  return (JSON.parse(fs.readFileSync(filename, "utf8")) as { pid: number }).pid;
}

function processGroupAlive(pid: number): boolean {
  return spawnSync("/bin/kill", ["-0", "--", `-${pid}`], { stdio: "ignore" }).status === 0;
}

test("host adapter exposes fixed actions and carries structured release data", async () => {
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  const mcpRuntime = {
    source: "managed" as const,
    revision: "a".repeat(40),
    releaseId: "deploy-candidate-abc",
    artifactDigest: "b".repeat(64),
    stagedAt: "2026-07-23T08:00:00.000Z",
  };
  const release = {
    image: "viewer:abc",
    container: "candidate-abc",
    endpoint: "http://127.0.0.1:18001",
    revision: "a".repeat(40),
    mcpRuntime,
  };
  const publication = {
    action: "activate" as const,
    ...mcpRuntime,
    publishedAt: "2026-07-23T08:00:01.000Z",
    durable: true as const,
  };
  const reconciliation = {
    publication,
    health: {
      checkedAt: "2026-07-23T08:00:02.000Z",
      revision: mcpRuntime.revision,
      artifactDigest: mcpRuntime.artifactDigest,
      processReady: true,
      tools: ["deployment_status", "board_snapshot"],
      calls: { deploymentStatus: true, boardSnapshot: true },
      ok: true,
    },
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async (action, input) => {
    calls.push({ action, input });
    if (action === "resolve-revision") return { revision: "a".repeat(40) };
    if (action === "build-candidate" || action === "current-release") return release;
    if (action === "current-mcp-runtime") return mcpRuntime;
    if (action === "reconcile-mcp-runtime") return reconciliation;
    if (action === "promote") return publication;
    if (action === "rollback") return { ...publication, action: "restore" };
    if (action.startsWith("verify-")) return {
      checkedAt: "2026-07-11T00:00:00.000Z",
      endpoint: release.endpoint,
      processReady: true,
      rootStatus: 200,
      authenticatedStatus: 200,
      unauthorizedStatus: 403,
      assets: [{ path: "/_next/static/app.js", status: 200 }],
      ok: true,
    };
    return {};
  });

  const revision = await adapter.resolveRevision("origin/main");
  const candidate = await adapter.buildCandidate("deploy-1", revision);
  await adapter.startCandidate(candidate);
  await adapter.verifyCandidate(candidate);
  expect(await adapter.currentMcpRuntime()).toEqual(mcpRuntime);
  expect(await adapter.reconcileMcpRuntime(revision)).toEqual(reconciliation);
  expect(await adapter.promote(candidate)).toEqual(publication);
  await adapter.verifyPromoted(candidate);
  expect(await adapter.rollback(release, candidate, mcpRuntime)).toEqual({ ...publication, action: "restore" });
  await adapter.stageRuntimeHostSuccessor(candidate);
  await adapter.completeRuntimeHostHandoff({ image: candidate.image, revision: candidate.revision, container: "runtime-host-successor" });

  expect(calls.map((call) => call.action)).toEqual([
    "resolve-revision", "build-candidate", "start-candidate", "verify-candidate", "current-mcp-runtime", "reconcile-mcp-runtime", "promote", "verify-promoted", "rollback", "stage-host-successor", "complete-host-handoff",
  ]);
  expect(calls[1]?.input).toEqual({ deploymentId: "deploy-1", revision: "a".repeat(40) });
  expect(calls.at(-1)?.input).toEqual({ generation: { image: candidate.image, revision: candidate.revision, container: "runtime-host-successor" } });
  expect(calls.every((call) => !Object.hasOwn(call.input, "command") && !Object.hasOwn(call.input, "args"))).toBe(true);
});

test("a boot whose MCP runtime is already published carries no reconciliation", async () => {
  const adapter = new HostCommandViewerDeploymentAdapter(async () => null);

  expect(await adapter.reconcileMcpRuntime("a".repeat(40))).toBeNull();
});

test("replacement host reconciles an orphaned adapter process before replay", async () => {
  const fixture = sleepingAdapter();
  const first = HostCommandViewerDeploymentAdapter.fromExecutable(fixture.executable, { stateFile: fixture.stateFile, timeouts: { "resolve-revision": 60_000 } });
  const pending = first.resolveRevision("origin/main");
  const outcome: Promise<Error | null> = pending
    .then(() => null)
    .catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  await waitForFile(fixture.stateFile);
  const orphanedPid = recordedPid(fixture.stateFile);

  const replacement = HostCommandViewerDeploymentAdapter.fromExecutable(fixture.executable, { stateFile: fixture.stateFile });
  await replacement.reconcile();

  expect(await outcome).toBeInstanceOf(Error);
  expect(processGroupAlive(orphanedPid)).toBe(false);
  expect(fs.existsSync(fixture.stateFile)).toBe(false);
});

test("adapter action deadline terminates the process tree and clears durable ownership", async () => {
  const fixture = sleepingAdapter();
  const adapter = HostCommandViewerDeploymentAdapter.fromExecutable(fixture.executable, { stateFile: fixture.stateFile, timeouts: { "resolve-revision": 20 } });
  const pending = adapter.resolveRevision("origin/main");
  await waitForFile(fixture.stateFile);
  const timedOutPid = recordedPid(fixture.stateFile);

  await expect(pending).rejects.toThrow("timed out");
  expect(processGroupAlive(timedOutPid)).toBe(false);
  expect(fs.existsSync(fixture.stateFile)).toBe(false);
});
