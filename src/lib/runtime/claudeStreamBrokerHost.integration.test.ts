import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, expect, test } from "bun:test";

import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { buildPipeline, PIPELINES_SCHEMA_VERSION } from "@/lib/pipelines/store";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import { pathIsInside, prepareClaudeIntegrationTestHome } from "./integrationTestHome";

const claudeBinary = process.env.LLV_CLAUDE_BINARY ?? "claude";
const resumeHome = prepareClaudeIntegrationTestHome(claudeBinary);
const permissionHome = prepareClaudeIntegrationTestHome(claudeBinary);
const bypassHome = prepareClaudeIntegrationTestHome(claudeBinary);
const mcpDefaultHome = prepareClaudeIntegrationTestHome(claudeBinary);
const mcpCustomHome = prepareClaudeIntegrationTestHome(claudeBinary);

afterAll(() => {
  resumeHome?.cleanup();
  permissionHome?.cleanup();
  bypassHome?.cleanup();
  mcpDefaultHome?.cleanup();
  mcpCustomHome?.cleanup();
});

async function waitFor(
  iterator: AsyncIterator<RuntimeEvent>,
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 60_000,
): Promise<RuntimeEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) throw new Error("Claude event stream ended early");
          if (predicate(next.value)) return next.value;
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude integration event timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function containsText(event: RuntimeEvent, expected: string): boolean {
  if (event.kind === "delta") return event.text.includes(expected);
  if (event.kind !== "item") return false;
  return JSON.stringify(event.item).includes(expected);
}

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
  processes.set(pid, identity);
  for (const [childPid, childIdentity] of processTree(pid)) processes.set(childPid, childIdentity);
}

async function expectProcessesReaped(processes: ReadonlyMap<number, string>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ([...processes].every(([pid, identity]) => processIdentity(pid) !== identity)) return;
    await Bun.sleep(25);
  }
  const survivors = [...processes].filter(([pid, identity]) => processIdentity(pid) === identity).map(([pid]) => pid);
  throw new Error(`Claude MCP processes survived release: ${survivors.join(",")}`);
}

function nativeClaudeTool(event: RuntimeEvent, name: string): boolean {
  if (event.kind !== "item") return false;
  const serialized = JSON.stringify(event.item);
  return serialized.includes('"type":"tool_use"') && serialized.includes(`\"name\":\"${name}\"`);
}

function nativeClaudeToolResult(event: RuntimeEvent, expectedResult: string): boolean {
  if (event.kind !== "item") return false;
  const serialized = JSON.stringify(event.item);
  return serialized.includes('"tool_use_result"')
    && serialized.includes(expectedResult)
    && !serialized.includes("Permission to use")
    && !serialized.includes("has been denied");
}

async function exerciseClaudeTool(host: ClaudeStreamBrokerHost, input: {
  name: string;
  request: string;
  expectedResult: string;
}): Promise<void> {
  const events = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
  const sent = await host.send({ id: `issue-607-${crypto.randomUUID()}`, text: input.request });
  expect(sent.outcome).toBe("turn-started");
  const observed: RuntimeEvent[] = [];
  await waitFor(events, (event) => {
    observed.push(event);
    return event.kind === "turn-ended";
  }, 120_000);
  const sawTool = observed.some((event) => nativeClaudeTool(event, input.name));
  const sawResult = observed.some((event) => nativeClaudeToolResult(event, input.expectedResult));
  if (!sawTool || !sawResult) {
    throw new Error(`native Claude MCP evidence is incomplete: ${JSON.stringify(observed.filter((event) => event.kind === "item").map((event) => event.item))}`);
  }
}

