import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

/* Every process these tests start — the packaged MCP server, the controlled
   Viewer host — runs against a sandbox of its own: state, home, config, temp
   and provider homes all point inside it, and nothing this session's own
   environment carries (a spawn capability, a control URL, a deploy target)
   reaches a child. */
const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandboxDir(prefix: string): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

function isolatedEnvironment(sandbox: string, extra: Record<string, string> = {}): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"
      && !entry[0].startsWith("LLV_")
      && !entry[0].startsWith("NEXT_PUBLIC_")));
  const directories = {
    HOME: path.join(sandbox, "home"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    TMPDIR: path.join(sandbox, "tmp"),
    LLV_STATE_DIR: path.join(sandbox, "state"),
    LLV_CLAUDE_HOME: path.join(sandbox, "claude-home"),
    LLV_CODEX_HOME: path.join(sandbox, "codex-home"),
  };
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
  return { ...environment, ...directories, ...extra };
}

function spawnResult(label: string): Response {
  return Response.json({
    conversationId: `conversation_${label}`,
    path: `/fixture/${label}.jsonl`,
    launchId: `launch_${label}`,
    state: "running",
    initialMessage: null,
  });
}

interface McpSession {
  client: Client;
  transport: StdioClientTransport;
  stderr(): string;
  close(): Promise<void>;
}

async function startMcp(environment: Record<string, string>, name: string): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => stderr,
    close: async () => {
      await Promise.race([client.close().catch(() => {}), Bun.sleep(1_000)]);
      await Promise.race([transport.close().catch(() => {}), Bun.sleep(1_000)]);
    },
  };
}

async function callSpawn(client: Client, clientRequestId: string, extra: Record<string, unknown> = {}) {
  return client.callTool({
    name: "spawn_agent",
    arguments: {
      clientRequestId,
      cwd: process.cwd(),
      "prompt": "Run the restart fixture.",
      title: "Restart fixture",
      ...extra,
    },
  });
}

test("the packaged stdio host publishes and invokes the expanded read surface", async () => {
  const sandbox = sandboxDir("llv-mcp-stdio-");
  const session = await startMcp(isolatedEnvironment(sandbox), "viewer-stdio-integration");
  try {
    const tools = await session.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("board_snapshot");
    expect(tools.tools.map((tool) => tool.name)).toContain("conversation_migration");

    const first = await session.client.callTool({
      name: "list_flows",
      arguments: { clientRequestId: "stdio-list-flows", limit: 1 },
    });
    const replay = await session.client.callTool({
      name: "list_flows",
      arguments: { clientRequestId: "stdio-list-flows", limit: 1 },
    });
    const tasks = await session.client.callTool({
      name: "list_tasks",
      arguments: { clientRequestId: "stdio-list-tasks", limit: 1 },
    });

    expect(first.structuredContent).toMatchObject({ ok: true, toolName: "list_flows", replayed: false });
    expect(replay.structuredContent).toMatchObject({ ok: true, toolName: "list_flows", replayed: true });
    expect(tasks.structuredContent).toMatchObject({ ok: true, toolName: "list_tasks", replayed: false });
  } finally {
    await session.close();
  }
});

