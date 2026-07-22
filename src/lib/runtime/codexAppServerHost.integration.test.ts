import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeEvent } from "./engineHost";
import { FileRuntimeEventStore } from "./eventStore";
import { pathIsInside, prepareCodexIntegrationTestHome } from "./integrationTestHome";
import { buildPipeline, PIPELINES_SCHEMA_VERSION } from "@/lib/pipelines/store";

const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";
const isolatedHome = prepareCodexIntegrationTestHome(codexBinary);
const mcpHome = prepareCodexIntegrationTestHome(codexBinary);

afterAll(() => {
  isolatedHome?.cleanup();
  mcpHome?.cleanup();
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
        if (next.done) throw new Error("Codex event stream ended early");
        if (predicate(next.value)) return next.value;
      }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex integration event timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function containsText(event: RuntimeEvent, expected: string): boolean {
  if (event.kind === "delta") return event.text.includes(expected);
  if (event.kind !== "item") return false;
  const item = event.item as { type?: string; text?: string } | null;
  return item?.type === "agentMessage" && item.text?.includes(expected) === true;
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

function processCommand(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); }
  catch { return ""; }
}

async function expectProcessesReaped(processes: ReadonlyMap<number, string>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ([...processes].every(([pid, identity]) => processIdentity(pid) !== identity)) return;
    await Bun.sleep(25);
  }
  const survivors = [...processes].filter(([pid, identity]) => processIdentity(pid) === identity).map(([pid]) => pid);
  throw new Error(`structured host processes survived release: ${survivors.join(",")}`);
}

function addProcessTree(processes: Map<number, string>, rootPid: number): void {
  for (const [pid, identity] of processTree(rootPid)) processes.set(pid, identity);
}

function recordedProcess(markerPath: string): { pid: number; identity: string } {
  const pid = Number(fs.readFileSync(markerPath, "utf8"));
  const identity = processIdentity(pid);
  if (!Number.isInteger(pid) || !identity) throw new Error("recorded Viewer MCP process is unavailable");
  return { pid, identity };
}

function nativeViewerCall(event: RuntimeEvent, pipelineId: string): boolean {
  if (event.kind !== "item" || event.phase !== "completed") return false;
  const item = event.item as {
    type?: string;
    server?: string;
    tool?: string;
    status?: string;
    result?: unknown;
    error?: unknown;
  };
  return item.type === "mcpToolCall"
    && item.server === "viewer"
    && item.tool === "get_pipeline"
    && item.status === "completed"
    && item.error == null
    && JSON.stringify(item.result).includes(pipelineId);
}

async function exerciseNativeViewer(
  host: CodexAppServerHost,
  pipelineId: string,
  label: "fresh" | "adopted",
): Promise<void> {
  const cursor = (await host.health()).eventCursor;
  const events = host.attach(cursor)[Symbol.asyncIterator]();
  const started = await host.send({
    id: `issue-607-${label}-${crypto.randomUUID()}`,
    text: `Call the native Viewer MCP tool get_pipeline with clientRequestId "issue-607-${label}" and pipelineId "${pipelineId}". Shell execution is prohibited. After the successful tool result, reply exactly VIEWER_NATIVE_${label.toUpperCase()}.`,
  });
  expect(started.outcome).toBe("turn-started");
  const observed: RuntimeEvent[] = [];
  try {
    await waitFor(events, (event) => {
      observed.push(event);
      return event.kind === "turn-ended" && event.status === "completed";
    }, 120_000);
  } catch (error) {
    const health = await host.health();
    const processes = health.pid
      ? [...processTree(health.pid).keys()].map((pid) => ({ pid, command: processCommand(pid) }))
      : [];
    const eventSummary = observed.map((event) => event.kind === "item"
      ? { kind: event.kind, phase: event.phase, item: JSON.stringify(event.item).slice(0, 1_000) }
      : event);
    throw new Error(`${String(error)}; health=${JSON.stringify(health)}; processes=${JSON.stringify(processes)}; events=${JSON.stringify(eventSummary)}`);
  }
  if (!observed.some((event) => nativeViewerCall(event, pipelineId))) {
    const itemKinds = observed
      .filter((event) => event.kind === "item")
      .map((event) => JSON.stringify(event.item).slice(0, 500));
    throw new Error(`native viewer.get_pipeline event is missing: ${JSON.stringify(itemKinds)}`);
  }
}

