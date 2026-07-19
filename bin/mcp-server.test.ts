import { afterEach, expect, test } from "bun:test";
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
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const child = Bun.spawn({
    cmd: [node, launcher],
    cwd: root,
    env: { ...process.env, ...env, LLV_BUN_EXECUTABLE: bun },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write("initialize-handshake\n");
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

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