test("a packaged MCP spawn is dispatched once: a Viewer restart mid-request answers unknown and nothing is re-POSTed", async () => {
  /* #1490: this used to be the reconnect-and-repeat test. A spawn whose
     response is lost after the Viewer may hold the request is now reported as
     `unknown` with the original key as the only permitted next step, and the
     restarted Viewer never sees the request a second time. */
  const sandbox = sandboxDir("llv-mcp-viewer-restart-");
  const blockedRequest = { release: null as ((response: Response) => void) | null };
  let markBlockedRequestReached: (() => void) | null = null;
  const blockedRequestReached = new Promise<void>((resolve) => { markBlockedRequestReached = resolve; });
  let requests = 0;
  const firstViewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      if (requests === 1) return spawnResult("before_restart");
      markBlockedRequestReached?.();
      return new Promise<Response>((resolve) => { blockedRequest.release = resolve; });
    },
  });
  const viewerPort = firstViewer.port;
  const environment = isolatedEnvironment(sandbox, {
    LLV_VIEWER_DEPLOY_TARGET: path.join(sandbox, "viewer-release.json"),
    LLV_VIEWER_CONTROL_URL: firstViewer.url.origin,
  });
  const session = await startMcp(environment, "viewer-restart-integration");
  let restartedViewer: ReturnType<typeof Bun.serve> | null = null;
  const restartedKeys: string[] = [];
  let transientProxyFailures = 0;
  let breakResponseBody = false;
  try {
    expect((await callSpawn(session.client, "restart-before")).structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_before_restart" });

    const inFlight = callSpawn(session.client, "restart-during");
    await blockedRequestReached;
    void firstViewer.stop(false);
    restartedViewer = Bun.serve({
      hostname: "127.0.0.1",
      port: viewerPort,
      fetch: async (request) => {
        const body = await request.json() as { clientAttemptId?: string };
        restartedKeys.push(body.clientAttemptId ?? "");
        if (transientProxyFailures > 0) {
          transientProxyFailures -= 1;
          return new Response(null, { status: 503 });
        }
        if (breakResponseBody) {
          breakResponseBody = false;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"conversationId":'));
              setTimeout(() => controller.error(new Error("retired Viewer response")), 10);
            },
          }), { headers: { "content-type": "application/json" } });
        }
        return spawnResult("after_restart");
      },
    });
    expect(restartedViewer.port).toBe(viewerPort);

    const lost = await Promise.race([
      inFlight,
      Bun.sleep(15_000).then(() => { throw new Error(`MCP call did not settle after the Viewer restart\n${session.stderr()}`); }),
    ]);
    expect(lost.isError).toBe(true);
    expect(lost.structuredContent).toMatchObject({
      ok: false,
      code: "outcome_unknown",
      retryable: false,
      details: { outcome: "unknown", nextAction: "original-key-lookup" },
    });
    /* The restarted Viewer never received the lost request again. */
    expect(restartedKeys).not.toContain("restart-during");

    /* This MCP process carries no caller identity, so an existing claim is
       not its to recover: a repeat under the key, explicit or ordinary, is
       refused without disclosure — and still dispatches nothing. */
    for (const extra of [{ recoveryOnly: true }, {}]) {
      const lookup = await callSpawn(session.client, "restart-during", extra);
      expect(lookup.structuredContent).toMatchObject({ ok: false, code: "recovery_not_permitted", retryable: false });
      expect((lookup.structuredContent as { details?: unknown }).details).toBeUndefined();
    }
    expect(restartedKeys).not.toContain("restart-during");

    /* A bodiless proxy status proves nothing about the upstream: unknown, one POST. */
    transientProxyFailures = 1;
    expect((await callSpawn(session.client, "restart-proxy-gap")).structuredContent)
      .toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(restartedKeys.filter((key) => key === "restart-proxy-gap")).toHaveLength(1);

    /* A response body cut after the request was accepted: unknown, one POST. */
    breakResponseBody = true;
    expect((await callSpawn(session.client, "restart-cut-body")).structuredContent)
      .toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(restartedKeys.filter((key) => key === "restart-cut-body")).toHaveLength(1);

    /* An ordinary call still dispatches once and answers normally. */
    expect((await callSpawn(session.client, "restart-after")).structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_after_restart" });
    expect(restartedKeys.filter((key) => key === "restart-after")).toHaveLength(1);

    await restartedViewer.stop(true);
    restartedViewer = null;
    /* A refused connection carried no byte: the server provably did nothing. */
    const unavailable = await callSpawn(session.client, "restart-unavailable");
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toMatchObject({
      ok: false,
      code: "tool_failed",
      error: expect.stringContaining("connection was refused"),
      details: { outcome: "not-executed", nextAction: "new-request-permitted" },
    });
    expect((await session.client.listTools()).tools.map((tool) => tool.name)).toContain("spawn_agent");
  } finally {
    blockedRequest.release?.(Response.json({ error: "retired Viewer generation" }, { status: 503 }));
    await Promise.race([
      Promise.all([
        session.close(),
        Promise.resolve(firstViewer.stop(true)).catch(() => {}),
        Promise.resolve(restartedViewer?.stop(true)).catch(() => {}),
      ]),
      Bun.sleep(1_500),
    ]);
  }
}, 25_000);