function configureClaudeMcpFixture(home: NonNullable<typeof mcpDefaultHome>): {
  pipelineId: string;
  cwd: string;
  viewerPidPath: string;
  optionalPidPath: string;
  unrelatedPath: string;
  hookPath: string;
} {
  const pipeline = buildPipeline({
    id: `claude-mcp-${path.basename(home.directory)}`,
    task: "Prove native Claude MCP isolation",
    project: "live-log-viewer-next",
    repoDir: process.cwd(),
    stages: [{
      id: "proof",
      kind: "run",
      "prompt": "Exercise Viewer MCP",
      next: null,
      onFail: null,
      effectiveRole: { roleId: null, engine: "claude", model: "haiku", effort: "low", access: "read-only", promptScaffold: null },
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
  const hookPath = path.join(home.directory, "viewer-hook-ran");
  const viewerWrapperPath = path.join(home.directory, "viewer-mcp.ts");
  const optionalServerPath = path.join(home.directory, "optional-mcp.ts");
  const unrelatedServerPath = path.join(home.directory, "unrelated-mcp.ts");
  const hookScriptPath = path.join(home.directory, "viewer-hook.sh");
  const projectRoot = path.join(home.directory, "project");
  const viewerLauncher = path.resolve(import.meta.dir, "../../../bin/mcp-server.mjs");
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "pipelines.json"), JSON.stringify({
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    pipelines: [pipeline],
  }), { mode: 0o600 });
  fs.writeFileSync(viewerWrapperPath, [
    `await Bun.write(${JSON.stringify(viewerPidPath)}, String(process.pid));`,
    `const child = Bun.spawn({ cmd: [${JSON.stringify(Bun.which("bun") ?? "bun")}, ${JSON.stringify(viewerLauncher)}], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });`,
    'process.on("SIGTERM", () => child.kill("SIGTERM"));',
    'process.on("SIGINT", () => child.kill("SIGINT"));',
    "process.exitCode = await child.exited;",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(optionalServerPath, [
    `await Bun.write(${JSON.stringify(optionalPidPath)}, String(process.pid));`,
    `const child = Bun.spawn({ cmd: [${JSON.stringify(Bun.which("bun") ?? "bun")}, ${JSON.stringify(viewerLauncher)}], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });`,
    'process.on("SIGTERM", () => child.kill("SIGTERM"));',
    'process.on("SIGINT", () => child.kill("SIGINT"));',
    "process.exitCode = await child.exited;",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(unrelatedServerPath, `await Bun.write(${JSON.stringify(unrelatedPath)}, String(process.pid));\nprocess.stdin.resume();\n`, { mode: 0o600 });
  fs.writeFileSync(hookScriptPath, `#!/bin/sh\nprintf hook > ${JSON.stringify(hookPath)}\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(home.claudeConfigDir, "settings.json"), JSON.stringify({
    enabledMcpjsonServers: ["agent-browser"],
    hooks: { PreToolUse: [{ matcher: "mcp__viewer__get_pipeline", hooks: [{ type: "command", command: hookScriptPath }] }] },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(home.directory, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: {
      viewer: { type: "stdio", command: Bun.which("bun") ?? "bun", args: [viewerWrapperPath], env: { LLV_STATE_DIR: stateDir } },
    },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(projectRoot, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "agent-browser": {
        type: "stdio",
        command: Bun.which("bun") ?? "bun",
        args: [optionalServerPath],
        env: { LLV_STATE_DIR: stateDir, PROJECT_AUTH: "preserved" },
        timeout: 120_000,
        alwaysLoad: true,
      },
      "project-unrelated": { type: "stdio", command: Bun.which("bun") ?? "bun", args: [unrelatedServerPath] },
    },
  }), { mode: 0o600 });
  return { pipelineId: pipeline.id, cwd: projectRoot, viewerPidPath, optionalPidPath, unrelatedPath, hookPath };
}

test.skipIf(!resumeHome)("real Claude subscription supports late attach and restart resume", async () => {
  if (!resumeHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = resumeHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  let recovered: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: resumeHome.claudeConfigDir,
      claudeProjectsDir: resumeHome.claudeProjectsDir,
      env: resumeHome.env,
      model: "haiku",
      permissionMode: "dontAsk",
      tools: [],
      systemPrompt: "Follow each user request exactly. Do not inspect files or use tools.",
      eventStore,
      deliveryLedger,
    });
    const owner = host.attach(0)[Symbol.asyncIterator]();
    const sent = await host.send({
      id: `issue-150-original-${crypto.randomUUID()}`,
      text: "Remember marker ORCHID-150, then reply with exactly ACK-150.",
    });
    expect(sent.outcome).toBe("turn-started");
    const late = host.attach(0)[Symbol.asyncIterator]();
    await waitFor(owner, (event) => containsText(event, "ACK-150"));
    await waitFor(late, (event) => containsText(event, "ACK-150"));
    const sessionId = host.identity.sessionId;
    const sessionPath = claudeTranscriptPath(process.cwd(), sessionId, resumeHome.claudeProjectsDir);
    expect(pathIsInside(resumeHome.directory, sessionPath)).toBeTrue();
    expect(fs.existsSync(sessionPath)).toBeTrue();
    await host.release();
    const releasedCursor = (await host.health()).eventCursor;
    host = null;

    recovered = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: resumeHome.claudeConfigDir,
      claudeProjectsDir: resumeHome.claudeProjectsDir,
      env: resumeHome.env,
      model: "haiku",
      permissionMode: "dontAsk",
      tools: [],
      systemPrompt: "Follow each user request exactly. Do not inspect files or use tools.",
      initialEventCursor: releasedCursor,
      eventStore,
      deliveryLedger,
    });
    expect(recovered.identity.sessionId).toBe(sessionId);
    const recovery = recovered.attach((await recovered.health()).eventCursor)[Symbol.asyncIterator]();
    const recall = await recovered.send({
      id: `issue-150-recall-${crypto.randomUUID()}`,
      text: "Reply with only the marker I asked you to remember.",
    });
    expect(recall.outcome).toBe("turn-started");
    await waitFor(recovery, (event) => containsText(event, "ORCHID-150"));
  } finally {
    await host?.release();
    await recovered?.release();
    resumeHome.cleanup();
  }
}, 180_000);

test.skipIf(!permissionHome)("real Claude permission requests reach EngineHost.answer", async () => {
  if (!permissionHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = permissionHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: permissionHome.claudeConfigDir,
      claudeProjectsDir: permissionHome.claudeProjectsDir,
      env: permissionHome.env,
      model: "haiku",
      permissionMode: "default",
      tools: ["Bash"],
      systemPrompt: "Follow the user request exactly and use the requested tool.",
      eventStore,
      deliveryLedger,
    });
    const events = host.attach(0)[Symbol.asyncIterator]();
    const probePath = path.join(directory, "permission-probe");
    const sent = await host.send({
      id: `issue-150-permission-${crypto.randomUUID()}`,
      text: `Use the Bash tool once to run \`touch ${probePath}\`. Do not answer before attempting the tool.`,
    });
    expect(sent.outcome).toBe("turn-started");
    const attention = await waitFor(events, (event) => event.kind === "attention" && event.method === "can_use_tool");
    if (attention.kind !== "attention") throw new Error("expected Claude permission attention");
    const sessionPath = claudeTranscriptPath(process.cwd(), host.identity.sessionId, permissionHome.claudeProjectsDir);
    expect(pathIsInside(permissionHome.directory, sessionPath)).toBeTrue();
    expect(fs.existsSync(sessionPath)).toBeTrue();
    await host.answer(attention.id, { behavior: "deny", message: "Denied by the runtime integration test." });
    await waitFor(events, (event) => event.kind === "turn-ended");
  } finally {
    await host?.release();
    permissionHome.cleanup();
  }
}, 180_000);

test.skipIf(!bypassHome)("real Claude bypass executes Bash without pending attention", async () => {
  if (!bypassHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = bypassHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: directory,
      binary: claudeBinary,
      claudeConfigDir: bypassHome.claudeConfigDir,
      claudeProjectsDir: bypassHome.claudeProjectsDir,
      env: bypassHome.env,
      model: "haiku",
      permissionMode: "bypassPermissions",
      tools: ["Bash"],
      systemPrompt: "Follow the user request exactly and use the requested tool.",
      eventStore,
      deliveryLedger,
    });
    const events = host.attach(0)[Symbol.asyncIterator]();
    const probePath = path.join(directory, "bypass-probe");
    const sent = await host.send({
      id: `issue-243-bypass-${crypto.randomUUID()}`,
      text: `Use the Bash tool once to run \`touch ${probePath}\`. Reply after the tool completes.`,
    });
    expect(sent.outcome).toBe("turn-started");
    let sawAttention = false;
    await waitFor(events, (event) => {
      if (event.kind === "attention") sawAttention = true;
      return event.kind === "turn-ended";
    });
    expect(fs.existsSync(probePath)).toBeTrue();
    expect(sawAttention).toBeFalse();
    expect((await host.health()).pendingAttention).toEqual([]);
  } finally {
    await host?.release();
    bypassHome.cleanup();
  }
}, 180_000);

test.skipIf(!mcpDefaultHome)("real Claude default MCP policy exposes Viewer, preserves hooks, excludes sentinels, and reaps the fleet", async () => {
  if (!mcpDefaultHome) throw new Error("isolated Claude subscription home is unavailable");
  const fixture = configureClaudeMcpFixture(mcpDefaultHome);
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: fixture.cwd,
      binary: claudeBinary,
      claudeConfigDir: mcpDefaultHome.claudeConfigDir,
      claudeProjectsDir: mcpDefaultHome.claudeProjectsDir,
      mcpStatePath: path.join(mcpDefaultHome.directory, ".claude.json"),
      env: mcpDefaultHome.env,
      model: "haiku",
      permissionMode: "bypassPermissions",
      systemPrompt: "Use the exact native MCP tool requested by the user. Shell execution is prohibited.",
      eventStore: new FileRuntimeEventStore(path.join(mcpDefaultHome.directory, "mcp-events")),
      deliveryLedger: new FileClaudeDeliveryLedger(path.join(mcpDefaultHome.directory, "mcp-deliveries")),
    });
    await exerciseClaudeTool(host, {
      name: "mcp__viewer__get_pipeline",
      request: `Call the native Viewer MCP tool get_pipeline with clientRequestId "claude-default" and pipelineId "${fixture.pipelineId}". Reply after the successful result.`,
      expectedResult: fixture.pipelineId,
    });
    expect((await host.health()).account).toMatchObject({ type: "claude.ai" });
    expect(fs.existsSync(fixture.hookPath)).toBeTrue();
    expect(fs.existsSync(fixture.optionalPidPath)).toBeFalse();
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
    const health = await host.health();
    if (!health.pid) throw new Error("Claude host pid is unavailable");
    const processes = processTree(health.pid);
    addRecordedProcess(processes, fixture.viewerPidPath);
    await host.release();
    host = null;
    await expectProcessesReaped(processes);
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
  } finally {
    await host?.release();
  }
}, 300_000);

