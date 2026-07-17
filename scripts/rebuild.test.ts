import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxes: string[] = [];
const rebuildScript = path.join(import.meta.dir, "rebuild.sh");

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rebuild-test-"));
  sandboxes.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const capture = path.join(root, "request.json");
  const args = path.join(root, "request.args");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".config", "agent-log-viewer"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "agent-log-viewer", "service.env"), "");
  const curl = path.join(bin, "curl");
  fs.writeFileSync(curl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "$LLV_TEST_ARGS"
body=""
has_write=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) body="$2"; shift 2 ;;
    -w) has_write=1; shift 2 ;;
    -H|--max-time) shift 2 ;;
    -sS|-fsS) shift ;;
    *) shift ;;
  esac
done
if [ "$has_write" = 1 ]; then
  printf '%s' "$body" > "$LLV_TEST_CAPTURE"
  printf '{"state":"accepted","deploymentId":"deploy_test"}\\n202'
else
  printf '{"phase":"succeeded","terminal":true}'
fi
`, { mode: 0o755 });
  return { root, bin, home, capture, args };
}

function runRebuild(idempotencyKey: string, setup: ReturnType<typeof fixture>, revision?: string) {
  return Bun.spawnSync(["bash", rebuildScript, ...(revision ? [revision] : [])], {
    cwd: setup.root,
    env: {
      ...process.env,
      HOME: setup.home,
      PATH: `${setup.bin}:${process.env.PATH ?? ""}`,
      PORT: "18898",
      LLV_DEPLOY_IDEMPOTENCY_KEY: idempotencyKey,
      LLV_TEST_CAPTURE: setup.capture,
      LLV_TEST_ARGS: setup.args,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("rebuild accepts an exact revision as its positional argument", () => {
  const setup = fixture();
  const revision = "a".repeat(40);
  const result = runRebuild("exact-revision", setup, revision);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision,
    idempotencyKey: "exact-revision",
  });
});

test("rebuild serializes a quoted 200-character idempotency key as JSON", () => {
  const setup = fixture();
  const prefix = 'release"1\\';
  const idempotencyKey = prefix + "x".repeat(200 - prefix.length);
  const result = runRebuild(idempotencyKey, setup);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: "origin/main",
    idempotencyKey,
  });
});

test("rebuild rejects an idempotency key above the coordinator limit", () => {
  const setup = fixture();
  const result = runRebuild("x".repeat(201), setup);

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("invalid deployment idempotency key");
  expect(fs.existsSync(setup.capture)).toBe(false);
});

test("rebuild keeps the Viewer credential out of loopback request arguments", () => {
  const setup = fixture();
  const token = "viewer-secret?with&reserved=characters";
  fs.writeFileSync(path.join(setup.home, ".config", "agent-log-viewer", "service.env"), `LLV_TOKEN=${token}\n`);

  const result = runRebuild("credential-free-request", setup);
  const args = fs.readFileSync(setup.args, "utf8");

  expect(result.exitCode).toBe(0);
  expect(args).not.toContain(token);
  expect(args).not.toContain("?k=");
  expect(args).toContain("http://127.0.0.1:18898/api/runtime/deployments");
  expect(args).toContain("http://127.0.0.1:18898/api/runtime/deployments/deploy_test");
});
