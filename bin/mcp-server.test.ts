import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function installedPackage(serverSource = `
  process.stdout.write(JSON.stringify({ bun: process.versions.bun ?? null }) + "\\n");
  process.stdin.pipe(process.stdout);
`): { root: string; launcher: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-installed-mcp-"));
  sandboxes.push(root);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dir, "mcp-server.mjs"), path.join(root, "bin", "mcp-server.mjs"));
  fs.copyFileSync(path.join(import.meta.dir, "server-runtime.mjs"), path.join(root, "bin", "server-runtime.mjs"));
  fs.writeFileSync(path.join(root, "dist", "mcp-server.mjs"), serverSource, "utf8");
  return { root, launcher: path.join(root, "bin", "mcp-server.mjs") };
}

async function launchInstalled(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { root, launcher } = installedPackage();
  return launchFrom(root, launcher, env, "initialize-handshake\n");
}

async function launchFrom(
  root: string,
  launcher: string,
  env: Record<string, string>,
  input: string,
  runtime: "node" | "bun" = "node",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const child = Bun.spawn({
    cmd: [runtime === "bun" ? bun : node, launcher],
    cwd: root,
    env: { ...process.env, ...env, LLV_BUN_EXECUTABLE: bun },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(input);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("fresh Claude and Codex hosts load the exact MCP runtime named by the promoted release", async () => {
  const previousRevision = "8".repeat(40);
  const candidateRevision = "7".repeat(40);
  const { root, launcher } = installedPackage(`
    process.stdout.write(JSON.stringify({
      revision: "${previousRevision}",
      tools: ["deploy_exact_sha", "get_pipeline"],
      host: process.env.LLV_TEST_HOST,
    }) + "\\n");
    process.stdin.pipe(process.stdout);
  `);
  const stateDir = path.join(root, "state");
  const releaseId = `deploy-${candidateRevision}`;
  const releaseRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId);
  const candidateBundle = `
    process.stdout.write(JSON.stringify({
      revision: "${candidateRevision}",
      tools: ["deployment_status", "board_snapshot"],
      host: process.env.LLV_TEST_HOST,
    }) + "\\n");
    process.stdin.pipe(process.stdout);
  `;
  fs.mkdirSync(path.join(releaseRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), candidateBundle, "utf8");
  const targetFile = path.join(root, "targets", "viewer-release.json");
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify({
    revision: candidateRevision,
    image: `viewer:${candidateRevision}`,
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    mcpRuntime: {
      source: "managed",
      revision: candidateRevision,
      releaseId,
      artifactDigest: createHash("sha256").update(candidateBundle).digest("hex"),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  }), "utf8");

  for (const host of ["claude", "codex"]) {
    const result = await launchFrom(root, launcher, {
      LLV_TEST_HOST: host,
      LLV_STATE_DIR: stateDir,
      LLV_VIEWER_DEPLOY_TARGET: targetFile,
    }, `${host}-initialize\n`, "bun");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const [runtime, handshake] = result.stdout.trim().split("\n");
    expect(JSON.parse(runtime!)).toEqual({
      revision: candidateRevision,
      tools: ["deployment_status", "board_snapshot"],
      host,
    });
    expect(handshake).toBe(`${host}-initialize`);
  }
}, 15_000);

test("a fresh host rejects a managed MCP runtime whose bundle differs from the published digest", async () => {
  const revision = "7".repeat(40);
  const { root, launcher } = installedPackage();
  const stateDir = path.join(root, "state");
  const releaseId = `deploy-${revision}`;
  const releaseRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId);
  fs.mkdirSync(path.join(releaseRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), "process.stdout.write('tampered\\n');", "utf8");
  const targetFile = path.join(stateDir, "viewer-release.json");
  fs.writeFileSync(targetFile, JSON.stringify({
    revision,
    image: `viewer:${revision}`,
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    mcpRuntime: {
      source: "managed",
      revision,
      releaseId,
      artifactDigest: "a".repeat(64),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  }), "utf8");

  const result = await launchFrom(root, launcher, {
    LLV_STATE_DIR: stateDir,
    LLV_VIEWER_DEPLOY_TARGET: targetFile,
  }, "", "bun");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("MCP runtime bundle digest does not match the active release");
});

test("an existing malformed release target fails closed instead of loading the legacy runtime", async () => {
  const { root, launcher } = installedPackage("process.stdout.write('legacy\\n');");
  const stateDir = path.join(root, "state");
  const targetFile = path.join(stateDir, "viewer-release.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(targetFile, "{}\n", "utf8");

  const result = await launchFrom(root, launcher, {
    LLV_STATE_DIR: stateDir,
    LLV_VIEWER_DEPLOY_TARGET: targetFile,
  }, "", "bun");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("active Viewer release target is invalid");
});

test("the installed MCP launcher selects Bun for Bun-only Viewer configuration and preserves stdio", async () => {
  const configurations: Record<string, string>[] = [
    { LLV_AGENT_REGISTRY_SQLITE: "read" },
    { LLV_STRUCTURED_HOSTS: "1" },
  ];
  for (const env of configurations) {
    const result = await launchInstalled(env);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const [runtime, handshake] = result.stdout.trim().split("\n");
    expect(JSON.parse(runtime!)).toMatchObject({ bun: expect.any(String) });
    expect(handshake).toBe("initialize-handshake");
  }
}, 15_000);

test("the installed MCP launcher forwards termination to its Bun child", async () => {
  const readyPath = path.join(os.tmpdir(), `llv-mcp-ready-${crypto.randomUUID()}`);
  const signalPath = path.join(os.tmpdir(), `llv-mcp-signal-${crypto.randomUUID()}`);
  sandboxes.push(readyPath, signalPath);
  const { root, launcher } = installedPackage(`
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.LLV_TEST_READY, "ready\\n", "utf8");
    process.once("SIGTERM", () => {
      fs.writeFileSync(process.env.LLV_TEST_SIGNAL, "SIGTERM\\n", "utf8");
      process.exit(0);
    });
    setInterval(() => {}, 1_000);
  `);
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const child = Bun.spawn({
    cmd: [node, launcher],
    cwd: root,
    env: {
      ...process.env,
      LLV_STRUCTURED_HOSTS: "1",
      LLV_BUN_EXECUTABLE: bun,
      LLV_TEST_READY: readyPath,
      LLV_TEST_SIGNAL: signalPath,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyPath)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the Bun MCP child");
    await Bun.sleep(5);
  }
  child.kill("SIGTERM");
  await child.exited;
  expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
}, 15_000);

test("the installed MCP launcher forwards escalating signals until its Bun child exits", async () => {
  const readyPath = path.join(os.tmpdir(), `llv-mcp-ready-${crypto.randomUUID()}`);
  const signalPath = path.join(os.tmpdir(), `llv-mcp-signals-${crypto.randomUUID()}`);
  sandboxes.push(readyPath, signalPath);
  const { root, launcher } = installedPackage(`
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.LLV_TEST_READY, "ready\\n", "utf8");
    process.on("SIGINT", () => fs.appendFileSync(process.env.LLV_TEST_SIGNAL, "SIGINT\\n", "utf8"));
    process.on("SIGTERM", () => {
      fs.appendFileSync(process.env.LLV_TEST_SIGNAL, "SIGTERM\\n", "utf8");
      process.exit(0);
    });
    setTimeout(() => process.exit(7), 1_500);
    setInterval(() => {}, 1_000);
  `);
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const child = Bun.spawn({
    cmd: [node, launcher],
    cwd: root,
    env: {
      ...process.env,
      LLV_STRUCTURED_HOSTS: "1",
      LLV_BUN_EXECUTABLE: bun,
      LLV_TEST_READY: readyPath,
      LLV_TEST_SIGNAL: signalPath,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyPath)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the Bun MCP child");
    await Bun.sleep(5);
  }
  child.kill("SIGINT");
  while (!fs.existsSync(signalPath) || !fs.readFileSync(signalPath, "utf8").includes("SIGINT\n")) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for SIGINT forwarding");
    await Bun.sleep(5);
  }
  child.kill("SIGTERM");
  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGINT\nSIGTERM\n");
}, 15_000);