test.skipIf(!isolatedHome)("real Codex subscription supports late attach, steering, and restart resume", async () => {
  if (!isolatedHome) throw new Error("isolated Codex subscription home is unavailable");
  const eventStore = new FileRuntimeEventStore(path.join(isolatedHome.directory, "events"));
  let host: CodexAppServerHost | null = null;
  let recovered: CodexAppServerHost | null = null;
  try {
    host = await CodexAppServerHost.start({
      cwd: process.cwd(),
      binary: codexBinary,
      codexHome: isolatedHome.codexHome,
      env: isolatedHome.env,
      fileAuthCredentials: true,
      model: "gpt-5.4-mini",
      sandbox: "read-only",
      approvalPolicy: "never",
      requestTimeoutMs: 60_000,
      eventStore,
    });
    const sessionPath = host.identity.path;
    if (!sessionPath) throw new Error("Codex returned no session file path");
    expect(pathIsInside(isolatedHome.codexHome, sessionPath)).toBeTrue();
    const owner = host.attach(0)[Symbol.asyncIterator]();
    const started = await host.send({
      id: `issue-149-original-${crypto.randomUUID()}`,
      text: "Remember marker ZEBRA-149. Run the shell command `sleep 4`, then reply with exactly ORIGINAL-149. Follow steering received while the command runs.",
    });
    expect(started.outcome).toBe("turn-started");
    const turnId = started.outcome === "turn-started" ? started.turnId : "";
    await waitFor(owner, (event) => event.kind === "item" && event.phase === "started" && (event.item as { type?: string })?.type === "commandExecution");

    const lateClient = host.attach(0)[Symbol.asyncIterator]();
    const steered = await host.send({
      id: `issue-149-steer-${crypto.randomUUID()}`,
      text: "Replace the final response with exactly STEERED-149.",
      expectedTurnId: turnId,
    });
    expect(steered).toEqual({ outcome: "steered", turnId });
    await waitFor(lateClient, (event) => containsText(event, "STEERED-149"));
    await waitFor(owner, (event) => event.kind === "turn-ended" && event.turnId === turnId && event.status === "completed");
    expect(fs.existsSync(sessionPath)).toBeTrue();

    const threadId = host.identity.threadId;
    await host.release();
    const releasedCursor = (await host.health()).eventCursor;
    host = null;
    recovered = await CodexAppServerHost.adopt(threadId, {
      cwd: process.cwd(),
      binary: codexBinary,
      codexHome: isolatedHome.codexHome,
      env: isolatedHome.env,
      fileAuthCredentials: true,
      model: "gpt-5.4-mini",
      sandbox: "read-only",
      approvalPolicy: "never",
      requestTimeoutMs: 60_000,
      initialEventCursor: releasedCursor,
      eventStore,
    });
    expect(recovered.identity.path).toBe(path.resolve(sessionPath));
    expect(pathIsInside(isolatedHome.codexHome, recovered.identity.path ?? "")).toBeTrue();
    const restartReplay = recovered.attach(releasedCursor - 1)[Symbol.asyncIterator]();
    expect((await restartReplay.next()).value).toEqual({ kind: "session-status", status: "unhosted", seq: releasedCursor });
    expect((await restartReplay.next()).value).toEqual({
      kind: "session-status",
      status: "idle",
      activeFlags: ["structured-image-v1"],
      seq: releasedCursor + 1,
    });
    const recoveryEvents = recovered.attach(releasedCursor + 1)[Symbol.asyncIterator]();
    const recall = await recovered.send({
      id: `issue-149-recall-${crypto.randomUUID()}`,
      text: "Reply with only the marker I asked you to remember.",
    });
    expect(recall.outcome).toBe("turn-started");
    await waitFor(recoveryEvents, (event) => containsText(event, "ZEBRA-149"));
  } finally {
    await host?.release();
    await recovered?.release();
    isolatedHome.cleanup();
  }
}, 180_000);

