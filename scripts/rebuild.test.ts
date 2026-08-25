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
  const gitArgs = path.join(root, "git.args");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".config", "agent-log-viewer"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "agent-log-viewer", "service.env"), "");
  /* The canonical main tip is read machine-to-machine (#1033); the stub stands
     in for the network so the test asserts what the script posts. */
  const git = path.join(bin, "git");
  fs.writeFileSync(git, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "$LLV_TEST_GIT_ARGS"
if [ -n "\${LLV_TEST_LS_REMOTE_FAILS:-}" ]; then exit 128; fi
printf '%s' "\${LLV_TEST_LS_REMOTE:-}"
`, { mode: 0o755 });
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
  return { root, bin, home, capture, args, gitArgs };
}

const CANONICAL_REMOTE = "https://canonical.invalid/live-log-viewer-next.git";
const MAIN_TIP = "b".repeat(40);

function runRebuild(
  idempotencyKey: string,
  setup: ReturnType<typeof fixture>,
  revision?: string,
  options: { lsRemote?: string | null } = {},
) {
  const lsRemote = options.lsRemote === undefined ? `${MAIN_TIP}\trefs/heads/main\n` : options.lsRemote;
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
      LLV_TEST_GIT_ARGS: setup.gitArgs,
      LLV_VIEWER_CANONICAL_REMOTE: CANONICAL_REMOTE,
      ...(lsRemote === null ? { LLV_TEST_LS_REMOTE_FAILS: "1" } : { LLV_TEST_LS_REMOTE: lsRemote }),
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

for (const [name, revision] of [
  ["39 lowercase hex characters", "a".repeat(39)],
  ["41 lowercase hex characters", "a".repeat(41)],
  ["uppercase hex", "A".repeat(40)],
  ["embedded whitespace", `${"a".repeat(20)} ${"b".repeat(19)}`],
  ["a ref-like value", "refs/heads/main"],
  ["an embedded newline", `${"a".repeat(20)}\n${"b".repeat(20)}`],
  ["an embedded carriage return", `${"a".repeat(20)}\r${"b".repeat(20)}`],
] as const) {
  test(`rebuild rejects ${name} before deployment admission`, () => {
    const setup = fixture();
    const result = runRebuild("invalid-revision", setup, revision);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("invalid revision");
    expect(fs.existsSync(setup.capture)).toBe(false);
  });
}

test("rebuild serializes a quoted 200-character idempotency key as JSON", () => {
  const setup = fixture();
  const prefix = 'release"1\\';
  const idempotencyKey = prefix + "x".repeat(200 - prefix.length);
  const result = runRebuild(idempotencyKey, setup);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: MAIN_TIP,
    idempotencyKey,
  });
});

test("a bare rebuild reads the canonical main tip itself and posts the resolved SHA", () => {
  const setup = fixture();
  const result = runRebuild("refless-deploy", setup);

  expect(result.exitCode).toBe(0);
  expect(fs.readFileSync(setup.gitArgs, "utf8").split("\n").filter(Boolean)).toEqual([
    "ls-remote",
    CANONICAL_REMOTE,
    "refs/heads/main",
  ]);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: MAIN_TIP,
    idempotencyKey: "refless-deploy",
  });
  expect(result.stdout.toString()).toContain(`resolved refs/heads/main at ${CANONICAL_REMOTE}: ${MAIN_TIP}`);
});

test("an explicit origin/main argument resolves the same way as a bare invocation", () => {
  const setup = fixture();
  const result = runRebuild("explicit-origin-main", setup, "origin/main");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: MAIN_TIP,
    idempotencyKey: "explicit-origin-main",
  });
});

test("a pinned SHA deploy never consults the remote", () => {
  const setup = fixture();
  const revision = "c".repeat(40);
  const result = runRebuild("pinned-sha", setup, revision);

  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(setup.gitArgs)).toBe(false);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({ revision, idempotencyKey: "pinned-sha" });
});

for (const [name, lsRemote] of [
  ["the remote is unreachable", null],
  ["the branch is absent", ""],
  ["the tip is not a full SHA", "not-a-sha\trefs/heads/main\n"],
] as const) {
  test(`rebuild refuses to deploy when ${name}`, () => {
    const setup = fixture();
    const result = runRebuild("unresolvable-main", setup, undefined, { lsRemote });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(CANONICAL_REMOTE);
    expect(fs.existsSync(setup.capture)).toBe(false);
  });
}

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
