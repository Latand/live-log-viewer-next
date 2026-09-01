import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type {
  ViewerHealthEvidence,
  ViewerRuntimeHostHandoffEvidence,
  ViewerRuntimeHostStartupPhase,
} from "@/lib/runtime/contracts";

import { HostCommandViewerDeploymentAdapter } from "./deploymentAdapter";
import { promotedViewerReadinessPhase } from "./deploymentHealth";
import { PROMOTE_ACTION_TIMEOUT_MS } from "./deploymentHotState";
import type { RuntimeHostHandoffIntent } from "./hostRelease";
import { completeRuntimeHostHandoff, runtimeHostSuccessorName } from "./hostSuccessor";

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
  const hostGeneration = {
    image: release.image,
    revision: release.revision,
    container: runtimeHostSuccessorName(release.revision, release.image),
  };
  const hostIdentity = { generation: hostGeneration, pid: 4242, startIdentity: "4242:successor", hostEpoch: 7 };
  const startupPhases: ViewerRuntimeHostStartupPhase[] = [
    "fence-waiting",
    "fence-acquired",
    "journal-open",
    "handoff-cleanup-complete",
    "consumers-recovered",
    "socket-listening",
    "ready",
  ];
  const runtimeHostHandoff: ViewerRuntimeHostHandoffEvidence = {
    ...hostIdentity,
    phases: startupPhases.map((phase, index) => ({ ...hostIdentity, phase, recordedAt: `2026-08-31T14:00:0${index}.000Z` })),
    probe: {
      checkedAt: "2026-08-31T14:00:08.000Z",
      requestId: "runtime-host-health-probe",
      responseId: "runtime-host-health-probe",
      elapsedMs: 12,
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
    if (action === "verify-host-successor") return runtimeHostHandoff;
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
  expect(await adapter.verifyRuntimeHostSuccessor(candidate)).toEqual(runtimeHostHandoff);
  await adapter.completeRuntimeHostHandoff({ image: candidate.image, revision: candidate.revision, container: "runtime-host-successor" });

  expect(calls.map((call) => call.action)).toEqual([
    "resolve-revision", "build-candidate", "start-candidate", "verify-candidate", "current-mcp-runtime", "reconcile-mcp-runtime", "promote", "verify-promoted", "rollback", "stage-host-successor", "verify-host-successor", "complete-host-handoff", "complete-host-handoff",
  ]);
  expect(calls[1]?.input).toEqual({ deploymentId: "deploy-1", revision: "a".repeat(40) });
  expect(calls[11]?.input).toEqual({ generation: hostGeneration });
  expect(calls.at(-1)?.input).toEqual({ generation: { image: candidate.image, revision: candidate.revision, container: "runtime-host-successor" } });
  expect(calls.every((call) => !Object.hasOwn(call.input, "command") && !Object.hasOwn(call.input, "args"))).toBe(true);
});

/* #1412: the adapter repeats `complete-host-handoff` after the successor's
   framed readiness proof, and the successor already ran the same cleanup at
   boot. That repeat is only safe while the second run for one generation is
   inert — it must clear nothing twice and reach Docker no second time. */
test("issue 1412: a second completion of one handoff generation touches nothing", async () => {
  const revision = "a".repeat(40);
  const image = `agent-log-viewer:deploy-${revision}-cafe`;
  const generation = { image, revision, container: runtimeHostSuccessorName(revision, image) };
  let intent: RuntimeHostHandoffIntent | null = {
    revision,
    image,
    successorContainer: generation.container,
    predecessorId: "predecessor-of-the-completed-handoff",
    recordedAt: "2026-09-01T08:00:00.000Z",
  };
  const clears: number[] = [];
  const calls: string[][] = [];
  const ports = {
    docker: async (argv: string[]) => {
      calls.push(argv);
      return argv[1] === "inspect" ? JSON.stringify([{ Id: "successor-id" }]) : "";
    },
    readHandoffIntent: () => intent,
    clearHandoffIntent: () => { clears.push(calls.length); intent = null; },
  };

  /* The successor's own boot-time cleanup. */
  expect(await completeRuntimeHostHandoff(generation, ports)).toBe(true);
  expect(intent).toBeNull();
  const bootCalls = [...calls];
  expect(bootCalls).toContainEqual(["container", "rm", "-f", "predecessor-of-the-completed-handoff"]);

  /* The repeat the adapter issues once `verify-host-successor` has proved the
     successor's readiness. */
  expect(await completeRuntimeHostHandoff(generation, ports)).toBe(false);
  expect(calls).toEqual(bootCalls);
  expect(clears).toHaveLength(1);
});