test.skipIf(!mcpHome)("real Codex exposes native Viewer tools on fresh start and adoption with complete MCP cleanup", async () => {
  if (!mcpHome) throw new Error("isolated Codex subscription home is unavailable");
  const pipeline = buildPipeline({
    id: "mcp-native-proof",
    task: "Prove native Viewer MCP",
    project: "live-log-viewer-next",
    repoDir: process.cwd(),
    stages: [{
      id: "proof",
      kind: "run",
      "prompt": "Exercise Viewer MCP",
      next: null,
      onFail: null,
      effectiveRole: {
        roleId: null,
        engine: "codex",
        model: "gpt-5.4-mini",
        effort: "low",
        access: "read-only",
        promptScaffold: null,
      },
    }],
    srcPath: null,
    srcConversationId: null,
    now: "2026-07-23T00:00:00.000Z",
    state: "draft",
  });
  const stateDir = path.join(mcpHome.directory, "viewer-state");
  const markerPath = path.join(mcpHome.directory, "unrelated-started");
  const sentinelPath = path.join(mcpHome.directory, "unrelated-mcp.ts");
  const viewerPidPath = path.join(mcpHome.directory, "viewer-pid");
  const viewerWrapperPath = path.join(mcpHome.directory, "viewer-mcp.ts");
  const viewerLauncher = path.resolve(import.meta.dir, "../../../bin/mcp-server.mjs");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "pipelines.json"), JSON.stringify({
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    pipelines: [pipeline],
  }), { mode: 0o600 });
  fs.writeFileSync(sentinelPath, `await Bun.write(${JSON.stringify(markerPath)}, String(process.pid));\nprocess.stdin.resume();\n`, { mode: 0o600 });
  fs.writeFileSync(viewerWrapperPath, [
    `await Bun.write(${JSON.stringify(viewerPidPath)}, String(process.pid));`,
    `const child = Bun.spawn({ cmd: [${JSON.stringify(Bun.which("bun") ?? "bun")}, ${JSON.stringify(viewerLauncher)}], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });`,
    'process.on("SIGTERM", () => child.kill("SIGTERM"));',
    'process.on("SIGINT", () => child.kill("SIGINT"));',
    "process.exitCode = await child.exited;",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(path.join(mcpHome.codexHome, "config.toml"), [
    "[mcp_servers.viewer]",
    `command = ${JSON.stringify(Bun.which("bun") ?? "bun")}`,
    `args = [${JSON.stringify(viewerWrapperPath)}]`,
    "[mcp_servers.viewer.env]",
    `LLV_STATE_DIR = ${JSON.stringify(stateDir)}`,
    "[mcp_servers.unrelated]",
    `command = ${JSON.stringify(Bun.which("bun") ?? "bun")}`,
    `args = [${JSON.stringify(sentinelPath)}]`,
    "",
  ].join("\n"), { mode: 0o600 });

  const eventStore = new FileRuntimeEventStore(path.join(mcpHome.directory, "mcp-events"));
  const options = {
    cwd: process.cwd(),
    binary: codexBinary,
    codexHome: mcpHome.codexHome,
    env: mcpHome.env,
    fileAuthCredentials: true,
    model: "gpt-5.4-mini",
    sandbox: "read-only",
    approvalPolicy: "never",
    mcpServers: ["viewer"],
    requestTimeoutMs: 60_000,
    shutdownGraceMs: 2_000,
    eventStore,
  };
  let fresh: CodexAppServerHost | null = null;
  let adopted: CodexAppServerHost | null = null;
  try {
    fresh = await CodexAppServerHost.start(options);
    await exerciseNativeViewer(fresh, pipeline.id, "fresh");
    expect(fs.existsSync(markerPath)).toBeFalse();
    const freshHealth = await fresh.health();
    if (!freshHealth.pid) throw new Error("fresh app-server pid is unavailable");
    const freshProcesses = processTree(freshHealth.pid);
    const freshViewer = recordedProcess(viewerPidPath);
    addProcessTree(freshProcesses, freshViewer.pid);
    expect(freshProcesses.get(freshViewer.pid)).toBe(freshViewer.identity);
    const threadId = fresh.identity.threadId;
    const cursor = freshHealth.eventCursor;
    await fresh.release();
    fresh = null;
    await expectProcessesReaped(freshProcesses);

    fs.rmSync(viewerPidPath);
    adopted = await CodexAppServerHost.adopt(threadId, { ...options, initialEventCursor: cursor });
    await exerciseNativeViewer(adopted, pipeline.id, "adopted");
    expect(fs.existsSync(markerPath)).toBeFalse();
    const adoptedHealth = await adopted.health();
    if (!adoptedHealth.pid) throw new Error("adopted app-server pid is unavailable");
    const adoptedProcesses = processTree(adoptedHealth.pid);
    const adoptedViewer = recordedProcess(viewerPidPath);
    addProcessTree(adoptedProcesses, adoptedViewer.pid);
    expect(adoptedProcesses.get(adoptedViewer.pid)).toBe(adoptedViewer.identity);
    await adopted.release();
    adopted = null;
    await expectProcessesReaped(adoptedProcesses);
    expect(fs.existsSync(markerPath)).toBeFalse();
  } finally {
    await fresh?.release();
    await adopted?.release();
    mcpHome.cleanup();
  }
}, 300_000);
