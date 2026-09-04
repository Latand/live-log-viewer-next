import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(sequence: string[], deadline = "310s") {
  const root = mkdtempSync(join(tmpdir(), "audit-retry-"));
  roots.push(root);
  for (const dir of ["bin", "home", "config", "state", "claude", "codex", "tmp", "scripts", "security"]) {
    mkdirSync(join(root, dir));
  }
  copyFileSync(join(import.meta.dir, "audit-with-retry.sh"), join(root, "scripts/audit-with-retry.sh"));
  writeFileSync(join(root, "security/audit-allowlist.json"), JSON.stringify([
    { id: "GHSA-aaaa-bbbb-cccc", reason: "Synthetic test exception", expires: "2999-12-31" },
    { id: "CVE-2099-12345", reason: "Second synthetic test exception", expires: "2999-12-31" },
  ]));
  const env = {
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    LLV_STATE_DIR: join(root, "state"), LLV_CLAUDE_HOME: join(root, "claude"),
    LLV_CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
    AUDIT_TEST_ROOT: root, AUDIT_TEST_BUN: process.execPath,
    AUDIT_TEST_SEQUENCE: JSON.stringify(sequence), AUDIT_TEST_DEADLINE: deadline,
  };
  const shim = (name: string, body: string) => {
    writeFileSync(join(root, "bin", name), `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(join(root, "bin", name), 0o755);
  };
  shim("bun", 'if [[ "$1" == -e ]]; then exec "$AUDIT_TEST_BUN" "$@"; fi\nexec "$AUDIT_TEST_BUN" "$AUDIT_TEST_ROOT/fake.ts" "$@"');
  shim("sleep", 'echo "$1" >> "$AUDIT_TEST_ROOT/sleeps"\nexec /bin/sleep 0.001');
  // Exercise GNU timeout itself with a shorter deadline; record the production
  // arguments before substitution so the bounds are also part of the proof.
  shim("timeout", 'printf "%s\\n" "$*" >> "$AUDIT_TEST_ROOT/deadlines"\nshift 3\nexec /usr/bin/timeout --foreground --kill-after=0.1s "$AUDIT_TEST_DEADLINE" "$@"');
  writeFileSync(join(root, "fake.ts"), `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const root = process.env.AUDIT_TEST_ROOT!;
const calls = root + "/calls";
const count = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\\n").length : 0;
appendFileSync(calls, JSON.stringify(process.argv.slice(2)) + "\\n");
const sequence = JSON.parse(process.env.AUDIT_TEST_SEQUENCE!);
const scenario = sequence[Math.min(count, sequence.length - 1)];
console.error("\\x1b[0m\\x1b[1mbun audit \\x1b[0m\\x1b[2mv1.3.3 (fixture)\\x1b[0m");
if (scenario === "success") { console.log("No vulnerabilities found"); process.exit(0); }
if (scenario === "timeout") { console.error("Timeout: audit request failed"); process.exit(1); }
if (scenario === "503") { console.error("error: audit request failed (status 503)"); process.exit(1); }
if (scenario === "unknown") { console.error("error: invalid lockfile"); process.exit(42); }
if (scenario === "403") { console.error("error: audit request failed (status 403)"); process.exit(1); }
if (scenario === "mixed") { console.error("Timeout: audit request failed"); console.error("error: invalid lockfile"); process.exit(1); }
if (scenario === "signal") { process.kill(process.pid, "SIGTERM"); await Bun.sleep(1000); }
if (scenario === "hang" || scenario === "resist") {
  if (scenario === "resist") process.on("SIGTERM", () => {});
  writeFileSync(root + "/pid", String(process.pid));
  setInterval(() => {}, 1000);
} else {
  console.log("fixture-package  <2.0.0\\n  high: Timeout: audit request failed\\n  https://github.com/advisories/GHSA-aaaa-bbbb-cccc\\n\\n\\x1b[1m1 vulnerabilities (1 \\x1b[31mhigh\\x1b[0m)");
  process.exit(1);
}
`);
  const lines = (file: string) => existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").trim().split("\n") : [];
  const start = (script = 'bash scripts/audit-with-retry.sh --audit-level=high "--ignore=GHSA-aaaa-bbbb-cccc"') => {
    const child = Bun.spawn(["/bin/bash", "-c", script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { child, async result() {
      const status = await child.exited;
      const [stdout, stderr] = await output;
      return { status, text: stdout + stderr, calls: lines("calls").map(line => JSON.parse(line) as string[]), sleeps: lines("sleeps"), deadlines: lines("deadlines") };
    } };
  };
  return { root, start };
}

for (const sequence of [["success"], ["timeout", "success"], ["timeout", "503", "success"]]) {
  test(`audit succeeds after ${sequence.length} attempt(s)`, async () => {
    const result = await fixture(sequence).start().result();
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(sequence.length);
    expect(result.sleeps).toEqual(["5", "10"].slice(0, sequence.length - 1));
    for (const args of result.calls) expect(args).toEqual(["audit", "--audit-level=high", "--ignore=GHSA-aaaa-bbbb-cccc"]);
    for (const deadline of result.deadlines) expect(deadline).toStartWith("--foreground --kill-after=5s 310s bun audit ");
  });
}

test("exhausted transport errors block with an unreachable classification", async () => {
  const result = await fixture(["timeout"]).start().result();
  expect(result.status).toBe(1);
  expect(result.calls).toHaveLength(3);
  expect(result.sleeps).toEqual(["5", "10"]);
  expect(result.text).toContain("Advisory service unreachable after 3 attempts");
  expect(result.text).not.toContain("reported high/critical");
});

for (const statuses of [[503, 200], [503, 503, 503], [403]]) {
  test(`real Bun advisory endpoint responds with ${statuses.join(" then ")}`, async () => {
    const f = fixture([], "2s");
    // Keep Bun's actual output and HTTP request path in the regression. Only
    // backoff duration and the outer deadline are shortened by fixture shims.
    writeFileSync(join(f.root, "bin/bun"), '#!/bin/bash\nexec "$AUDIT_TEST_BUN" "$@"\n');
    for (const file of ["package.json", "bun.lock"]) {
      copyFileSync(join(import.meta.dir, "..", file), join(f.root, file));
    }
    const requests: { method: string; path: string; body: string }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const bytes = Buffer.from(await request.arrayBuffer());
        const body = request.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes).toString() : bytes.toString();
        requests.push({ method: request.method, path: new URL(request.url).pathname, body });
        return Response.json({}, { status: statuses[Math.min(requests.length - 1, statuses.length - 1)] });
      },
    });
    try {
      const result = await f.start(`bash scripts/audit-with-retry.sh --audit-level=high --registry=http://127.0.0.1:${server.port}`).result();
      expect(result.status).toBe(statuses.includes(200) ? 0 : 1);
      expect(requests).toHaveLength(statuses.length);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/-/npm/v1/security/advisories/bulk");
        expect(Object.keys(JSON.parse(request.body)).length).toBeGreaterThan(0);
      }
      expect(result.sleeps).toEqual(["5", "10"].slice(0, statuses.length - 1));
      expect(result.text).toContain(statuses.includes(200) ? "Dependency audit passed" : statuses[0] === 403 ? "unrecognized error" : "Advisory service unavailable after 3 attempts");
    } finally {
      await server.stop(true);
    }
  });
}