/* A diagnosis the gate collected is worth nothing if it stops at this boundary
   on its way to the durable record (#790). */
test("candidate health evidence carries its probe observations, readiness budget and candidate output", async () => {
  const failing: ViewerHealthEvidence = {
    checkedAt: "2026-08-28T00:00:33.000Z",
    endpoint: "http://127.0.0.1:18001",
    processReady: true,
    rootStatus: 500,
    authenticatedStatus: 500,
    unauthorizedStatus: 500,
    assets: [],
    observations: [
      { name: "root", url: "http://127.0.0.1:18001/", status: 500, elapsedMs: 6, expected: "200", ok: false, body: "Internal Server Error" },
      {
        name: "capability",
        url: "http://127.0.0.1:18001/api/runtime/deployments/capabilities/v1",
        status: 0,
        elapsedMs: 5_001,
        expected: "200 with capability viewer-deployments version 1",
        ok: false,
        error: "no answer within 5000 ms",
      },
    ],
    readiness: { attempts: 30, maxAttempts: 30, delayMs: 1_000, elapsedMs: 33_580, firstDetail: "Viewer candidate did not answer" },
    containerLog: ["TypeError: a route module failed to load"],
    ok: false,
    detail: "candidate readiness timed out after 30 attempts over 33.6s",
  };
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async (action) => (
    action === "verify-candidate" ? failing : {}
  ));

  expect(await adapter.verifyCandidate(candidate)).toEqual(failing);
});

/* The boolean pair in `calls` cannot explain a failed read, and the candidate
   that produced the refusal is retired seconds later (#790). */
test("the MCP probe's refused reads cross the boundary with the reason each one gave", async () => {
  const failing: ViewerHealthEvidence = {
    checkedAt: "2026-08-28T01:31:13.231Z",
    endpoint: "http://127.0.0.1:19250",
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [],
    mcpRuntime: {
      checkedAt: "2026-08-28T01:31:13.238Z",
      revision: "a".repeat(40),
      artifactDigest: "b".repeat(64),
      processReady: true,
      tools: ["board_snapshot", "deployment_status"],
      calls: { deploymentStatus: true, boardSnapshot: false },
      callFailures: [{
        tool: "board_snapshot",
        code: "tool_failed",
        error: "file scanner worker exited before completion (1)",
      }],
      ok: false,
      detail: "MCP runtime read probes failed against http://127.0.0.1:19250 - board_snapshot: file scanner worker exited before completion (1)",
    },
    ok: false,
    detail: "MCP runtime read probes failed",
  };
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:19250",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async (action) => (
    action === "verify-candidate" ? failing : {}
  ));

  expect(await adapter.verifyCandidate(candidate)).toEqual(failing);
});

test("an MCP call failure missing its reason is refused rather than recorded half-read", async () => {
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:19250",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async () => ({
    checkedAt: "2026-08-28T01:31:13.231Z",
    endpoint: "http://127.0.0.1:19250",
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [],
    mcpRuntime: {
      checkedAt: "2026-08-28T01:31:13.238Z",
      revision: "a".repeat(40),
      artifactDigest: "b".repeat(64),
      processReady: true,
      tools: [],
      calls: { deploymentStatus: true, boardSnapshot: false },
      callFailures: [{ tool: "board_snapshot" }],
      ok: false,
    },
    ok: false,
  }));

  expect(adapter.verifyCandidate(candidate)).rejects.toThrow("invalid MCP runtime call failures");
});

test("health evidence with an unusable observation is refused rather than recorded half-read", async () => {
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async () => ({
    checkedAt: "2026-08-28T00:00:33.000Z",
    endpoint: "http://127.0.0.1:18001",
    processReady: true,
    rootStatus: 500,
    authenticatedStatus: null,
    unauthorizedStatus: null,
    assets: [],
    observations: [{ name: "root", url: "http://127.0.0.1:18001/", status: "500", elapsedMs: 6, expected: "200", ok: false }],
    ok: false,
  }));

  expect(adapter.verifyCandidate(candidate)).rejects.toThrow("deployment adapter returned invalid health evidence");
});

/* #1254 exists because a runtime reached production after a verification that
   only covered the Viewer. The rehearsal now covers the host too, and the proof
   is worth nothing if it stops here: a record with no runtime-host evidence
   cannot be told apart from one where the host was never exercised. */