test("a packaged MCP tool falls back from a retired launch port to the stable Viewer resolver", async () => {
  const sandbox = sandboxDir("llv-mcp-dead-launch-port-");
  const retiredViewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => spawnResult("retired"),
  });
  const retiredOrigin = retiredViewer.url.origin;
  await retiredViewer.stop(true);
  let stableRequests = 0;
  const stableViewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      stableRequests += 1;
      return spawnResult("stable_resolver");
    },
  });
  const targetFile = path.join(sandbox, "viewer-release.json");
  fs.writeFileSync(targetFile, JSON.stringify({
    revision: "a".repeat(40),
    image: "viewer:fixture",
    container: "viewer-fixture",
    endpoint: stableViewer.url.origin,
  }));
  const session = await startMcp(isolatedEnvironment(sandbox, {
    LLV_VIEWER_DEPLOY_TARGET: targetFile,
    LLV_VIEWER_CONTROL_URL: retiredOrigin,
    LLV_VIEWER_PORT: String(stableViewer.port),
  }), "viewer-dead-launch-port");
  try {
    expect((await callSpawn(session.client, "dead-launch-port-fallback")).structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_stable_resolver" });
    expect(stableRequests).toBe(1);
  } finally {
    await session.close();
    await stableViewer.stop(true);
  }
}, 12_000);

/* ── CAUSAL PROOF (#1490) ─────────────────────────────────────────────────
   The packaged MCP server, over its production control transport, against
   the PRODUCTION `/api/tmux` and `/api/spawn` handlers served by the
   controlled Viewer role of `receiptStoreProbeChild.ts`. The three processes
   share one isolated registry and one isolated receipt store; the recipient
   and the writer are fixtures that log every actual effect. */

