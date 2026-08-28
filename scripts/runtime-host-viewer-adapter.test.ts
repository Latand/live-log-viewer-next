import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { WAKATIME_CREDENTIAL_ENV, withoutWakatimeCredential } from "../src/lib/wakatime/credential";
import { MCP_TOOL_NAMES } from "../src/lib/mcp/server";
import { UnixRuntimeHostClient } from "../src/lib/runtime/client";
import { viewerComposeSnapshotName } from "../src/runtime-host/deploymentArtifacts";
import { RuntimeHost } from "../src/runtime-host/host";
import { RuntimeJournal } from "../src/runtime-host/journal";
import { McpHealthProbeAdmissions } from "../src/runtime-host/mcpHealthProbeAdmission";
import {
  createMcpHealthProbeAdmissionChannel,
  serveMcpHealthProbeAdmissionChannel,
} from "../src/runtime-host/mcpHealthProbeAdmissionChannel";
import { probeMcpRuntime } from "../src/runtime-host/mcpRuntimeProbe";
import { RuntimeHostFence } from "../src/runtime-host/runtimeHostFence";
import { serveRuntimeHost } from "../src/runtime-host/socket";
import {
  completeHotStatePreparation,
  HOT_STATE_BACKEND,
  HOT_STATE_RELEASE_REVISION_ENV,
  hotStateSqliteWriterReady,
  markHotStateActivationReady,
  markViewerReleaseReady,
  publishHotStateAuthority,
  readHotStateAuthority,
} from "../src/lib/state/hotStateAuthority";
import { flowStateCollectionSeed } from "../src/lib/flows/store";
import { pipelineStateCollectionSeeds } from "../src/lib/pipelines/store";
import { workflowStateCollectionSeed } from "../src/lib/workflows/store";
import { initializeStateCollections } from "../src/lib/state/sqliteStateStore";
import { mcpProbeEnvironment, runBootstrapRelease } from "./runtime-host-viewer-adapter";

const root = path.resolve(import.meta.dir, "..");
const adapter = path.join(root, "scripts", "runtime-host-viewer-adapter.ts");

test("candidate MCP probes read through the candidate Viewer endpoint", () => {
  const environment = mcpProbeEnvironment(
    "http://candidate.invalid",
    "/state/candidate-target.json",
    {
      NODE_ENV: "test",
      LLV_VIEWER_CONTROL_URL: "http://stable.invalid",
      LLV_VIEWER_DEPLOY_TARGET: "/state/stable-target.json",
    },
  );

  expect(environment.LLV_VIEWER_CONTROL_URL).toBe("http://candidate.invalid");
  expect(environment.LLV_VIEWER_DEPLOY_TARGET).toBe("/state/candidate-target.json");
});

test("a candidate MCP probe without a candidate endpoint refuses instead of reading the deployed Viewer", () => {
  expect(() => mcpProbeEnvironment("", "/state/candidate-target.json", {
    NODE_ENV: "test",
    LLV_VIEWER_CONTROL_URL: "http://stable.invalid",
  })).toThrow("candidate MCP probe requires the candidate's own control endpoint");
});
const release = {
  container: "viewer-current",
  endpoint: "http://127.0.0.1:19892",
  image: "viewer:test",
  revision: "a".repeat(40),
};