test("the candidate runtime-host rehearsal reaches the record with the runtime it exercised", async () => {
  const verified: ViewerHealthEvidence = {
    checkedAt: "2026-08-28T18:04:11.000Z",
    endpoint: "http://127.0.0.1:19310",
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [],
    runtimeHost: {
      checkedAt: "2026-08-28T18:05:02.000Z",
      runtime: "bun 1.4.0",
      succession: { predecessorReadyMs: 1_480, successorTookOverMs: 2_140, completed: true },
      listener: { windowMs: 15_000, polls: 30, answered: 30, abandoned: 15 },
      socket: { polls: 30, answered: 30, abandoned: 15 },
      ok: true,
    },
    ok: true,
  };
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:19310",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async (action) => (
    action === "verify-candidate" ? verified : {}
  ));

  expect(await adapter.verifyCandidate(candidate)).toEqual(verified);
});

/* The generation that died is gone by the time anyone reads the deployment, so
   its reason and its own last words only exist if they cross here (#1254). */
test("a refused runtime-host rehearsal carries its reason and the failing generation's output", async () => {
  const failing: ViewerHealthEvidence = {
    checkedAt: "2026-08-28T18:11:40.000Z",
    endpoint: "http://127.0.0.1:19311",
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [],
    runtimeHost: {
      checkedAt: "2026-08-28T18:12:31.000Z",
      runtime: "bun 1.4.0",
      succession: { predecessorReadyMs: 1_390, successorTookOverMs: 0, completed: false },
      listener: { windowMs: 15_000, polls: 24, answered: 12, abandoned: 12 },
      socket: { polls: 0, answered: 0, abandoned: 0 },
      ok: false,
      detail: "the stable listener stopped answering 6.0s into the hold window",
      log: ["error: write EPIPE", "at failWrite (node:net)"],
    },
    ok: false,
    detail: "the stable listener stopped answering 6.0s into the hold window",
  };
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:19311",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async (action) => (
    action === "verify-candidate" ? failing : {}
  ));

  expect(await adapter.verifyCandidate(candidate)).toEqual(failing);
});

test("issue 1272: runtime-host output is bounded and printable before it reaches the durable record", async () => {
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:19311",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async () => ({
    checkedAt: "2026-08-28T18:11:40.000Z",
    endpoint: candidate.endpoint,
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [],
    runtimeHost: {
      checkedAt: "2026-08-28T18:12:31.000Z",
      runtime: "bun 1.4.0",
      succession: { predecessorReadyMs: 1_390, successorTookOverMs: 0, completed: false },
      listener: { windowMs: 15_000, polls: 24, answered: 12, abandoned: 12 },
      socket: { polls: 0, answered: 0, abandoned: 0 },
      ok: false,
      detail: "the stable listener stopped answering 6.0s into the hold window",
      log: Array.from({ length: 25 }, (_, index) => `${index}:${"x".repeat(250)}\u0007`),
    },
    ok: false,
    detail: "candidate runtime-host gate failed",
  }));

  const evidence = await adapter.verifyCandidate(candidate);

  expect(evidence.runtimeHost?.log).toHaveLength(20);
  expect(evidence.runtimeHost?.log?.[0]).toStartWith("5:");
  expect(evidence.runtimeHost?.log?.at(-1)).toHaveLength(203);
  expect(evidence.runtimeHost?.log?.some((line) => line.includes("\u0007"))).toBe(false);
});

test("runtime-host evidence missing its poll counts is refused rather than recorded half-read", async () => {
  const candidate = {
    image: "viewer:test",
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:19312",
    revision: "a".repeat(40),
  };
  const adapter = new HostCommandViewerDeploymentAdapter(async () => ({
    checkedAt: "2026-08-28T18:20:00.000Z",
    endpoint: "http://127.0.0.1:19312",
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [],
    runtimeHost: {
      checkedAt: "2026-08-28T18:20:51.000Z",
      runtime: "bun 1.4.0",
      succession: { predecessorReadyMs: 1_480, successorTookOverMs: 2_140, completed: true },
      listener: { windowMs: 15_000, polls: 30, answered: 30 },
      socket: { polls: 30, answered: 30, abandoned: 15 },
      ok: true,
    },
    ok: true,
  }));

  expect(adapter.verifyCandidate(candidate)).rejects.toThrow("invalid runtime-host health evidence");
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
