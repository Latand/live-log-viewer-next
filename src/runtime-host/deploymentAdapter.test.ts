import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";
import { promotedViewerReadinessPhase } from "./deploymentHealth";
import { PROMOTE_ACTION_TIMEOUT_MS } from "./deploymentHotState";

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sleepingAdapter(phase?: string): { executable: string; stateFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-adapter-process-"));
  sandboxes.push(dir);
  const executable = path.join(dir, "adapter.sh");
  const phaseWrite = phase
    ? `printf '{"action":"%s","phase":"${phase}"}' "$1" > "$LLV_DEPLOYMENT_ADAPTER_PHASE_FILE"\n`
    : "";
  fs.writeFileSync(executable, `#!/bin/sh\n${phaseWrite}sleep 60\nprintf '{"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\\n'\n`, { mode: 0o700 });
  return { executable, stateFile: path.join(dir, "adapter-process.json") };
}

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
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

test("the host injects and revokes health authority only around probe-bearing adapter actions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-adapter-health-authority-"));
  sandboxes.push(directory);
  const executable = path.join(directory, "adapter.sh");
  const capture = path.join(directory, "input.json");
  const stateFile = path.join(directory, "adapter-process.json");
  const revision = "a".repeat(40);
  const capability = "H".repeat(43);
  fs.writeFileSync(executable, `#!/bin/sh
payload="$(cat)"
printf '%s' "$payload" > ${JSON.stringify(capture)}
if [ "$1" = "resolve-revision" ]; then
  printf '%s\\n' '{"revision":"${revision}"}'
else
  printf '%s\\n' '{"checkedAt":"2026-07-28T00:00:00.000Z","endpoint":"http://127.0.0.1:18001","processReady":true,"rootStatus":200,"authenticatedStatus":null,"unauthorizedStatus":null,"assets":[],"ok":true}'
fi
`, { mode: 0o700 });
  const issued: string[] = [];
  const revoked: string[] = [];
  const adapter = HostCommandViewerDeploymentAdapter.fromExecutable(executable, {
    stateFile,
    mcpHealthProbeAdmissions: {
      issue: () => { issued.push(capability); return capability; },
      consume: (value) => value === capability,
      revoke: (value) => { revoked.push(value); },
    },
  });
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    revision,
  };

  await adapter.verifyCandidate(candidate);
  expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
    candidate,
    healthProbeCapability: capability,
  });
  expect({ issued, revoked }).toEqual({ issued: [capability], revoked: [capability] });

  await adapter.resolveRevision(revision);
  expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({ revision });
  expect({ issued, revoked }).toEqual({ issued: [capability], revoked: [capability] });
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
  await Promise.race([
    waitForFile(fixture.stateFile),
    outcome.then((error) => {
      if (error) throw error;
      throw new Error("orphaned adapter exited before publishing ownership");
    }),
  ]);
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

/* #1216: the runtime-host log carried nothing about a running deployment, so a
   promote that stalled was invisible next to the journal maintenance chatter. */
test("a running adapter action reports its phase transitions to the host log", async () => {
  const phase = "waiting for hot-state activation - 3s of 180s - authority mode preparing revision matches epoch 9 activation pending";
  const fixture = sleepingAdapter(phase);
  const lines: string[] = [];
  const adapter = HostCommandViewerDeploymentAdapter.fromExecutable(fixture.executable, {
    stateFile: fixture.stateFile,
    timeouts: { promote: 200 },
    phaseLogIntervalMs: 5,
    log: (...args) => { lines.push(args.map(String).join(" ")); },
  });

  await expect(adapter.promote({
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    revision: "a".repeat(40),
  })).rejects.toThrow(`deployment adapter promote timed out while ${phase}`);
  expect(new Set(lines)).toEqual(new Set([`[viewer deployment] promote ${phase}`]));
});

/* #1216: the adapter cannot fit its waits inside a deadline it cannot see, and
   the hand-over outcome is lost unless it survives publication normalization. */
test("the host publishes its promote deadline and keeps the hand-over the adapter reports", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-adapter-handover-"));
  sandboxes.push(directory);
  const executable = path.join(directory, "adapter.sh");
  fs.writeFileSync(executable, `#!/bin/sh
printf '{"action":"activate","source":"legacy","revision":"${"a".repeat(40)}","releaseId":null,"artifactDigest":"${"b".repeat(64)}","stagedAt":null,"publishedAt":"2026-08-27T00:00:01.000Z","durable":true,"hotStateHandOver":"incumbent released hot state after 4s; activation published after 12s; deadline %s"}\n' "$LLV_DEPLOYMENT_ADAPTER_ACTION_DEADLINE_MS"
`, { mode: 0o700 });
  const adapter = HostCommandViewerDeploymentAdapter.fromExecutable(executable, {
    stateFile: path.join(directory, "adapter-process.json"),
  });

  const publication = await adapter.promote({
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    revision: "a".repeat(40),
    hotStateBackend: "sqlite-v1",
  });

  expect(publication.hotStateHandOver)
    .toBe(`incumbent released hot state after 4s; activation published after 12s; deadline ${PROMOTE_ACTION_TIMEOUT_MS}`);
});

test("promotion deadline reports the active handoff phase", async () => {
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    revision: "a".repeat(40),
  };

  for (const phase of ["fencing the current SQLite release", "publishing the Viewer release target"]) {
    const fixture = sleepingAdapter(phase);
    const adapter = HostCommandViewerDeploymentAdapter.fromExecutable(fixture.executable, {
      stateFile: fixture.stateFile,
      timeouts: { promote: 20 },
    });
    await expect(adapter.promote(candidate)).rejects.toThrow(
      `deployment adapter promote timed out while ${phase}`,
    );
    expect(fs.existsSync(`${fixture.stateFile}.phase`)).toBe(false);
  }
});

test("post-promotion deadline reports serving readiness and host adoption progress", async () => {
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    revision: "a".repeat(40),
  };
  const phase = promotedViewerReadinessPhase({
    state: "pending",
    phase: "adopting Claude hosts",
    completedHosts: 7,
    totalHosts: 19,
  });
  const fixture = sleepingAdapter(phase);
  const adapter = HostCommandViewerDeploymentAdapter.fromExecutable(fixture.executable, {
    stateFile: fixture.stateFile,
    timeouts: { "verify-promoted": 20 },
  });

  await expect(adapter.verifyPromoted(candidate)).rejects.toThrow(
    "deployment adapter verify-promoted timed out while waiting for promoted Viewer serving readiness - adoption 7 of 19 - adopting Claude hosts",
  );
});