interface HostProcess {
  process: ReturnType<typeof Bun.spawn>;
  origin: string;
  stderr(): Promise<string>;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

interface CausalFixture {
  sandbox: string;
  state: string;
  environment: Record<string, string>;
  registry: AgentRegistry;
  recipient: { conversationId: string; generationId: string; transcriptPath: string };
  caller: { conversationId: string; capability: string };
  effects(): Record<string, unknown>[];
  responses(): { pathname: string; status: number; body: string }[];
  control(value: Record<string, unknown>): void;
  marker(name: string, timeoutMs?: number): Promise<void>;
  release(): void;
  resetMarkers(): void;
  startHost(): Promise<HostProcess>;
  mcp(options?: { identified?: boolean; name?: string }): Promise<McpSession>;
  registryFile(): ReturnType<AgentRegistry["readOnlySnapshot"]>;
}

async function causalFixture(prefix: string): Promise<CausalFixture> {
  const sandbox = sandboxDir(prefix);
  const environment = isolatedEnvironment(sandbox);
  const state = environment.LLV_STATE_DIR!;
  const markerDir = path.join(sandbox, "markers");
  const transcriptRoot = path.join(sandbox, "transcripts");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.mkdirSync(transcriptRoot, { recursive: true });
  const effectsPath = path.join(sandbox, "effects.ndjson");
  const responsesPath = path.join(sandbox, "responses.ndjson");
  const controlPath = path.join(sandbox, "control.json");
  fs.writeFileSync(controlPath, JSON.stringify({ mode: "respond" }));

  const registry = new AgentRegistry(path.join(state, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const transcriptPath = path.join(transcriptRoot, "recipient.jsonl");
  fs.writeFileSync(transcriptPath, "{}\n");
  registry.reconcileConversations([{
    engine: "codex",
    path: transcriptPath,
    accountId: "fixture-recipient-account",
    launchProfile: emptyLaunchProfile({ cwd: sandbox }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-09-05T08:00:00.000Z",
  }]);
  const recipientConversation = Object.values(registry.snapshot().conversations)[0]!;
  const recipient = {
    conversationId: recipientConversation.id,
    generationId: recipientConversation.generations.at(-1)!.id,
    transcriptPath,
  };
  /* The calling conversation: a launch receipt of its own, whose capability is
     what the MCP process presents. That is the identity the recovery contract
     binds to — server-derived, never something the arguments could say. */
  const callerReceipt = registry.beginSpawn("codex", sandbox, { cwd: sandbox, title: "Causal proof caller" });
  const capability = registry.rotateSpawnCapabilityForReceipt(callerReceipt.launchId);

  const config = {
    portFile: path.join(sandbox, "host.port"),
    effectsPath,
    responsesPath,
    controlPath,
    markerDir,
    recipientGenerationId: recipient.generationId,
    transcriptRoot,
  };
  const configPath = path.join(sandbox, "host.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  /* The production spawn route enumerates the launch account's MCP servers by
     running the engine binary; the controlled runtime answers with none. */
  const codexBinary = path.join(sandbox, "codex");
  fs.writeFileSync(codexBinary, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });

  let hosts = 0;
  const fixture: CausalFixture = {
    sandbox,
    state,
    environment,
    registry,
    recipient,
    caller: { conversationId: callerReceipt.conversationId, capability },
    effects: () => (fs.existsSync(effectsPath)
      ? fs.readFileSync(effectsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : []),
    responses: () => (fs.existsSync(responsesPath)
      ? fs.readFileSync(responsesPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pathname: string; status: number; body: string })
      : []),
    control: (value) => fs.writeFileSync(controlPath, JSON.stringify(value)),
    marker: async (name, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      const file = path.join(markerDir, name);
      while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`marker ${name} never appeared`);
        await Bun.sleep(5);
      }
    },
    release: () => fs.writeFileSync(path.join(markerDir, "release"), "1"),
    resetMarkers: () => {
      for (const entry of fs.readdirSync(markerDir)) fs.rmSync(path.join(markerDir, entry), { force: true });
    },
    startHost: async () => {
      hosts += 1;
      fs.rmSync(config.portFile, { force: true });
      const child = Bun.spawn([
        process.execPath,
        path.join(process.cwd(), "src", "lib", "mcp", "receiptStoreProbeChild.ts"),
        "http-host",
        configPath,
      ], {
        cwd: process.cwd(),
        env: {
          ...environment,
          LLV_SPAWN_TRANSPORT: "structured",
          LLV_RUNTIME_HOST_SOCKET: path.join(state, "runtime-host.sock"),
          LLV_CODEX_BINARY: codexBinary,
          NODE_ENV: "test",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(config.portFile)) {
        if (child.exitCode !== null) throw new Error(`host ${hosts} exited: ${await new Response(child.stderr).text()}`);
        if (Date.now() > deadline) { child.kill(9); throw new Error(`host ${hosts} never published its port`); }
        await Bun.sleep(10);
      }
      const port = Number(fs.readFileSync(config.portFile, "utf8"));
      return {
        process: child,
        origin: `http://127.0.0.1:${port}`,
        stderr: () => new Response(child.stderr).text(),
        stop: async () => { child.kill(); await Promise.race([child.exited, Bun.sleep(2_000)]); },
        kill: async () => { child.kill(9); await Promise.race([child.exited, Bun.sleep(2_000)]); },
      };
    },
    mcp: (options = {}) => startMcp({
      ...environment,
      LLV_VIEWER_CONTROL_URL: `http://127.0.0.1:${Number(fs.readFileSync(config.portFile, "utf8"))}`,
      ...(options.identified === false ? {} : { LLV_SPAWN_CAPABILITY: capability }),
    }, options.name ?? "viewer-causal-proof"),
    registryFile: () => registry.readOnlySnapshot(),
  };
  return fixture;
}

function sendArguments(fixture: CausalFixture, clientRequestId: string, extra: Record<string, unknown> = {}) {
  return { clientRequestId, conversationId: fixture.recipient.conversationId, text: "hold the cutover until I say go", ...extra };
}

function spawnArguments(fixture: CausalFixture, clientRequestId: string, extra: Record<string, unknown> = {}) {
  return { clientRequestId, cwd: fixture.sandbox, "prompt": "Inspect the fixture checkout.", title: "Causal proof launch", engine: "codex", ...extra };
}

async function call(session: McpSession, name: "send_message" | "spawn_agent", args: Record<string, unknown>) {
  const result = await session.client.callTool({ name, arguments: args });
  return result.structuredContent as Record<string, unknown> & { details?: Record<string, unknown> };
}

test("send: acceptance, lost response, original-key recovery — one recipient delivery, across process restart", async () => {
  const fixture = await causalFixture("llv-1490-send-");
  let host = await fixture.startHost();
  let mcp = await fixture.mcp();
  try {
    /* Lose the response AFTER the production handler accepted and the
       controlled recipient took the message. */
    fixture.control({ mode: "lose", sendEffect: "deliver" });
    const original = call(mcp, "send_message", sendArguments(fixture, "send-lost-1"));
    await fixture.marker("accepted");
    expect(fixture.effects().filter((effect) => effect.kind === "recipient")).toHaveLength(1);
    await host.kill();
    const lost = await original;
    /* The reset reaches the MCP process as uncertainty; the immediate
       evidence read already finds the settled delivery under the ORIGINAL
       key, with the operation id the recipient actually took. */
    expect(lost).toMatchObject({ ok: true, recovered: true, outcome: "settled", state: "delivered", resend: "not-needed", nextAction: "follow-disposition" });
    expect(typeof lost.operationId).toBe("string");
    const operationId = lost.operationId as string;

    /* Recovery under the original key and unchanged payload, host restarted. */
    fixture.control({ mode: "respond" });
    host = await fixture.startHost();
    const recovered = await call(mcp, "send_message", sendArguments(fixture, "send-lost-1", { recoveryOnly: true }));
    expect(recovered).toMatchObject({ ok: true, recovered: true, outcome: "settled", operationId, state: "delivered", replayed: true });
    const ordinary = await call(mcp, "send_message", sendArguments(fixture, "send-lost-1"));
    expect(ordinary).toMatchObject({ ok: true, recovered: true, outcome: "settled", operationId });

    /* The MCP process restarts against the same stores: same answer, no dispatch. */
    await mcp.close();
    mcp = await fixture.mcp({ name: "viewer-causal-proof-restarted" });
    const afterRestart = await call(mcp, "send_message", sendArguments(fixture, "send-lost-1", { recoveryOnly: true }));
    expect(afterRestart).toMatchObject({ ok: true, outcome: "settled", operationId });
    const receipt = await mcp.client.callTool({ name: "message_receipt", arguments: { clientRequestId: "send-lost-1-receipt", operationId } });
    expect(receipt.structuredContent).toMatchObject({ ok: true, operationId, state: "delivered" });

    /* Exactly one recipient delivery and one reservation for the key. */
    expect(fixture.effects().filter((effect) => effect.kind === "recipient")).toHaveLength(1);
    const reservations = Object.values(fixture.registryFile().heldDeliveries).filter((delivery) => delivery.clientMessageId === "send-lost-1");
    expect(reservations).toHaveLength(1);
  } finally {
    await mcp.close();
    await host.stop();
  }
}, 40_000);

test("spawn: acceptance, lost response, original-key recovery — one launch, one conversation, one writer, across process restart", async () => {
  const fixture = await causalFixture("llv-1490-spawn-");
  let host = await fixture.startHost();
  let mcp = await fixture.mcp();
  try {
    fixture.control({ mode: "lose" });
    const original = call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-lost-1"));
    await fixture.marker("accepted");
    const launched = fixture.effects().filter((effect) => effect.kind === "writer");
    if (launched.length !== 1) throw new Error(`writer effects: ${JSON.stringify(fixture.effects())}; responses: ${JSON.stringify(fixture.responses())}`);
    await host.kill();
    const lost = await original;
    expect(lost).toMatchObject({ ok: true, recovered: true, nextAction: "original-key-lookup", launchId: launched[0]!.launchId, conversationId: launched[0]!.conversationId });
    expect(["accepted", "in-flight"]).toContain(String(lost.outcome));

    fixture.control({ mode: "respond" });
    host = await fixture.startHost();
    const recovered = await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-lost-1", { recoveryOnly: true }));
    expect(recovered).toMatchObject({ ok: true, recovered: true, launchId: launched[0]!.launchId, conversationId: launched[0]!.conversationId, replayed: true });
    const ordinary = await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-lost-1"));
    expect(ordinary).toMatchObject({ ok: true, recovered: true, launchId: launched[0]!.launchId });

    await mcp.close();
    mcp = await fixture.mcp({ name: "viewer-causal-proof-restarted" });
    const afterRestart = await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-lost-1", { recoveryOnly: true }));
    expect(afterRestart).toMatchObject({ ok: true, launchId: launched[0]!.launchId });

    expect(fixture.effects().filter((effect) => effect.kind === "writer")).toHaveLength(1);
    const receipts = Object.values(fixture.registryFile().receipts).filter((receipt) => receipt.clientAttemptId === "spawn-lost-1");
    expect(receipts).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.conversationId)).size).toBe(1);
  } finally {
    await mcp.close();
    await host.stop();
  }
}, 40_000);

test("lookup before acceptance stays unknown, late acceptance is then found, and a late original response never regresses the terminal answer", async () => {
  const fixture = await causalFixture("llv-1490-late-");
  const host = await fixture.startHost();
  const original = await fixture.mcp({ name: "viewer-original" });
  const observer = await fixture.mcp({ name: "viewer-observer" });
  try {
    /* The host reaches the request and holds it BEFORE the handler runs. */
    fixture.control({ mode: "hold-before", sendEffect: "deliver" });
    const inFlight = call(original, "send_message", sendArguments(fixture, "send-late-1"));
    await fixture.marker("reached");
    const early = await call(observer, "send_message", sendArguments(fixture, "send-late-1", { recoveryOnly: true }));
    expect(early).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown", nextAction: "original-key-lookup" } });
    expect(fixture.effects()).toHaveLength(0);

    /* Late acceptance: the handler runs, the recipient takes it, the original
       response is answered. Nothing was dispatched twice. */
    fixture.release();
    const settled = await inFlight;
    expect(settled).toMatchObject({ ok: true, replayed: false, outcome: "delivered", settled: true });
    expect(fixture.effects().filter((effect) => effect.kind === "recipient")).toHaveLength(1);
    const late = await call(observer, "send_message", sendArguments(fixture, "send-late-1", { recoveryOnly: true }));
    expect(late).toMatchObject({ ok: true, outcome: "settled", state: "delivered", operationId: settled.operationId });
    expect(late.original).toMatchObject({ ok: true, operationId: settled.operationId });

    /* A response that arrives AFTER a recovery already answered: the
       original settles its own success and the recovery answer stands. */
    fixture.resetMarkers();
    fixture.control({ mode: "hold", sendEffect: "deliver" });
    const held = call(original, "send_message", sendArguments(fixture, "send-late-2"));
    await fixture.marker("accepted");
    const during = await call(observer, "send_message", sendArguments(fixture, "send-late-2", { recoveryOnly: true }));
    expect(during).toMatchObject({ ok: true, outcome: "settled", state: "delivered" });
    fixture.release();
    const originalAnswer = await held;
    expect(originalAnswer).toMatchObject({ ok: true, replayed: false, operationId: during.operationId });
    const after = await call(observer, "send_message", sendArguments(fixture, "send-late-2"));
    expect(after).toMatchObject({ ok: true, replayed: true, operationId: during.operationId });
    expect(fixture.effects().filter((effect) => effect.kind === "recipient")).toHaveLength(2);
  } finally {
    await original.close();
    await observer.close();
    await host.stop();
  }
}, 40_000);

test("network failure without dispatch proof stays unknown and never redelivers; proven pre-dispatch rejection has zero effects", async () => {
  const fixture = await causalFixture("llv-1490-negative-");
  let host = await fixture.startHost();
  const mcp = await fixture.mcp();
  try {
    /* The connection dies while the host holds the request BEFORE the
       handler runs: nothing executed, and nothing can prove it. */
    fixture.control({ mode: "hold-before" });
    const inFlight = call(mcp, "send_message", sendArguments(fixture, "send-cut-1"));
    await fixture.marker("reached");
    await host.kill();
    const cut = await inFlight;
    expect(cut).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false, details: { outcome: "unknown", nextAction: "original-key-lookup" } });
    expect(fixture.effects()).toHaveLength(0);

    /* The host is back. The same key, ordinary or explicit, is a READ: the
       unknown stays unknown and the recipient still has nothing. */
    fixture.resetMarkers();
    fixture.control({ mode: "respond" });
    host = await fixture.startHost();
    expect(await call(mcp, "send_message", sendArguments(fixture, "send-cut-1"))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(await call(mcp, "send_message", sendArguments(fixture, "send-cut-1", { recoveryOnly: true }))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(fixture.effects()).toHaveLength(0);

    /* A pre-dispatch rejection by the production route: no receipt, no writer. */
    const rejected = await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-rejected-1", { cwd: path.join(fixture.sandbox, "missing") }));
    expect(rejected).toMatchObject({ ok: false, code: "tool_failed", details: { outcome: "not-executed", nextAction: "new-request-permitted" } });
    expect(await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-rejected-1", { cwd: path.join(fixture.sandbox, "missing") })))
      .toMatchObject({ ok: false, replayed: true, details: { outcome: "not-executed" } });
    expect(fixture.effects()).toHaveLength(0);
    expect(Object.values(fixture.registryFile().receipts).filter((receipt) => receipt.clientAttemptId === "spawn-rejected-1")).toHaveLength(0);

    /* recoveryOnly under a key nothing ever claimed starts no work and closes
       the key: a later ordinary call under it cannot dispatch. */
    const probe = await call(mcp, "send_message", sendArguments(fixture, "send-never-1", { recoveryOnly: true }));
    expect(probe).toMatchObject({ ok: false, code: "not_executed", details: { outcome: "not-executed" } });
    expect(await call(mcp, "send_message", sendArguments(fixture, "send-never-1"))).toMatchObject({ ok: false, code: "not_executed", replayed: true });
    expect(fixture.effects()).toHaveLength(0);
  } finally {
    await mcp.close();
    await host.stop();
  }
}, 40_000);

test("spoofing and concurrency: another caller, a changed payload, and two processes racing one key", async () => {
  const fixture = await causalFixture("llv-1490-spoof-");
  const host = await fixture.startHost();
  const owner = await fixture.mcp({ name: "viewer-owner" });
  const stranger = await fixture.mcp({ identified: false, name: "viewer-stranger" });
  const peer = await fixture.mcp({ name: "viewer-peer" });
  try {
    fixture.control({ mode: "respond", sendEffect: "queue" });
    const accepted = await call(owner, "send_message", sendArguments(fixture, "send-owned-1"));
    expect(accepted).toMatchObject({ ok: true, outcome: "queued", settled: false });

    /* An unidentified caller — the same key, the same payload, even forged
       caller fields — learns nothing. */
    const forged = await call(stranger, "send_message", sendArguments(fixture, "send-owned-1", {
      recoveryOnly: true,
      callerConversationId: fixture.caller.conversationId,
      callerProject: "spoofed",
    }));
    expect(forged).toMatchObject({ ok: false, code: "recovery_not_permitted" });
    expect(forged.details).toBeUndefined();
    expect(JSON.stringify(forged)).not.toContain(String(accepted.operationId));

    /* The owner with a changed payload is a conflict, not a second send. */
    expect(await call(owner, "send_message", sendArguments(fixture, "send-owned-1", { text: "changed" })))
      .toMatchObject({ ok: false, code: "idempotency_conflict" });
    /* The owner's forged fields change the digest, never the authority. */
    expect(await call(owner, "send_message", sendArguments(fixture, "send-owned-1", { recoveryOnly: true })))
      .toMatchObject({ ok: true, outcome: "in-flight", operationId: accepted.operationId, state: "in-flight", nextAction: "original-key-lookup" });

    /* Two processes race one fresh key: exactly one dispatch owner, and the
       other answers from evidence. */
    fixture.control({ mode: "respond", sendEffect: "deliver" });
    const race = await Promise.all([
      call(owner, "send_message", sendArguments(fixture, "send-race-1")),
      call(peer, "send_message", sendArguments(fixture, "send-race-1")),
    ]);
    expect(race.every((answer) => answer.ok === true)).toBe(true);
    const operationIds = new Set(race.map((answer) => answer.operationId));
    expect(operationIds.size).toBe(1);
    expect(race.filter((answer) => answer.replayed === false)).toHaveLength(1);
    expect(fixture.effects().filter((effect) => effect.kind === "recipient" && effect.clientMessageId === "send-race-1")).toHaveLength(1);
  } finally {
    await owner.close();
    await stranger.close();
    await peer.close();
    await host.stop();
  }
}, 40_000);
