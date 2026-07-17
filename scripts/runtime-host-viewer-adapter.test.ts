import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { viewerComposeSnapshotName } from "../src/runtime-host/deploymentArtifacts";

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
      ...process.env,
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
        user: "1000:1000",
        volumes: [],
        working_dir: "/app",
      },
    },
  });
}

async function runAction(options: {
  action: "retain-only" | "rollback";
  input: unknown;
  dockerScript: string;
  snapshots?: string[];
}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-lifecycle-adapter-"));
  const state = path.join(sandbox, "state");
  const bin = path.join(sandbox, "bin");
  const dockerLog = path.join(sandbox, "docker.log");
  fs.mkdirSync(path.join(state, "deployments", "compose"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
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
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: dockerLog,
      LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1",
      LLV_STATE_DIR: state,
      LLV_VIEWER_PORT: "1",
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
  fs.rmSync(sandbox, { recursive: true, force: true });
  return { code, stdout, stderr, dockerCalls, target };
}

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

test("rollback starts and health-checks the retained release before switching the stable target", async () => {
  let probes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      probes += 1;
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/deployments/capabilities/v1") {
        return Response.json({ capability: "viewer-deployments", version: 1 });
      }
      if (pathname === "/_next/static/app.js") return new Response("self.__viewer=true");
      return new Response('<script src="/_next/static/app.js"></script>', { headers: { "content-type": "text/html" } });
    },
  });
  const previous = {
    ...release,
    container: "viewer-rollback",
    image: "viewer:rollback",
    endpoint: `http://127.0.0.1:${server.port}`,
  };
  try {
    const result = await runAction({
      action: "rollback",
      input: { previous, candidate: release },
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

    expect(result.code).toBe(0);
    expect(result.dockerCalls).toContain("start viewer-rollback");
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(result.target).toEqual(previous);
  } finally {
    server.stop(true);
  }
});
