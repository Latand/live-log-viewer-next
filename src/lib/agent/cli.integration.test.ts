import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { buildPipeline, PIPELINES_SCHEMA_VERSION } from "@/lib/pipelines/store";
import { prepareClaudeIntegrationTestHome, prepareCodexIntegrationTestHome } from "@/lib/runtime/integrationTestHome";

import { freshSpecFor, shellQuote } from "./cli";

const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";
const defaultHome = prepareCodexIntegrationTestHome(codexBinary);
const customHome = prepareCodexIntegrationTestHome(codexBinary);
const layeredHome = prepareCodexIntegrationTestHome(codexBinary);
const claudeBinary = process.env.LLV_CLAUDE_BINARY ?? "claude";
const claudeProjectHome = prepareClaudeIntegrationTestHome(claudeBinary);

afterAll(() => {
  defaultHome?.cleanup();
  customHome?.cleanup();
  layeredHome?.cleanup();
  claudeProjectHome?.cleanup();
});

function processIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return `${pid}:${fields[19] ?? ""}`;
  } catch {
    return null;
  }
}

function processTree(rootPid: number): Map<number, string> {
  const identities = new Map<number, string>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (identities.has(pid)) continue;
    const identity = processIdentity(pid);
    if (!identity) continue;
    identities.set(pid, identity);
    try {
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      for (const child of children.split(/\s+/)) if (child) pending.push(Number(child));
    } catch { /* the process exited during the snapshot */ }
  }
  return identities;
}

function addRecordedProcess(processes: Map<number, string>, markerPath: string): void {
  const pid = Number(fs.readFileSync(markerPath, "utf8"));
  const identity = processIdentity(pid);
  if (!Number.isInteger(pid) || !identity) throw new Error(`recorded MCP process is unavailable: ${markerPath}`);
  for (const [childPid, childIdentity] of processTree(pid)) processes.set(childPid, childIdentity);
}

async function expectProcessesReaped(processes: ReadonlyMap<number, string>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ([...processes].every(([pid, identity]) => processIdentity(pid) !== identity)) return;
    await Bun.sleep(25);
  }
  const survivors = [...processes].filter(([pid, identity]) => processIdentity(pid) === identity).map(([pid]) => pid);
  throw new Error(`tmux MCP processes survived shutdown: ${survivors.join(",")}`);
}

