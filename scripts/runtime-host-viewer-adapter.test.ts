import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