async function currentRelease(options: { target: string; containerState?: "running" | "exited"; timeoutMs?: number }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-current-release-adapter-"));
  const state = path.join(sandbox, "state");
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(state, "viewer-release.json"), options.target);
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then printf '%s\\n' "$FAKE_DOCKER_STATE"; exit 0; fi
exit 1
`, { mode: 0o755 });

  const child = Bun.spawn([process.execPath, adapter, "current-release"], {
    cwd: root,
    env: {
      ...withoutWakatimeCredential(process.env),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_STATE: options.containerState ?? "running",
      LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1",
      LLV_STATE_DIR: state,
      LLV_VIEWER_PORT: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write("{}\n");
  child.stdin.end();
  const timeout = Symbol("timeout");
  const result = await Promise.race([
    child.exited,
    Bun.sleep(options.timeoutMs ?? 1_500).then(() => timeout),
  ]);
  if (result === timeout) {
    child.kill("SIGKILL");
    await child.exited;
  }
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  fs.rmSync(sandbox, { recursive: true, force: true });
  return { code: result === timeout ? 124 : result, stdout, stderr };
}

test("running rollback target remains available while its HTTP application is unhealthy", async () => {
  const result = await currentRelease({ target: JSON.stringify(release) });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(release);
});

test("stopped rollback target blocks promotion with container evidence", async () => {
  const result = await currentRelease({ target: JSON.stringify(release), containerState: "exited" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("current release container is exited");
});

test("malformed rollback target blocks promotion with a durable-target error", async () => {
  const result = await currentRelease({ target: "{broken" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("current release target is invalid");
});

test("documented bootstrap input obtains host-owned admission through the final MCP transport", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-bootstrap-admission-"));
  const state = path.join(sandbox, "state");
  const socketPath = path.join(state, "runtime-host.sock");
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/runtime/deployments") {
        return Response.json({ count: 0, deployments: [] });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const revision = "7".repeat(40);
  const candidate = {
    ...release,
    revision,
    mcpRuntime: {
      source: "managed" as const,
      revision,
      releaseId: "bootstrap-candidate",
      artifactDigest: "a".repeat(64),
      stagedAt: "2026-07-28T00:00:00.000Z",
    },
  };
  const calls: string[] = [];
  fs.mkdirSync(state, { recursive: true });
  const environment = Object.fromEntries(Object.entries(withoutWakatimeCredential(process.env))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  Object.assign(environment, {
    HOME: sandbox,
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    TMPDIR: path.join(sandbox, "tmp"),
    LLV_STATE_DIR: state,
    LLV_RUNTIME_EVENTS: "1",
    LLV_RUNTIME_HOST_SOCKET: socketPath,
    LLV_VIEWER_CONTROL_URL: control.url.origin,
    LLV_AGENT_REGISTRY_SQLITE: "off",
    LLV_CODEX_HOME: path.join(sandbox, "codex"),
    LLV_CLAUDE_HOME: path.join(sandbox, "claude"),
  });
  fs.mkdirSync(environment.TMPDIR, { recursive: true });

  try {
    const result = await runBootstrapRelease({ revision: "origin/main" }, {
      runtimeSocket: socketPath,
      targetExists: () => false,
      resolveRevision: async (requested) => {
        calls.push(`resolve:${requested}`);
        return revision;
      },
      buildCandidate: async () => {
        calls.push("build");
        return candidate;
      },
      startCandidate: async () => {
        calls.push("start");
      },
      verifyCandidate: async (releaseIdentity, healthProbeCapability, healthProbeAdmissions) => {
        calls.push("verify");
        const mcpRuntime = await probeMcpRuntime({
          command: process.execPath,
          args: [path.join(root, "bin", "mcp-server.mjs")],
          cwd: root,
          env: environment,
          runtime: releaseIdentity.mcpRuntime!,
          healthProbeCapability,
          healthProbeAdmissions,
        });
        return {
          checkedAt: mcpRuntime.checkedAt,
          endpoint: releaseIdentity.endpoint,
          processReady: true,
          rootStatus: 200,
          authenticatedStatus: null,
          unauthorizedStatus: null,
          assets: [{ path: "/_next/static/app.js", status: 200 }],
          mcpRuntime,
          ok: mcpRuntime.ok,
          ...(mcpRuntime.detail ? { detail: mcpRuntime.detail } : {}),
        };
      },
      publishTarget: async () => {
        calls.push("publish");
      },
      targetMatches: () => false,
      retireCandidate: async () => {
        calls.push("retire");
      },
    });

    expect(calls).toEqual(["resolve:origin/main", "build", "start", "verify", "publish"]);
    expect(result.health.mcpRuntime).toMatchObject({
      processReady: true,
      calls: { deploymentStatus: true, boardSnapshot: true },
      ok: true,
    });
    expect(result.health.mcpRuntime?.tools).toHaveLength(MCP_TOOL_NAMES.length);
    expect(fs.existsSync(socketPath)).toBe(false);
    const successor = new RuntimeHostFence(`${socketPath}.lock`);
    successor.acquire();
    successor.release();
  } finally {
    control.stop(true);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("bootstrap rejects caller-selected probe authority and spends its own admission once", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-bootstrap-forgery-"));
  const socketPath = path.join(sandbox, "state", "runtime-host.sock");
  const callerCapability = new McpHealthProbeAdmissions().issue();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  try {
    const result = await runBootstrapRelease({
      revision: "origin/main",
      healthProbeCapability: callerCapability,
    }, {
      runtimeSocket: socketPath,
      targetExists: () => false,
      resolveRevision: async () => release.revision,
      buildCandidate: async () => release,
      startCandidate: async () => {},
      verifyCandidate: async (candidate, healthProbeCapability) => {
        const client = new UnixRuntimeHostClient(socketPath);
        expect(healthProbeCapability).not.toBe(callerCapability);
        await expect(client.requestViewerDeployment({
          idempotencyKey: "bootstrap-forgery",
        })).rejects.toThrow("runtime request method is unsupported");
        expect((await client.snapshot()).deployments).toEqual([]);
        expect(await client.admitMcpHealthProbe(callerCapability)).toBe(false);
        expect(await client.admitMcpHealthProbe(healthProbeCapability)).toBe(true);
        expect(await client.admitMcpHealthProbe(healthProbeCapability)).toBe(false);
        return {
          checkedAt: "2026-07-28T00:00:00.000Z",
          endpoint: candidate.endpoint,
          processReady: true,
          rootStatus: 200,
          authenticatedStatus: null,
          unauthorizedStatus: null,
          assets: [{ path: "/_next/static/app.js", status: 200 }],
          ok: true,
        };
      },
      publishTarget: async () => {},
      targetMatches: () => false,
      retireCandidate: async () => {},
    });

    expect(result.candidate).toEqual(release);
    expect(fs.existsSync(socketPath)).toBe(false);
    const successor = new RuntimeHostFence(`${socketPath}.lock`);
    successor.acquire();
    successor.release();
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

function composeSnapshot(): string {
  return JSON.stringify({
    services: {
      viewer: {
        build: null,
        command: null,
        entrypoint: null,
        environment: {},
        image: "viewer:test",
        labels: {},
        network_mode: "host",
        pid: "host",
        privileged: false,
        restart: "unless-stopped",
        "user": "1000:1000",
        volumes: [],
        working_dir: "/app",
      },
    },
  });
}

async function runAction(options: {
  action: "promote" | "retain-only" | "rollback" | "complete-host-handoff" | "reconcile-mcp-runtime" | "verify-candidate";
  input: unknown;
  dockerScript: string;
  snapshots?: string[];
  handoffIntent?: Record<string, unknown>;
  environment?: Record<string, string>;
  setupState?: (state: string) => void;
  observe?: (state: string, child: { exited: Promise<number> }) => Promise<void>;
  sandbox?: string;
  preserveSandbox?: boolean;
}) {
  const sandbox = options.sandbox ?? fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-lifecycle-adapter-"));
  const state = path.join(sandbox, "state");
  const bin = path.join(sandbox, "bin");
  const dockerLog = path.join(sandbox, "docker.log");
  fs.mkdirSync(path.join(state, "deployments", "compose"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  options.setupState?.(state);
  if (options.handoffIntent) {
    fs.writeFileSync(path.join(state, "runtime-host-handoff-intent.json"), JSON.stringify(options.handoffIntent));
  }
  for (const container of options.snapshots ?? []) {
    fs.writeFileSync(
      path.join(state, "deployments", "compose", viewerComposeSnapshotName(container)),
      composeSnapshot(),
    );
  }
  fs.writeFileSync(path.join(bin, "docker"), options.dockerScript, { mode: 0o755 });
  const child = Bun.spawn([process.execPath, adapter, options.action], {
    cwd: root,
    env: {
      ...withoutWakatimeCredential(process.env),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: dockerLog,
      LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1",
      LLV_STATE_DIR: state,
      LLV_VIEWER_PORT: "1",
      ...options.environment,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify(options.input)}\n`);
  child.stdin.end();
  const observed = options.observe?.(state, child);
  const code = await child.exited;
  await observed;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const dockerCalls = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, "utf8").trim().split("\n") : [];
  const targetFile = path.join(state, "viewer-release.json");
  const target = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, "utf8")) as unknown : null;
  const authority = readHotStateAuthority(state);
  const handoffIntentExists = fs.existsSync(path.join(state, "runtime-host-handoff-intent.json"));
  const releaseSwitchIntentExists = fs.existsSync(path.join(state, "viewer-release-switch-intent.json"));
  if (!options.preserveSandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  return {
    code,
    stdout,
    stderr,
    dockerCalls,
    target,
    authority,
    handoffIntentExists,
    releaseSwitchIntentExists,
    sandbox,
    state,
  };
}