async function runTmux(tmuxTmpdir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["tmux", ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function filesBelow(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function waitFor<T>(read: () => T | null, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(100);
  }
  throw new Error("native tmux MCP fixture timed out");
}

function nativeClaudeMcpResult(filename: string, server: string, pipelineId: string): string | null {
  if (!fs.existsSync(filename)) return null;
  const toolUseIds = new Set<string>();
  for (const line of fs.readFileSync(filename, "utf8").split("\n")) {
    try {
      const event = JSON.parse(line) as {
        message?: { content?: Array<{ type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown; content?: unknown }> };
      };
      if (!Array.isArray(event.message?.content)) continue;
      for (const content of event.message.content) {
        if (content.type === "tool_use"
          && content.name === `mcp__${server}__get_pipeline`
          && typeof content.id === "string") toolUseIds.add(content.id);
        if (content.type !== "tool_result"
          || typeof content.tool_use_id !== "string"
          || !toolUseIds.has(content.tool_use_id)) continue;
        const serialized = JSON.stringify(content.content);
        if (serialized.includes(pipelineId)
          && !serialized.includes("Permission to use")
          && !serialized.includes("has been denied")) return filename;
      }
    } catch { /* a partial transcript line remains pending */ }
  }
  return null;
}

function nativeMcpResult(home: string, server: string, pipelineId: string): string | null {
  for (const filename of filesBelow(path.join(home, "sessions"))) {
    const contents = fs.readFileSync(filename, "utf8");
    for (const line of contents.split("\n")) {
      if (!line.includes('"type":"mcp_tool_call_end"')) continue;
      try {
        const event = JSON.parse(line) as {
          payload?: { invocation?: { server?: string; tool?: string }; result?: unknown };
        };
        if (event.payload?.invocation?.server === server
          && event.payload.invocation.tool === "get_pipeline"
          && JSON.stringify(event.payload.result).includes(pipelineId)) return filename;
      } catch { /* a partial rollout line remains pending */ }
    }
  }
  return null;
}

function configureMcpFixture(home: NonNullable<typeof defaultHome>): {
  pipelineId: string;
  viewerPidPath: string;
  optionalPidPath: string;
  unrelatedPath: string;
} {
  const pipeline = buildPipeline({
    id: `tmux-mcp-${path.basename(home.directory)}`,
    task: "Prove native tmux Codex MCP isolation",
    project: "live-log-viewer-next",
    repoDir: process.cwd(),
    stages: [{
      id: "proof",
      kind: "run",
      "prompt": "Exercise Viewer MCP",
      next: null,
      onFail: null,
      effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-terra", effort: "low", access: "read-only", promptScaffold: null },
    }],
    srcPath: null,
    srcConversationId: null,
    now: "2026-07-23T00:00:00.000Z",
    state: "draft",
  });
  const stateDir = path.join(home.directory, "viewer-state");
  const viewerPidPath = path.join(home.directory, "viewer-pid");
  const optionalPidPath = path.join(home.directory, "optional-pid");
  const unrelatedPath = path.join(home.directory, "unrelated-started");
  const viewerWrapperPath = path.join(home.directory, "viewer-mcp.ts");
  const optionalWrapperPath = path.join(home.directory, "optional-mcp.ts");
  const unrelatedServerPath = path.join(home.directory, "unrelated-mcp.ts");
  const viewerLauncher = path.resolve(import.meta.dir, "../../../bin/mcp-server.mjs");
  const bun = Bun.which("bun") ?? "bun";
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "pipelines.json"), JSON.stringify({
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    pipelines: [pipeline],
  }), { mode: 0o600 });
  const wrapper = (markerPath: string) => [
    `await Bun.write(${JSON.stringify(markerPath)}, String(process.pid));`,
    `const child = Bun.spawn({ cmd: [${JSON.stringify(bun)}, ${JSON.stringify(viewerLauncher)}], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });`,
    'process.on("SIGTERM", () => child.kill("SIGTERM"));',
    'process.on("SIGINT", () => child.kill("SIGINT"));',
    "process.exitCode = await child.exited;",
    "",
  ].join("\n");
  fs.writeFileSync(viewerWrapperPath, wrapper(viewerPidPath), { mode: 0o600 });
  fs.writeFileSync(optionalWrapperPath, wrapper(optionalPidPath), { mode: 0o600 });
  fs.writeFileSync(unrelatedServerPath, `await Bun.write(${JSON.stringify(unrelatedPath)}, String(process.pid));\nprocess.stdin.resume();\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home.codexHome, "config.toml"), [
    "approval_policy = \"never\"",
    "sandbox_mode = \"read-only\"",
    `[projects.${JSON.stringify(process.cwd())}]`,
    'trust_level = "trusted"',
    "[mcp_servers.viewer]",
    `command = ${JSON.stringify(bun)}`,
    `args = [${JSON.stringify(viewerWrapperPath)}]`,
    'default_tools_approval_mode = "approve"',
    "[mcp_servers.viewer.env]",
    `LLV_STATE_DIR = ${JSON.stringify(stateDir)}`,
    "[mcp_servers.agent-browser]",
    `command = ${JSON.stringify(bun)}`,
    `args = [${JSON.stringify(optionalWrapperPath)}]`,
    'default_tools_approval_mode = "approve"',
    "[mcp_servers.agent-browser.env]",
    `LLV_STATE_DIR = ${JSON.stringify(stateDir)}`,
    "[mcp_servers.unrelated]",
    `command = ${JSON.stringify(bun)}`,
    `args = [${JSON.stringify(unrelatedServerPath)}]`,
    "",
  ].join("\n"), { mode: 0o600 });
  return { pipelineId: pipeline.id, viewerPidPath, optionalPidPath, unrelatedPath };
}

async function exerciseTmuxCodex(input: {
  home: NonNullable<typeof defaultHome>;
  mcpServers?: string[];
  expectedServer: "viewer" | "agent-browser";
}): Promise<void> {
  const fixture = configureMcpFixture(input.home);
  const tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-tmux-mcp-"));
  fs.chmodSync(tmuxTmpdir, 0o700);
  const session = `mcp-${crypto.randomUUID().slice(0, 8)}`;
  let processes = new Map<number, string>();
  try {
    const created = await runTmux(tmuxTmpdir, ["new-session", "-d", "-x", "180", "-y", "50", "-s", session, "-c", process.cwd()]);
    if (created.code !== 0) throw new Error(created.stderr || "tmux session creation failed");
    const spec = freshSpecFor("codex", process.cwd(), {
      codexHome: input.home.codexHome,
      model: "gpt-5.6-terra",
      effort: "low",
      readOnly: true,
      mcpServers: input.mcpServers,
    });
    const prompt = `Call the native ${input.expectedServer} MCP tool get_pipeline with clientRequestId "tmux-${input.expectedServer}" and pipelineId "${fixture.pipelineId}". Shell execution is prohibited. Reply after the successful result.`;
    const launched = await runTmux(tmuxTmpdir, ["send-keys", "-t", `${session}:0.0`, "-l", `${spec.command} ${shellQuote(prompt)}`]);
    if (launched.code !== 0) throw new Error(launched.stderr || "tmux command delivery failed");
    await runTmux(tmuxTmpdir, ["send-keys", "-t", `${session}:0.0`, "Enter"]);
    await waitFor(() => nativeMcpResult(input.home.codexHome, input.expectedServer, fixture.pipelineId));
    expect(fs.existsSync(fixture.viewerPidPath)).toBeTrue();
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
    if (input.expectedServer === "viewer") expect(fs.existsSync(fixture.optionalPidPath)).toBeFalse();
    else expect(fs.existsSync(fixture.optionalPidPath)).toBeTrue();
    const pane = await runTmux(tmuxTmpdir, ["display-message", "-p", "-t", `${session}:0.0`, "#{pane_pid}"]);
    const panePid = Number(pane.stdout.trim());
    if (!Number.isInteger(panePid)) throw new Error("tmux pane pid is unavailable");
    processes = processTree(panePid);
    addRecordedProcess(processes, fixture.viewerPidPath);
    if (input.expectedServer === "agent-browser") addRecordedProcess(processes, fixture.optionalPidPath);
    await runTmux(tmuxTmpdir, ["send-keys", "-t", `${session}:0.0`, "C-c"]);
    await Bun.sleep(250);
    await runTmux(tmuxTmpdir, ["kill-server"]);
    await expectProcessesReaped(processes);
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
  } finally {
    await runTmux(tmuxTmpdir, ["kill-server"]);
    fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
  }
}

test.skipIf(!defaultHome)("real default tmux Codex exposes Viewer, excludes other servers, and reaps its MCP processes", async () => {
  if (!defaultHome) throw new Error("isolated Codex subscription home is unavailable");
  await exerciseTmuxCodex({ home: defaultHome, expectedServer: "viewer" });
}, 300_000);

test.skipIf(!layeredHome)("native Codex enumeration enforces the allowlist for trusted project configuration", () => {
  if (!layeredHome) throw new Error("isolated Codex subscription home is unavailable");
  const projectRoot = path.join(layeredHome.directory, "trusted-project");
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(projectRoot, ".codex"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layeredHome.codexHome, "config.toml"), [
    `[projects.${JSON.stringify(projectRoot)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(path.join(projectRoot, ".codex", "config.toml"), [
    "[mcp_servers.project-allowed]",
    'command = "/bin/true"',
    "[mcp_servers.project-unrelated]",
    'command = "/bin/true"',
    "",
  ].join("\n"), { mode: 0o600 });

  const spec = freshSpecFor("codex", projectRoot, {
    codexHome: layeredHome.codexHome,
    mcpServers: ["project-allowed"],
  });

  expect(spec.command).toContain("'mcp_servers.project-allowed.enabled=true'");
  expect(spec.command).toContain("'mcp_servers.project-unrelated.enabled=false'");
});

test.skipIf(!customHome)("real custom tmux Codex enables the optional server, force-enables Viewer, excludes sentinels, and reaps its MCP processes", async () => {
  if (!customHome) throw new Error("isolated Codex subscription home is unavailable");
  await exerciseTmuxCodex({ home: customHome, mcpServers: ["agent-browser"], expectedServer: "agent-browser" });
}, 300_000);

test.skipIf(!claudeProjectHome)("real tmux Claude loads an allowed project MCP server, excludes its project sentinel, and reaps the fleet", async () => {
  if (!claudeProjectHome) throw new Error("isolated Claude subscription home is unavailable");
  const projectRoot = path.join(claudeProjectHome.directory, "project");
  const stateDir = path.join(claudeProjectHome.directory, "viewer-state");
  const viewerPidPath = path.join(claudeProjectHome.directory, "viewer-pid");
  const optionalPidPath = path.join(claudeProjectHome.directory, "optional-pid");
  const unrelatedPath = path.join(claudeProjectHome.directory, "project-unrelated-started");
  const viewerWrapperPath = path.join(claudeProjectHome.directory, "viewer-mcp.ts");
  const optionalWrapperPath = path.join(claudeProjectHome.directory, "optional-mcp.ts");
  const unrelatedServerPath = path.join(claudeProjectHome.directory, "project-unrelated-mcp.ts");
  const viewerLauncher = path.resolve(import.meta.dir, "../../../bin/mcp-server.mjs");
  const bun = Bun.which("bun") ?? "bun";
  const pipeline = buildPipeline({
    id: `tmux-claude-project-${path.basename(claudeProjectHome.directory)}`,
    task: "Prove native tmux Claude project MCP isolation",
    project: "live-log-viewer-next",
    repoDir: projectRoot,
    stages: [{
      id: "proof",
      kind: "run",
      "prompt": "Exercise project MCP",
      next: null,
      onFail: null,
      effectiveRole: { roleId: null, engine: "claude", model: "haiku", effort: "low", access: "read-only", promptScaffold: null },
    }],
    srcPath: null,
    srcConversationId: null,
    now: "2026-07-23T00:00:00.000Z",
    state: "draft",
  });
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "pipelines.json"), JSON.stringify({
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    pipelines: [pipeline],
  }), { mode: 0o600 });
  const wrapper = (markerPath: string) => [
    `await Bun.write(${JSON.stringify(markerPath)}, String(process.pid));`,
    `const child = Bun.spawn({ cmd: [${JSON.stringify(bun)}, ${JSON.stringify(viewerLauncher)}], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });`,
    'process.on("SIGTERM", () => child.kill("SIGTERM"));',
    'process.on("SIGINT", () => child.kill("SIGINT"));',
    "process.exitCode = await child.exited;",
    "",
  ].join("\n");
  fs.writeFileSync(viewerWrapperPath, wrapper(viewerPidPath), { mode: 0o600 });
  fs.writeFileSync(optionalWrapperPath, wrapper(optionalPidPath), { mode: 0o600 });
  fs.writeFileSync(unrelatedServerPath, `await Bun.write(${JSON.stringify(unrelatedPath)}, String(process.pid));\nprocess.stdin.resume();\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(claudeProjectHome.claudeConfigDir, "settings.json"), JSON.stringify({
    enabledMcpjsonServers: ["agent-browser"],
  }), { mode: 0o600 });
  const nativeState = {
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      [projectRoot]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
    mcpServers: {
      viewer: { type: "stdio", command: bun, args: [viewerWrapperPath], env: { LLV_STATE_DIR: stateDir } },
    },
  };
  fs.writeFileSync(path.join(claudeProjectHome.directory, ".claude.json"), JSON.stringify(nativeState), { mode: 0o600 });
  fs.writeFileSync(path.join(claudeProjectHome.claudeConfigDir, ".claude.json"), JSON.stringify(nativeState), { mode: 0o600 });
  fs.writeFileSync(path.join(projectRoot, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "agent-browser": {
        type: "stdio",
        command: bun,
        args: [optionalWrapperPath],
        env: { LLV_STATE_DIR: stateDir, PROJECT_AUTH: "preserved" },
        timeout: 120_000,
        alwaysLoad: true,
      },
      "project-unrelated": { type: "stdio", command: bun, args: [unrelatedServerPath] },
    },
  }), { mode: 0o600 });

  const tmuxTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-tmux-mcp-"));
  fs.chmodSync(tmuxTmpdir, 0o700);
  const session = `claude-mcp-${crypto.randomUUID().slice(0, 8)}`;
  let processes = new Map<number, string>();
  try {
    const created = await runTmux(tmuxTmpdir, ["new-session", "-d", "-x", "180", "-y", "50", "-s", session, "-c", projectRoot]);
    if (created.code !== 0) throw new Error(created.stderr || "tmux session creation failed");
    const spec = freshSpecFor("claude", projectRoot, {
      claudeConfigDir: claudeProjectHome.claudeConfigDir,
      claudeProjectsDir: claudeProjectHome.claudeProjectsDir,
      model: "haiku",
      permissionMode: "bypassPermissions",
      mcpServers: ["agent-browser"],
    });
    const sessionId = path.basename(spec.transcript!, ".jsonl");
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(
      claudeProjectHome.claudeConfigDir,
      ".llv",
      "spawn-mcp",
      `${sessionId}.json`,
    ), "utf8")) as { mcpServers: Record<string, unknown> };
    const launchSettings = JSON.parse(fs.readFileSync(path.join(
      claudeProjectHome.claudeConfigDir,
      ".llv",
      "spawn-settings",
      `${sessionId}.json`,
    ), "utf8")) as { enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[] };
    expect(mcpConfig.mcpServers["agent-browser"]).toMatchObject({
      env: { PROJECT_AUTH: "preserved" },
      timeout: 120_000,
      alwaysLoad: true,
    });
    expect(mcpConfig.mcpServers).not.toHaveProperty("project-unrelated");
    expect(launchSettings.enabledMcpjsonServers).toEqual(["agent-browser"]);
    expect(launchSettings.disabledMcpjsonServers).toEqual(["project-unrelated"]);
    const prompt = `Call the exact native tool mcp__agent-browser__get_pipeline with clientRequestId "tmux-claude-project" and pipelineId "${pipeline.id}". Do not use mcp__viewer__get_pipeline or shell execution. Reply after the successful result.`;
    const isolatedCommand = `env HOME=${shellQuote(claudeProjectHome.directory)} CLAUDE_CONFIG_DIR=${shellQuote(claudeProjectHome.claudeConfigDir)} ${spec.command}`;
    const launched = await runTmux(tmuxTmpdir, ["send-keys", "-t", `${session}:0.0`, "-l", `${isolatedCommand} -- ${shellQuote(prompt)}`]);
    if (launched.code !== 0) throw new Error(launched.stderr || "tmux command delivery failed");
    await runTmux(tmuxTmpdir, ["send-keys", "-t", `${session}:0.0`, "Enter"]);
    try {
      await waitFor(() => nativeClaudeMcpResult(spec.transcript!, "agent-browser", pipeline.id));
    } catch (error) {
      const pane = await runTmux(tmuxTmpdir, ["capture-pane", "-p", "-S", "-200", "-t", `${session}:0.0`]);
      const transcript = fs.existsSync(spec.transcript!) ? fs.readFileSync(spec.transcript!, "utf8") : "<missing>";
      throw new Error(`${String(error)}\n--- tmux pane ---\n${pane.stdout}${pane.stderr}\n--- transcript ---\n${transcript}`);
    }
    expect(fs.existsSync(viewerPidPath)).toBeTrue();
    expect(fs.existsSync(optionalPidPath)).toBeTrue();
    expect(fs.existsSync(unrelatedPath)).toBeFalse();
    const pane = await runTmux(tmuxTmpdir, ["display-message", "-p", "-t", `${session}:0.0`, "#{pane_pid}"]);
    const panePid = Number(pane.stdout.trim());
    if (!Number.isInteger(panePid)) throw new Error("tmux pane pid is unavailable");
    processes = processTree(panePid);
    addRecordedProcess(processes, viewerPidPath);
    addRecordedProcess(processes, optionalPidPath);
    await runTmux(tmuxTmpdir, ["kill-server"]);
    await expectProcessesReaped(processes);
    expect(fs.existsSync(unrelatedPath)).toBeFalse();
  } finally {
    await runTmux(tmuxTmpdir, ["kill-server"]);
    fs.rmSync(tmuxTmpdir, { recursive: true, force: true });
  }
}, 300_000);
