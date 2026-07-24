import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WAKATIME_CREDENTIAL_ENV, withoutWakatimeCredential } from "../src/lib/wakatime/credential";
import { viewerComposeSnapshotName } from "../src/runtime-host/deploymentArtifacts";
import { RuntimeHost } from "../src/runtime-host/host";
import { RuntimeJournal } from "../src/runtime-host/journal";
import { serveRuntimeHost } from "../src/runtime-host/socket";

const root = path.resolve(import.meta.dir, "..");
const adapter = path.join(root, "scripts", "runtime-host-viewer-adapter.ts");
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
  action: "promote" | "retain-only" | "rollback" | "complete-host-handoff" | "reconcile-mcp-runtime";
  input: unknown;
  dockerScript: string;
  snapshots?: string[];
  handoffIntent?: Record<string, unknown>;
  environment?: Record<string, string>;
}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-lifecycle-adapter-"));
  const state = path.join(sandbox, "state");
  const bin = path.join(sandbox, "bin");
  const dockerLog = path.join(sandbox, "docker.log");
  fs.mkdirSync(path.join(state, "deployments", "compose"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
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
  const code = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const dockerCalls = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, "utf8").trim().split("\n") : [];
  const targetFile = path.join(state, "viewer-release.json");
  const target = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, "utf8")) as unknown : null;
  const handoffIntentExists = fs.existsSync(path.join(state, "runtime-host-handoff-intent.json"));
  fs.rmSync(sandbox, { recursive: true, force: true });
  return { code, stdout, stderr, dockerCalls, target, handoffIntentExists };
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

async function runReconcile(fixture: ReturnType<typeof successorPackage>, options: { revision: string; socketPath?: string }) {
  const child = Bun.spawn([process.execPath, adapter, "reconcile-mcp-runtime"], {
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
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({ revision: options.revision })}\n`);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("the first successor boot publishes and probes the MCP runtime after an old adapter deployment", async () => {
  const revision = "7".repeat(40);
  const fixture = successorPackage("llv-mcp-successor-reconcile-", { revision });
  const socketPath = path.join(fixture.state, "runtime-host.sock");
  const journal = new RuntimeJournal(path.join(fixture.state, "runtime.sqlite"));
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const { code, stdout, stderr } = await runReconcile(fixture, { revision, socketPath });

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
    expect(result.health.tools).toHaveLength(23);
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
    const reboot = await runReconcile(fixture, { revision, socketPath });

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
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_COMPOSE: composeSnapshot(),
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