function initializeHotStateFixture(
  state: string,
  candidate: typeof release & { hotStateBackend: typeof HOT_STATE_BACKEND },
): void {
  const previousState = process.env.LLV_STATE_DIR;
  const previousRevision = process.env[HOT_STATE_RELEASE_REVISION_ENV];
  process.env.LLV_STATE_DIR = state;
  process.env[HOT_STATE_RELEASE_REVISION_ENV] = candidate.revision;
  try {
    fs.writeFileSync(path.join(state, "viewer-release.json"), JSON.stringify(candidate));
    publishHotStateAuthority(state, "sqlite", candidate.revision);
    initializeStateCollections(path.join(state, "state.sqlite"), [
      flowStateCollectionSeed(),
      ...pipelineStateCollectionSeeds(),
      workflowStateCollectionSeed(),
    ]);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    if (previousRevision === undefined) delete process.env[HOT_STATE_RELEASE_REVISION_ENV];
    else process.env[HOT_STATE_RELEASE_REVISION_ENV] = previousRevision;
  }
}

test("promotion atomically publishes the matching MCP runtime with durable evidence", async () => {
  const candidate = {
    ...release,
    revision: "7".repeat(40),
    mcpRuntime: {
      source: "managed",
      revision: "7".repeat(40),
      releaseId: "deploy-candidate",
      artifactDigest: "a".repeat(64),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  };
  const result = await runAction({
    action: "promote",
    input: { candidate },
    dockerScript: "#!/bin/sh\nexit 1\n",
  });

  expect(result.code).toBe(0);
  expect(result.target).toEqual(candidate);
  expect(JSON.parse(result.stdout)).toEqual({
    action: "activate",
    ...candidate.mcpRuntime,
    publishedAt: expect.any(String),
    durable: true,
  });
});

test("SQLite promotion waits for completed runtime activation", async () => {
  const candidate = {
    ...release,
    revision: "6".repeat(40),
    hotStateBackend: HOT_STATE_BACKEND,
    mcpRuntime: {
      source: "managed" as const,
      revision: "6".repeat(40),
      releaseId: "deploy-sqlite-candidate",
      artifactDigest: "6".repeat(64),
      stagedAt: "2026-08-06T00:00:00.000Z",
    },
  };
  let observedPreparing = false;
  const result = await runAction({
    action: "promote",
    input: { candidate },
    environment: { LLV_HOT_STATE_ACTIVATION_TIMEOUT_MS: "2000", LLV_HOT_STATE_ACTIVATION_POLL_MS: "5" },
    observe: async (state, child) => {
      const deadline = Date.now() + 1_000;
      let request = readHotStateAuthority(state);
      while (Date.now() < deadline && request?.mode !== "preparing") {
        await Bun.sleep(5);
        request = readHotStateAuthority(state);
      }
      expect(request?.mode).toBe("preparing");
      observedPreparing = true;
      const exitedBeforeReady = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(30).then(() => false),
      ]);
      expect(exitedBeforeReady).toBe(false);
      const authoritative = completeHotStatePreparation(state, request!);
      markHotStateActivationReady(state, authoritative);
    },
    dockerScript: "#!/bin/sh\nexit 1\n",
  });

  expect(observedPreparing).toBe(true);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.authority).toMatchObject({
    mode: "sqlite",
    releaseRevision: candidate.revision,
    activationReadyAt: expect.any(String),
  });
});

/* #1216 regression pair. The promote deadline and the adapter-side activation
   budget used to be the same 30s, so the host killed the adapter before its own
   wait could name anything, and the operator only ever saw the phase string. */
const sqliteIncumbent = { ...release, hotStateBackend: HOT_STATE_BACKEND };

const liveIncumbentDocker = `#!/bin/sh
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then printf 'running\\n'; exit 0; fi
exit 1
`;

function sqliteCandidate(revision: string, releaseId: string) {
  return {
    ...release,
    revision,
    container: "viewer-candidate-1216",
    image: "viewer:candidate-1216",
    hotStateBackend: HOT_STATE_BACKEND,
    mcpRuntime: {
      source: "managed" as const,
      revision,
      releaseId,
      artifactDigest: revision.slice(0, 1).repeat(64),
      stagedAt: "2026-08-27T00:00:00.000Z",
    },
  };
}

test("promote that never sees hot-state activation fails with a named reason", async () => {
  const candidate = sqliteCandidate("5".repeat(40), "deploy-1216-never");
  const result = await runAction({
    action: "promote",
    input: { candidate },
    setupState: (state) => { initializeHotStateFixture(state, sqliteIncumbent); },
    /* The release budget has to outlast a real `docker inspect` spawn, or the
       step reports the daemon as unobservable rather than the incumbent as
       retained — which is the honest outcome, but not the one under test. */
    environment: {
      LLV_HOT_STATE_ACTIVATION_TIMEOUT_MS: "400",
      LLV_HOT_STATE_ACTIVATION_POLL_MS: "10",
      LLV_INCUMBENT_HOT_STATE_RELEASE_TIMEOUT_MS: "3000",
      LLV_INCUMBENT_HOT_STATE_RELEASE_POLL_MS: "300",
    },
    dockerScript: liveIncumbentDocker,
  });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(candidate.revision);
  expect(result.stderr).toContain("waited");
  expect(result.stderr).toContain("authority mode sqlite");
  expect(result.stderr).toContain("activation pending");
  expect(result.stderr).toContain("candidate container is running");
  expect(result.stderr).toContain("incumbent still running");
});