test.skipIf(!mcpCustomHome)("real Claude custom MCP policy force-includes Viewer across fresh and adopted hosts with complete cleanup", async () => {
  if (!mcpCustomHome) throw new Error("isolated Claude subscription home is unavailable");
  const fixture = configureClaudeMcpFixture(mcpCustomHome);
  const eventStore = new FileRuntimeEventStore(path.join(mcpCustomHome.directory, "mcp-events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(mcpCustomHome.directory, "mcp-deliveries"));
  const options = {
    cwd: fixture.cwd,
    binary: claudeBinary,
    claudeConfigDir: mcpCustomHome.claudeConfigDir,
    claudeProjectsDir: mcpCustomHome.claudeProjectsDir,
    mcpStatePath: path.join(mcpCustomHome.directory, ".claude.json"),
    mcpServers: ["agent-browser"],
    env: mcpCustomHome.env,
    model: "haiku",
    permissionMode: "bypassPermissions",
    systemPrompt: "Use the exact native MCP tool requested by the user. Shell execution is prohibited.",
    eventStore,
    deliveryLedger,
  };
  let fresh: ClaudeStreamBrokerHost | null = null;
  let adopted: ClaudeStreamBrokerHost | null = null;
  try {
    fresh = await ClaudeStreamBrokerHost.start(options);
    const profileId = `structured-${crypto.createHash("sha256").update(fresh.identity.sessionId).digest("hex").slice(0, 24)}`;
    const freshMcpConfig = JSON.parse(fs.readFileSync(path.join(
      mcpCustomHome.claudeConfigDir,
      ".llv",
      "spawn-mcp",
      `${profileId}.json`,
    ), "utf8")) as { mcpServers: Record<string, unknown> };
    const freshSettings = JSON.parse(fs.readFileSync(path.join(
      mcpCustomHome.claudeConfigDir,
      ".llv",
      "spawn-settings",
      `${profileId}.json`,
    ), "utf8")) as { enabledMcpjsonServers: string[] };
    expect(freshMcpConfig.mcpServers["agent-browser"]).toMatchObject({
      env: { PROJECT_AUTH: "preserved" },
      timeout: 120_000,
      alwaysLoad: true,
    });
    expect(freshMcpConfig.mcpServers).not.toHaveProperty("project-unrelated");
    expect(freshSettings.enabledMcpjsonServers).toEqual(["agent-browser"]);
    await exerciseClaudeTool(fresh, {
      name: "mcp__viewer__get_pipeline",
      request: `Call the native Viewer MCP tool get_pipeline with clientRequestId "claude-custom-fresh" and pipelineId "${fixture.pipelineId}". Reply after the successful result.`,
      expectedResult: fixture.pipelineId,
    });
    expect(fs.existsSync(fixture.viewerPidPath)).toBeTrue();
    expect(fs.existsSync(fixture.optionalPidPath)).toBeTrue();
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
    const sessionId = fresh.identity.sessionId;
    const cursor = (await fresh.health()).eventCursor;
    const freshPid = (await fresh.health()).pid;
    if (!freshPid) throw new Error("fresh Claude host pid is unavailable");
    const freshProcesses = processTree(freshPid);
    addRecordedProcess(freshProcesses, fixture.viewerPidPath);
    addRecordedProcess(freshProcesses, fixture.optionalPidPath);
    await fresh.release();
    fresh = null;
    await expectProcessesReaped(freshProcesses);

    fs.rmSync(fixture.viewerPidPath);
    fs.rmSync(fixture.optionalPidPath);
    adopted = await ClaudeStreamBrokerHost.adopt(sessionId, { ...options, initialEventCursor: cursor });
    await exerciseClaudeTool(adopted, {
      name: "mcp__viewer__get_pipeline",
      request: `Call the native Viewer MCP tool get_pipeline with clientRequestId "claude-adopted" and pipelineId "${fixture.pipelineId}". Reply after the successful result.`,
      expectedResult: fixture.pipelineId,
    });
    expect(fs.existsSync(fixture.viewerPidPath)).toBeTrue();
    expect(fs.existsSync(fixture.optionalPidPath)).toBeTrue();
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
    expect(fs.existsSync(fixture.hookPath)).toBeTrue();
    const adoptedPid = (await adopted.health()).pid;
    if (!adoptedPid) throw new Error("adopted Claude host pid is unavailable");
    const adoptedProcesses = processTree(adoptedPid);
    addRecordedProcess(adoptedProcesses, fixture.viewerPidPath);
    addRecordedProcess(adoptedProcesses, fixture.optionalPidPath);
    await adopted.release();
    adopted = null;
    await expectProcessesReaped(adoptedProcesses);
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
  } finally {
    await fresh?.release();
    await adopted?.release();
  }
}, 420_000);