for (const [scenario, status] of [["advisory", 1], ["unknown", 42], ["403", 1], ["mixed", 1], ["signal", 143]] as const) {
  test(`${scenario} fails promptly and preserves the child status`, async () => {
    const result = await fixture([scenario, "success"]).start().result();
    expect(result.status).toBe(status);
    expect(result.calls).toHaveLength(1);
    expect(result.sleeps).toEqual([]);
    expect(result.text).not.toContain("service unreachable");
    expect(result.text).toContain(scenario === "advisory" ? "reported high/critical advisories" : scenario === "signal" ? "was terminated" : "unrecognized error");
  });
}

test("a transport retry followed by advisories stops immediately", async () => {
  const result = await fixture(["timeout", "advisory", "success"]).start().result();
  expect(result.status).toBe(1);
  expect(result.calls).toHaveLength(2);
  expect(result.sleeps).toEqual(["5"]);
  expect(result.text).toContain("reported high/critical advisories");
});

for (const scenario of ["hang", "resist"]) {
  test(`outer deadline reaps a ${scenario} child and fails closed`, async () => {
    const f = fixture([scenario], "0.2s");
    const result = await f.start().result();
    expect([124, 137]).toContain(result.status);
    expect(result.calls).toHaveLength(1);
    expect(result.sleeps).toEqual([]);
    expect(result.text).toContain("execution timed out or was terminated");
    const pid = Number(readFileSync(join(f.root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
}

for (const scenario of ["hang", "resist"]) {
  test(`wrapper cancellation terminates and waits for its ${scenario} child`, async () => {
    const f = fixture([scenario]);
    const run = f.start("exec bash scripts/audit-with-retry.sh --audit-level=high");
    try {
      for (let i = 0; i < 200 && !existsSync(join(f.root, "pid")); i++) await Bun.sleep(10);
      expect(existsSync(join(f.root, "pid"))).toBe(true);
      run.child.kill("SIGTERM");
      const result = await run.result();
      expect(result.status).toBe(143);
      expect(result.calls).toHaveLength(1);
      expect(result.text).toContain("execution interrupted");
      expect(() => process.kill(Number(readFileSync(join(f.root, "pid"), "utf8")), 0)).toThrow();
    } finally {
      if (run.child.exitCode === null) run.child.kill("SIGTERM");
      await run.child.exited;
    }
  });

}

function auditStep(workflow: string): string {
  const source = readFileSync(join(import.meta.dir, "../.github/workflows", workflow), "utf8");
  const step = source.split(/\n      - /).find(part => part.startsWith("name: Audit "))!;
  expect(step).toBeDefined();
  return step.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");
}

for (const workflow of ["supply-chain.yml", "publish.yml"]) {
  test(`${workflow} executes the wrapper with its validated allowlist`, async () => {
    const result = await fixture(["timeout", "success"]).start(auditStep(workflow)).result();
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(Array(2).fill(["audit", "--audit-level=high", "--ignore=GHSA-aaaa-bbbb-cccc", "--ignore=CVE-2099-12345"]));
    expect(result.sleeps).toEqual(["5"]);
  });
  test(`${workflow} rejects an expired allowlist before any audit`, async () => {
    const f = fixture(["success"]);
    writeFileSync(join(f.root, "security/audit-allowlist.json"), JSON.stringify([
      { id: "CVE-2000-12345", reason: "Expired fixture", expires: "2000-01-01" },
    ]));
    const result = await f.start(auditStep(workflow)).result();
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.text).toContain("expired on");
  });
}

for (const diagnostic of ["ConnectionRefused", "ConnectionReset", "ConnectionClosed", "FailedToOpenSocket"]) {
  test(`${diagnostic} is retried only as a standalone request failure`, async () => {
    const f = fixture(["success"]);
    writeFileSync(join(f.root, "fake.ts"), `console.error("bun audit v1.3.3 (fixture)"); console.error("${diagnostic}: audit request failed"); process.exit(1);`);
    const result = await f.start().result();
    expect(result.status).toBe(1);
    expect(result.deadlines).toHaveLength(3);
    expect(result.sleeps).toEqual(["5", "10"]);
    expect(result.text).toContain("unreachable after 3 attempts");
  });
}

test("a missing audit executable fails once and preserves exit 127", async () => {
  const f = fixture(["success"]);
  rmSync(join(f.root, "bin/bun"));
  const result = await f.start().result();
  expect(result.status).toBe(127);
  expect(result.deadlines).toHaveLength(1);
  expect(result.sleeps).toEqual([]);
  expect(result.text).toContain("unrecognized error");
});

test("exhausted HTTP service errors are classified as unavailable", async () => {
  const result = await fixture(["503"]).start().result();
  expect(result.status).toBe(1);
  expect(result.calls).toHaveLength(3);
  expect(result.text).toContain("Advisory service unavailable after 3 attempts");
  expect(result.text).not.toContain("service unreachable");
});