test("promote succeeds when hot-state activation arrives late but inside the budget", async () => {
  const candidate = sqliteCandidate("4".repeat(40), "deploy-1216-late");
  const phaseFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-1216-phase-")), "phase.json");
  const phases: string[] = [];
  const result = await runAction({
    action: "promote",
    input: { candidate },
    setupState: (state) => { initializeHotStateFixture(state, sqliteIncumbent); },
    environment: {
      LLV_DEPLOYMENT_ADAPTER_PHASE_FILE: phaseFile,
      LLV_HOT_STATE_ACTIVATION_TIMEOUT_MS: "5000",
      LLV_HOT_STATE_ACTIVATION_POLL_MS: "10",
      LLV_INCUMBENT_HOT_STATE_RELEASE_TIMEOUT_MS: "150",
      LLV_INCUMBENT_HOT_STATE_RELEASE_POLL_MS: "10",
    },
    observe: async (state, child) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        try {
          const phase = (JSON.parse(fs.readFileSync(phaseFile, "utf8")) as { phase?: string }).phase;
          if (phase && phases[phases.length - 1] !== phase) phases.push(phase);
        } catch { /* the adapter rewrites the phase file atomically */ }
        const authority = readHotStateAuthority(state);
        if (authority?.mode === "sqlite"
          && authority.releaseRevision === candidate.revision
          && !authority.activationReadyAt
          && phases.some((phase) => phase.startsWith("waiting for hot-state activation"))) {
          markHotStateActivationReady(state, authority);
          break;
        }
        await Bun.sleep(10);
      }
      await child.exited;
    },
    dockerScript: liveIncumbentDocker,
  });

  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.authority).toMatchObject({
    mode: "sqlite",
    releaseRevision: candidate.revision,
    activationReadyAt: expect.any(String),
  });
  expect(phases.some((phase) => phase.startsWith("releasing incumbent hot state"))).toBe(true);
  expect(phases.some((phase) => /^waiting for hot-state activation - \d+s of \d+s - /.test(phase))).toBe(true);
  /* The phase file is deleted when the action ends, so the hand-over outcome
     rides the publication evidence into the deployment journal instead. */
  expect((JSON.parse(result.stdout) as { hotStateHandOver?: string }).hotStateHandOver)
    .toMatch(/^incumbent (released hot state|still|state unobservable|release not required).*activation published after \d+s$/);
  fs.rmSync(path.dirname(phaseFile), { recursive: true, force: true });
});

/* A configured budget above the deadline the host will enforce puts the two
   back in the inversion this fix removes: the host would kill the adapter
   mid-wait and the operator would read the bare phase string again. Without
   the clamp this promote waits ten minutes and the test times out. */
test("hand-over budgets configured past the host deadline still expire inside it", async () => {
  const candidate = sqliteCandidate("6".repeat(40), "deploy-1216-clamped");
  const startedAt = Date.now();
  const result = await runAction({
    action: "promote",
    input: { candidate },
    setupState: (state) => { initializeHotStateFixture(state, sqliteIncumbent); },
    environment: {
      LLV_DEPLOYMENT_ADAPTER_ACTION_DEADLINE_MS: "3000",
      LLV_HOT_STATE_ACTIVATION_TIMEOUT_MS: "600000",
      LLV_HOT_STATE_ACTIVATION_POLL_MS: "20",
      LLV_INCUMBENT_HOT_STATE_RELEASE_TIMEOUT_MS: "600000",
      LLV_INCUMBENT_HOT_STATE_RELEASE_POLL_MS: "20",
    },
    dockerScript: liveIncumbentDocker,
  });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("promoted Viewer never published hot-state activation");
  expect(Date.now() - startedAt).toBeLessThan(20_000);
}, 30_000);

test("promotion from SQLite to a legacy release checkpoints rollback mirrors first", async () => {
  const current = { ...release, hotStateBackend: HOT_STATE_BACKEND };
  const candidate = {
    ...release,
    revision: "3".repeat(40),
    container: "viewer-legacy-promotion",
    image: "viewer:legacy-promotion",
    mcpRuntime: {
      source: "managed" as const,
      revision: "3".repeat(40),
      releaseId: "deploy-legacy-candidate",
      artifactDigest: "3".repeat(64),
      stagedAt: "2026-08-06T00:00:00.000Z",
    },
  };
  const result = await runAction({
    action: "promote",
    input: { candidate },
    setupState: (state) => { initializeHotStateFixture(state, current); },
    dockerScript: "#!/bin/sh\nexit 1\n",
  });

  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.target).toEqual(candidate);
  expect(result.authority).toMatchObject({
    mode: "legacy",
    releaseRevision: candidate.revision,
    checkpoint: { revisions: { flows: 0, pipelines: 0, pipelinesArchive: 0, workflows: 0 } },
  });
});

/** A deployed package tree as the successor generation's own image carries it.
    `node_modules` is a symlink so staging copies the link, not 33k files. */
function successorPackage(prefix: string, options: { revision: string; bundle?: string }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const state = path.join(sandbox, "state");
  const packageRoot = path.join(sandbox, "package");
  const stableRuntime = path.join(sandbox, "llv-mcp-runtime");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.copyFileSync(path.join(root, "bin", "mcp-server.mjs"), path.join(packageRoot, "bin", "mcp-server.mjs"));
  fs.copyFileSync(path.join(root, "bin", "server-runtime.mjs"), path.join(packageRoot, "bin", "server-runtime.mjs"));
  if (options.bundle === undefined) fs.copyFileSync(path.join(root, "dist", "mcp-server.mjs"), path.join(packageRoot, "dist", "mcp-server.mjs"));
  else fs.writeFileSync(path.join(packageRoot, "dist", "mcp-server.mjs"), options.bundle);
  fs.copyFileSync(path.join(root, "package.json"), path.join(packageRoot, "package.json"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
  const target = { ...release, revision: options.revision };
  fs.writeFileSync(path.join(state, "viewer-release.json"), JSON.stringify(target));
  return { sandbox, state, packageRoot, stableRuntime, target };
}

async function runReconcile(
  fixture: ReturnType<typeof successorPackage>,
  options: {
    revision: string;
    socketPath?: string;
    healthProbeCapability?: string;
    healthProbeAdmissions?: McpHealthProbeAdmissions;
  },
) {
  const admissionChannel = options.healthProbeAdmissions
    ? await createMcpHealthProbeAdmissionChannel()
    : null;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [adapter, "reconcile-mcp-runtime"], {
      cwd: root,
      env: {
        ...withoutWakatimeCredential(process.env),
        LLV_AGENT_REGISTRY_SQLITE: "off",
        LLV_CLAUDE_HOME: path.join(fixture.sandbox, "claude"),
        LLV_CODEX_HOME: path.join(fixture.sandbox, "codex"),
        LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1",
        LLV_DEPLOYMENT_PACKAGE_ROOT: fixture.packageRoot,
        LLV_MCP_RUNTIME_ROOT: fixture.stableRuntime,
        LLV_RUNTIME_EVENTS: "1",
        ...(options.socketPath ? { LLV_RUNTIME_HOST_SOCKET: options.socketPath } : {}),
        LLV_STATE_DIR: fixture.state,
        LLV_VIEWER_PORT: "1",
      },
      stdio: ["pipe", "pipe", "pipe", admissionChannel?.childFd ?? "ignore"],
    });
  } catch (error) {
    admissionChannel?.close();
    throw error;
  } finally {
    admissionChannel?.closeChildFd();
  }
  const closeHealthAdmission = options.healthProbeAdmissions && admissionChannel
    ? (() => {
        const closeServing = serveMcpHealthProbeAdmissionChannel(
          admissionChannel.channel,
          options.healthProbeAdmissions,
        );
        return () => {
          closeServing();
          admissionChannel.close();
        };
      })()
    : null;
  child.stdin?.write(`${JSON.stringify({
    revision: options.revision,
    ...(options.healthProbeCapability ? { healthProbeCapability: options.healthProbeCapability } : {}),
  })}\n`);
  child.stdin?.end();
  const readStream = async (stream: Readable | null): Promise<string> => {
    let body = "";
    if (!stream) return body;
    for await (const chunk of stream) body += String(chunk);
    return body;
  };
  const [code, stdout, stderr] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    }),
    readStream(child.stdout),
    readStream(child.stderr),
  ]).finally(() => closeHealthAdmission?.());
  return { code, stdout, stderr };
}

test("the first successor boot publishes and probes the MCP runtime after an old adapter deployment", async () => {
  const revision = "7".repeat(40);
  const fixture = successorPackage("llv-mcp-successor-reconcile-", { revision });
  const socketPath = path.join(fixture.state, "runtime-host.sock");
  const journal = new RuntimeJournal(path.join(fixture.state, "runtime-events.sqlite"));
  const admissions = new McpHealthProbeAdmissions();
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const { code, stdout, stderr } = await runReconcile(fixture, {
      revision,
      socketPath,
      healthProbeCapability: admissions.issue(),
      healthProbeAdmissions: admissions,
    });

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      publication: {
        action: "activate",
        revision,
        durable: true,
      },
      health: {
        revision,
        ok: true,
        calls: {
          deploymentStatus: true,
          boardSnapshot: true,
        },
      },
    });
    expect(result.health.tools).toHaveLength(MCP_TOOL_NAMES.length);
    const target = JSON.parse(fs.readFileSync(path.join(fixture.state, "viewer-release.json"), "utf8"));
    expect(target).toMatchObject({
      revision,
      mcpRuntime: {
        source: "managed",
        revision,
        artifactDigest: result.publication.artifactDigest,
      },
    });
    expect(fs.readFileSync(path.join(fixture.stableRuntime, "bin", "mcp-server.mjs"), "utf8"))
      .toContain("deployedPackageRoot");

    /* Every later boot of the same generation finds its own runtime already
       published and reconciles nothing. */
    const releases = path.join(fixture.state, "mcp-runtime", "releases");
    const published = fs.readdirSync(releases);
    const reboot = await runReconcile(fixture, {
      revision,
      socketPath,
      healthProbeCapability: admissions.issue(),
      healthProbeAdmissions: admissions,
    });

    expect({ code: reboot.code, stdout: reboot.stdout, stderr: reboot.stderr })
      .toEqual({ code: 0, stdout: "null\n", stderr: "" });
    expect(fs.readdirSync(releases)).toEqual(published);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.state, "viewer-release.json"), "utf8"))).toEqual(target);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
}, 30_000);

test("a failed first-boot MCP probe restores the old release target and retires the staged runtime", async () => {
  const revision = "7".repeat(40);
  const fixture = successorPackage("llv-mcp-successor-rollback-", { revision, bundle: "process.exit(1);\n" });

  try {
    const { code, stderr } = await runReconcile(fixture, { revision });

    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
    /* The launcher is installed before the probe, so its presence proves the
       failure came from the health gate and not from an earlier step. */
    expect(fs.existsSync(path.join(fixture.stableRuntime, "bin", "mcp-server.mjs"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.state, "viewer-release.json"), "utf8"))).toEqual(fixture.target);
    const releases = path.join(fixture.state, "mcp-runtime", "releases");
    expect(fs.existsSync(releases) ? fs.readdirSync(releases) : []).toEqual([]);
  } finally {
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("candidate build stages the matching MCP package and stable dispatcher", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-build-adapter-"));
  const state = path.join(sandbox, "state");
  const bin = path.join(sandbox, "bin");
  const template = path.join(sandbox, "template");
  const stableRuntime = path.join(sandbox, "llv-mcp-runtime");
  const runtimeHome = path.join(sandbox, "runtime-home");
  const dockerLog = path.join(sandbox, "docker.log");
  const revision = "7".repeat(40);
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(template, "bin"), { recursive: true });
  fs.writeFileSync(path.join(template, "bin", "mcp-server.mjs"), "process.stdout.write('dispatcher\\n');\n");
  fs.writeFileSync(path.join(template, "bin", "server-runtime.mjs"), "export const runtime = true;\n");
  fs.writeFileSync(path.join(template, "package.json"), JSON.stringify({
    name: "mcp-build-fixture",
    type: "module",
    scripts: { "build:mcp": "bun build-mcp.ts" },
  }));
  fs.writeFileSync(path.join(template, "build-mcp.ts"), `
    import fs from "node:fs";
    fs.mkdirSync("dist", { recursive: true });
    fs.mkdirSync("node_modules/fixture", { recursive: true });
    fs.writeFileSync("dist/mcp-server.mjs", "process.stdout.write('exact-runtime\\\\n');\\\\n");
    fs.writeFileSync("node_modules/fixture/index.js", "export {};\\\\n");
  `);
  const fixtureInstall = Bun.spawnSync({
    cmd: [process.execPath, "install"],
    cwd: template,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (fixtureInstall.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(fixtureInstall.stderr));
  }
  const git = path.join(bin, "git");
  fs.writeFileSync(git, `#!/bin/sh
set -eu
if [ "\${3:-}" = "rev-parse" ] && [ "\${4:-}" = "--is-bare-repository" ]; then printf 'true\\n'; exit 0; fi
if [ "\${3:-}" = "worktree" ] && [ "\${4:-}" = "add" ]; then mkdir -p "$6"; cp -R "$FAKE_SOURCE_TEMPLATE/." "$6/"; exit 0; fi
if [ "\${3:-}" = "worktree" ] && [ "\${4:-}" = "remove" ]; then rm -rf "$6"; exit 0; fi
if [ "\${3:-}" = "remote" ] || [ "\${3:-}" = "fetch" ] || [ "\${3:-}" = "cat-file" ]; then exit 0; fi
if [ "\${3:-}" = "worktree" ] && [ "\${4:-}" = "prune" ]; then exit 0; fi
exit 1
`, { mode: 0o755 });
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1 $2" = "compose --project-directory" ]; then printf '%s\\n' "$FAKE_COMPOSE"; exit 0; fi
if [ "$1 $2" = "build --pull" ]; then exit 0; fi
if [ "$1 $2" = "container ls" ]; then exit 0; fi
if [ "$1 $2" = "image rm" ]; then exit 0; fi
exit 1
`, { mode: 0o755 });
  const child = Bun.spawn([process.execPath, adapter, "build-candidate"], {
    cwd: root,
    env: {
      ...withoutWakatimeCredential(process.env),
      HOME: runtimeHome,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_COMPOSE: composeSnapshot(),
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_SOURCE_TEMPLATE: template,
      LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1",
      LLV_MCP_RUNTIME_ROOT: stableRuntime,
      LLV_STATE_DIR: state,
      LLV_VIEWER_CANDIDATE_PORT_BASE: "28000",
      LLV_VIEWER_PORT: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({ deploymentId: "deploy-mcp-build", revision })}\n`);
  child.stdin.end();
  const code = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  try {
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const candidate = JSON.parse(stdout) as {
      mcpRuntime: { revision: string; releaseId: string; artifactDigest: string };
    };
    const candidateReleaseId = candidate.mcpRuntime.releaseId;
    expect(typeof candidateReleaseId).toBe("string");
    expect(candidate.mcpRuntime).toMatchObject({
      revision,
      releaseId: expect.stringMatching(/^[a-z0-9-]+$/),
      artifactDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const releaseRoot = path.join(state, "mcp-runtime", "releases", candidateReleaseId);
    expect(fs.readFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), "utf8")).toContain("exact-runtime");
    expect(fs.readFileSync(path.join(stableRuntime, "bin", "mcp-server.mjs"), "utf8")).toContain("deployedPackageRoot");
    expect(fs.existsSync(path.join(state, "deployments", "deploy-mcp-build", "source"))).toBe(false);
    const buildCall = fs.readFileSync(dockerLog, "utf8")
      .split("\n")
      .find((line) => line.startsWith("build --pull"));
    expect(buildCall).toContain(`--build-arg LLV_RUNTIME_HOME=${runtimeHome}`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 15_000);

test("fenced successor cleanup removes its predecessor and clears the durable handoff intent", async () => {
  const generation = {
    image: "agent-log-viewer:deploy-cleanup",
    revision: "d".repeat(40),
    container: "llv-runtime-host-cleanup",
  };
  const result = await runAction({
    action: "complete-host-handoff",
    input: { generation },
    handoffIntent: {
      ...generation,
      successorContainer: generation.container,
      predecessorId: "runtime-host-predecessor",
      recordedAt: "2026-07-21T09:00:00.000Z",
    },
    dockerScript: `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1 $2" = "container inspect" ]; then printf '[{"Id":"successor-id"}]\n'; exit 0; fi
if [ "$1 $2" = "container rm" ]; then exit 0; fi
exit 1
`,
  });

  expect(result.code).toBe(0);
  expect(result.dockerCalls).toEqual([
    "container inspect llv-runtime-host-cleanup",
    "container rm -f runtime-host-predecessor",
  ]);
  expect(result.handoffIntentExists).toBe(false);
});

test("retention stops the immediate rollback container and removes obsolete releases", async () => {
  const previous = { ...release, container: "viewer-rollback", image: "viewer:rollback" };
  const result = await runAction({
    action: "retain-only",
    input: { releases: [release, previous] },
    dockerScript: `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1 $2" = "container ls" ]; then printf 'viewer-current\nviewer-rollback\nviewer-obsolete\n'; exit 0; fi
if [ "$1 $2" = "container inspect" ]; then printf 'viewer:obsolete\n'; exit 0; fi
if [ "$1 $2" = "container rm" ]; then exit 0; fi
if [ "$1 $2" = "container stop" ]; then exit 0; fi
if [ "$1 $2" = "image rm" ]; then exit 0; fi
exit 1
`,
  });

  expect(result.code).toBe(0);
  expect(result.dockerCalls).toContain("container stop --time 10 viewer-rollback");
  expect(result.dockerCalls).not.toContain("container stop --time 10 viewer-current");
  expect(result.dockerCalls).toContain("container rm -f viewer-obsolete");
});

test("deployment command children exclude the legacy WakaTime credential", async () => {
  const credentialPlaceholder = ["legacy", "child", "placeholder"].join("-");
  const result = await runAction({
    action: "retain-only",
    input: { releases: [release] },
    environment: { [WAKATIME_CREDENTIAL_ENV]: credentialPlaceholder },
    dockerScript: `#!/bin/sh
set -eu
if [ -n "\${WAKATIME_API_KEY+x}" ]; then exit 91; fi
if [ "$1 $2" = "container ls" ]; then exit 0; fi
exit 1
`,
  });

  expect(result.code).toBe(0);
  expect(JSON.stringify(result)).not.toContain(credentialPlaceholder);
});

/* The failed candidate is retired immediately, taking the only account of why it
   failed with it. Without this read the gate can report nothing but its own name,
   which is what #790 had to deploy blind against - and it is the one evidence
   path that leaves the process. */
test("a candidate that dies before readiness carries its container's own account into the evidence", async () => {
  const candidate = { ...release, container: "viewer-candidate" };
  const result = await runAction({
    action: "verify-candidate",
    input: { candidate },
    dockerScript: `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'exited\n'; exit 0; fi
if [ "$1" = "logs" ]; then
  printf 'Error: Cannot find module next/dist/server\n'
  printf 'viewer exited with code 1\n' >&2
  exit 0
fi
exit 1
`,
  });

  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.dockerCalls).toContain("logs --tail 40 viewer-candidate");
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    detail: "candidate container exited before readiness",
    /* stdout first, then stderr: a container that dies mid-boot writes to both,
       and each half carries a piece of the reason. */
    containerLog: ["Error: Cannot find module next/dist/server", "viewer exited with code 1"],
  });
});

test("a container that will not give up its log leaves the gate's own report intact", async () => {
  const candidate = { ...release, container: "viewer-candidate" };
  const result = await runAction({
    action: "verify-candidate",
    input: { candidate },
    dockerScript: `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'exited\n'; exit 0; fi
if [ "$1" = "logs" ]; then exit 12; fi
exit 1
`,
  });

  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.dockerCalls).toContain("logs --tail 40 viewer-candidate");
  const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(evidence.detail).toBe("candidate container exited before readiness");
  expect(evidence).not.toHaveProperty("containerLog");
});

test("rollback starts and health-checks the retained release before switching the stable target", async () => {
  let probes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      probes += 1;
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/deployments/capabilities/v1") {
        return Response.json(
          { capability: "viewer-deployments", version: 1, registryBackendMode: "off" },
          { headers: { connection: "close" } },
        );
      }
      if (pathname === "/_next/static/app.js") return new Response("self.__viewer=true", { headers: { connection: "close" } });
      return new Response('<script src="/_next/static/app.js"></script>', {
        headers: { connection: "close", "content-type": "text/html" },
      });
    },
  });
  const previous = {
    ...release,
    container: "viewer-rollback",
    image: "viewer:rollback",
    endpoint: `http://127.0.0.1:${server.port}`,
  };
  const previousMcpRuntime = {
    source: "legacy",
    revision: "8".repeat(40),
    releaseId: null,
    artifactDigest: "8".repeat(64),
    stagedAt: null,
  };
  try {
    const result = await runAction({
      action: "rollback",
      input: { previous, candidate: release, previousMcpRuntime },
      snapshots: [previous.container],
      dockerScript: `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'running\n'; exit 0; fi
if [ "$1" = "start" ]; then exit 0; fi
exit 1
`,
    });

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.dockerCalls).toContain("start viewer-rollback");
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(result.target).toEqual(previous);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "restore",
      ...previousMcpRuntime,
      publishedAt: expect.any(String),
      durable: true,
    });
  } finally {
    server.stop(true);
  }
});

test("rollback checkpoints hot state before publishing a legacy target", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/deployments/capabilities/v1") {
        return Response.json(
          { capability: "viewer-deployments", version: 1, registryBackendMode: "off" },
          { headers: { connection: "close" } },
        );
      }
      if (pathname === "/_next/static/app.js") return new Response("self.__viewer=true", { headers: { connection: "close" } });
      return new Response('<script src="/_next/static/app.js"></script>', {
        headers: { connection: "close", "content-type": "text/html" },
      });
    },
  });
  const candidate = { ...release, hotStateBackend: HOT_STATE_BACKEND };
  const previous = {
    ...release,
    revision: "9".repeat(40),
    container: "viewer-legacy",
    image: "viewer:legacy",
    endpoint: `http://127.0.0.1:${server.port}`,
  };
  const previousMcpRuntime = {
    source: "legacy",
    revision: previous.revision,
    releaseId: null,
    artifactDigest: "9".repeat(64),
    stagedAt: null,
  };
  try {
    const result = await runAction({
      action: "rollback",
      input: { previous, candidate, previousMcpRuntime },
      snapshots: [previous.container],
      setupState: (state) => {
        initializeHotStateFixture(state, candidate);
      },
      dockerScript: `#!/bin/sh
set -eu
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'running\n'; exit 0; fi
if [ "$1" = "start" ]; then exit 0; fi
exit 1
`,
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.target).toEqual(previous);
    expect(result.authority).toMatchObject({
      mode: "legacy",
      releaseRevision: previous.revision,
      checkpoint: {
        revisions: { flows: 0, pipelines: 0, pipelinesArchive: 0, workflows: 0 },
      },
    });
  } finally {
    server.stop(true);
  }
});

test("rollback publishes destination authority before changing the stable target", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/deployments/capabilities/v1") {
        return Response.json({ capability: "viewer-deployments", version: 1, registryBackendMode: "off" });
      }
      if (pathname === "/_next/static/app.js") return new Response("self.__viewer=true");
      return new Response('<script src="/_next/static/app.js"></script>', { headers: { "content-type": "text/html" } });
    },
  });
  const candidate = { ...release, hotStateBackend: HOT_STATE_BACKEND };
  const previous = {
    ...release,
    revision: "5".repeat(40),
    container: "viewer-legacy-crash",
    image: "viewer:legacy-crash",
    endpoint: `http://127.0.0.1:${server.port}`,
  };
  const previousMcpRuntime = {
    source: "legacy" as const,
    revision: previous.revision,
    releaseId: null,
    artifactDigest: "5".repeat(64),
    stagedAt: null,
  };
  try {
    const result = await runAction({
      action: "rollback",
      input: { previous, candidate, previousMcpRuntime },
      snapshots: [previous.container],
      environment: { NODE_ENV: "test", LLV_TEST_EXIT_AFTER_HOT_STATE_AUTHORITY: "1" },
      setupState: (state) => { initializeHotStateFixture(state, candidate); },
      dockerScript: `#!/bin/sh
set -eu
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'running\n'; exit 0; fi
if [ "$1" = "start" ]; then exit 0; fi
exit 1
`,
    });
    expect(result.code).toBe(86);
    expect(result.target).toEqual(candidate);
    expect(result.authority).toMatchObject({
      mode: "legacy",
      releaseRevision: previous.revision,
      checkpoint: { revisions: { flows: 0, pipelines: 0, pipelinesArchive: 0, workflows: 0 } },
    });
  } finally {
    server.stop(true);
  }
});

test("rollback resumes after a crash between destination authority and target publication", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/deployments/capabilities/v1") {
        return Response.json({ capability: "viewer-deployments", version: 1, registryBackendMode: "off" });
      }
      if (pathname === "/_next/static/app.js") return new Response("self.__viewer=true");
      return new Response('<script src="/_next/static/app.js"></script>', { headers: { "content-type": "text/html" } });
    },
  });
  const candidate = { ...release, hotStateBackend: HOT_STATE_BACKEND };
  const previous = {
    ...release,
    revision: "4".repeat(40),
    container: "viewer-legacy-retry",
    image: "viewer:legacy-retry",
    endpoint: `http://127.0.0.1:${server.port}`,
  };
  const previousMcpRuntime = {
    source: "legacy" as const,
    revision: previous.revision,
    releaseId: null,
    artifactDigest: "4".repeat(64),
    stagedAt: null,
  };
  try {
    const result = await runAction({
      action: "rollback",
      input: { previous, candidate, previousMcpRuntime },
      snapshots: [previous.container],
      setupState: (state) => {
        initializeHotStateFixture(state, candidate);
        publishHotStateAuthority(state, "legacy", previous.revision, {
          checkpoint: {
            acknowledgedAt: "2026-08-06T00:00:00.000Z",
            revisions: { flows: 0, pipelines: 0, pipelinesArchive: 0, workflows: 0 },
          },
        });
      },
      dockerScript: `#!/bin/sh
set -eu
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'running\n'; exit 0; fi
if [ "$1" = "start" ]; then exit 0; fi
exit 1
`,
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.target).toEqual(previous);
    expect(result.authority).toMatchObject({ mode: "legacy", releaseRevision: previous.revision });
  } finally {
    server.stop(true);
  }
});

test("SQLite rollback recovers an interrupted promotion before health and keeps the candidate fenced", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-sqlite-promotion-recovery-"));
  const state = path.join(sandbox, "state");
  const targetFile = path.join(state, "viewer-release.json");
  let previousWriterReady = () => false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/deployments/capabilities/v1") {
        return Response.json(
          { capability: "viewer-deployments", version: 1, registryBackendMode: "off" },
          { status: previousWriterReady() ? 200 : 503 },
        );
      }
      if (pathname === "/_next/static/app.js") return new Response("self.__viewer=true");
      return new Response('<script src="/_next/static/app.js"></script>', {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const previous = {
    ...release,
    endpoint: server.url.origin,
    hotStateBackend: HOT_STATE_BACKEND,
    revision: "2".repeat(40),
  };
  const candidate = {
    ...release,
    container: "viewer-interrupted-candidate",
    endpoint: "http://127.0.0.1:19991",
    image: "viewer:interrupted-candidate",
    hotStateBackend: HOT_STATE_BACKEND,
    revision: "3".repeat(40),
    mcpRuntime: {
      source: "managed" as const,
      revision: "3".repeat(40),
      releaseId: "deploy-interrupted-candidate",
      artifactDigest: "3".repeat(64),
      stagedAt: "2026-08-09T00:00:00.000Z",
    },
  };
  const previousMcpRuntime = {
    source: "managed" as const,
    revision: previous.revision,
    releaseId: "deploy-previous",
    artifactDigest: "2".repeat(64),
    stagedAt: "2026-08-08T00:00:00.000Z",
  };
  const writerReady = (revision: string) => hotStateSqliteWriterReady(state, {
    LLV_VIEWER_DEPLOY_TARGET: targetFile,
    [HOT_STATE_RELEASE_REVISION_ENV]: revision,
  });
  previousWriterReady = () => writerReady(previous.revision);
  const dockerScript = `#!/bin/sh
set -eu
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'running\n'; exit 0; fi
if [ "$1" = "start" ]; then exit 0; fi
exit 1
`;
  try {
    let originalAuthority: ReturnType<typeof readHotStateAuthority> = null;
    const crashed = await runAction({
      action: "promote",
      input: { candidate },
      sandbox,
      preserveSandbox: true,
      snapshots: [previous.container],
      environment: { NODE_ENV: "test", LLV_TEST_EXIT_AFTER_HOT_STATE_AUTHORITY: "1" },
      setupState: (directory) => {
        initializeHotStateFixture(directory, previous);
        const authority = readHotStateAuthority(directory)!;
        originalAuthority = markViewerReleaseReady(
          directory,
          markHotStateActivationReady(directory, authority),
        );
      },
      dockerScript,
    });
    expect(crashed.code).toBe(86);
    expect(crashed.target).toEqual(previous);
    expect(crashed.authority).toMatchObject({ mode: "sqlite", releaseRevision: candidate.revision });
    expect(crashed.releaseSwitchIntentExists).toBe(true);
    expect(writerReady(previous.revision)).toBe(false);
    expect(writerReady(candidate.revision)).toBe(false);

    expect(previousWriterReady()).toBe(false);
    const recovered = await runAction({
      action: "rollback",
      input: { previous, candidate, previousMcpRuntime },
      sandbox,
      preserveSandbox: true,
      dockerScript,
    });
    expect({ code: recovered.code, stderr: recovered.stderr }).toEqual({ code: 0, stderr: "" });
    expect(recovered.target).toEqual(previous);
    expect(recovered.releaseSwitchIntentExists).toBe(false);
    expect(recovered.authority).toMatchObject({
      mode: "sqlite",
      releaseRevision: previous.revision,
      activationReadyAt: originalAuthority!.activationReadyAt,
      releaseReadyAt: originalAuthority!.releaseReadyAt,
    });
    expect(previousWriterReady()).toBe(true);
    expect(writerReady(candidate.revision)).toBe(false);
  } finally {
    server.stop(true);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rollback retains the SQLite target when mirror checkpointing fails", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/deployments/capabilities/v1") {
        return Response.json(
          { capability: "viewer-deployments", version: 1, registryBackendMode: "off" },
          { headers: { connection: "close" } },
        );
      }
      if (pathname === "/_next/static/app.js") return new Response("self.__viewer=true", { headers: { connection: "close" } });
      return new Response('<script src="/_next/static/app.js"></script>', {
        headers: { connection: "close", "content-type": "text/html" },
      });
    },
  });
  const candidate = { ...release, hotStateBackend: HOT_STATE_BACKEND };
  const previous = {
    ...release,
    revision: "8".repeat(40),
    container: "viewer-legacy",
    image: "viewer:legacy",
    endpoint: `http://127.0.0.1:${server.port}`,
  };
  const previousMcpRuntime = {
    source: "legacy",
    revision: previous.revision,
    releaseId: null,
    artifactDigest: "8".repeat(64),
    stagedAt: null,
  };
  try {
    const result = await runAction({
      action: "rollback",
      input: { previous, candidate, previousMcpRuntime },
      snapshots: [previous.container],
      setupState: (state) => {
        initializeHotStateFixture(state, candidate);
        const mirror = path.join(state, "flows.json");
        fs.rmSync(mirror, { force: true });
        fs.mkdirSync(mirror);
      },
      dockerScript: `#!/bin/sh
set -eu
if [ "$1 $2" = "container inspect" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'running\n'; exit 0; fi
if [ "$1" = "start" ]; then exit 0; fi
exit 1
`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("flows.json");
    expect(result.target).toEqual(candidate);
    expect(result.authority).toMatchObject({ mode: "sqlite", releaseRevision: candidate.revision });
  } finally {
    server.stop(true);
  }
});
