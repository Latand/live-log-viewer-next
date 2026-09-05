import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { Database } from "bun:sqlite";

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

/**
 * A calling conversation the packaged MCP server can present: a launch
 * receipt in the sandbox registry and the spawn capability minted for it.
 * Since #1490 a recoverable mutation from a caller the server cannot identify
 * is refused before anything is claimed, so every test that dispatches one
 * speaks as this conversation.
 */
function identifiedEnvironment(sandbox: string, extra: Record<string, string> = {}): Record<string, string> {
  const environment = isolatedEnvironment(sandbox, extra);
  const registry = new AgentRegistry(path.join(environment.LLV_STATE_DIR!, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const caller = registry.beginSpawn("codex", sandbox, { cwd: sandbox, title: "Packaged MCP caller" });
  return { ...environment, LLV_SPAWN_CAPABILITY: registry.rotateSpawnCapabilityForReceipt(caller.launchId) };
}

function spawnResult(label: string): Response {
  return Response.json({
    conversationId: `conversation_${label}`,
    path: `/fixture/${label}.jsonl`,
    launchId: `launch_${label}`,
    state: "starting",
    initialMessage: "pending",
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
  const environment = identifiedEnvironment(sandbox, {
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

    /* A repeat under the key, explicit or ordinary, is a READ of the durable
       record — which holds no launch receipt for it, so the fate stays
       unknown — and still dispatches nothing. */
    for (const extra of [{ recoveryOnly: true }, {}]) {
      const lookup = await callSpawn(session.client, "restart-during", extra);
      expect(lookup.structuredContent).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false, replayed: true, details: { outcome: "unknown", nextAction: "original-key-lookup" } });
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
  const session = await startMcp(identifiedEnvironment(sandbox, {
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
  /** Releases the execution barrier: admitted effects run from here on. */
  execute(): void;
  resetMarkers(): void;
  startHost(): Promise<HostProcess>;
  /** `caller: "other"` speaks as a second authenticated conversation — a
      launch receipt of its own with its own capability. */
  mcp(options?: { identified?: boolean; name?: string; caller?: "owner" | "other" }): Promise<McpSession>;
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
  const otherReceipt = registry.beginSpawn("codex", sandbox, { cwd: sandbox, title: "Causal proof other caller" });
  const otherCapability = registry.rotateSpawnCapabilityForReceipt(otherReceipt.launchId);

  /* One stable port for every generation of the controlled host, as the
     production Viewer has: an MCP process keeps its endpoint across a host
     restart, so a call after the restart reaches the production route rather
     than a dead port. */
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  await probe.stop(true);
  const config = {
    portFile: path.join(sandbox, "host.port"),
    port,
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
    execute: () => fs.writeFileSync(path.join(markerDir, "execute"), "1"),
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
      ...(options.identified === false ? {} : { LLV_SPAWN_CAPABILITY: options.caller === "other" ? otherCapability : capability }),
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

    /* A response that arrives AFTER a recovery already answered from
       terminal evidence: that answer was written when it was seen, so the
       original's own call receives it too, and nothing later replaces it. */
    fixture.resetMarkers();
    fixture.control({ mode: "hold", sendEffect: "deliver" });
    const held = call(original, "send_message", sendArguments(fixture, "send-late-2"));
    await fixture.marker("accepted");
    const during = await call(observer, "send_message", sendArguments(fixture, "send-late-2", { recoveryOnly: true }));
    expect(during).toMatchObject({ ok: true, outcome: "settled", state: "delivered" });
    fixture.release();
    const originalAnswer = await held;
    expect(originalAnswer).toMatchObject({ ok: true, outcome: "settled", state: "delivered", operationId: during.operationId, replayed: true });
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

    /* A route rejection without affirmative dispatch proof stays unknown. */
    const rejected = await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-rejected-1", { cwd: path.join(fixture.sandbox, "missing") }));
    expect(rejected).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown", nextAction: "original-key-lookup" } });
    /* The observed 4xx alone does not prove that no work was admitted. */
    expect(String(rejected.error)).not.toContain("connection was refused");
    const verdicts = fixture.responses().filter((response) => response.pathname === "/api/spawn" && response.body.includes("missing"));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.status).toBeGreaterThanOrEqual(400);
    expect(verdicts[0]!.status).toBeLessThan(500);

    expect(await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-rejected-1", { cwd: path.join(fixture.sandbox, "missing") })))
      .toMatchObject({ ok: false, replayed: true, details: { outcome: "unknown" } });
    expect(fixture.effects()).toHaveLength(0);
    expect(Object.values(fixture.registryFile().receipts).filter((receipt) => receipt.clientAttemptId === "spawn-rejected-1")).toHaveLength(0);

    await host.kill();
    const disconnected = await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-unconnected"));
    expect(disconnected).toMatchObject({ ok: false, details: { outcome: "not-executed", nextAction: "new-request-permitted" } });
    expect(fixture.effects()).toHaveLength(0);
    host = await fixture.startHost();

    /* recoveryOnly under a key nothing ever claimed starts no work and writes
       nothing: unknown, because the original may still be on its way — and
       when it arrives it claims and dispatches exactly once. */
    const probe = await call(mcp, "send_message", sendArguments(fixture, "send-never-1", { recoveryOnly: true }));
    expect(probe).toMatchObject({ ok: false, code: "outcome_unknown", replayed: false, details: { outcome: "unknown", evidence: "none", nextAction: "original-key-lookup" } });
    expect(fixture.effects()).toHaveLength(0);
    const arrived = await call(mcp, "send_message", sendArguments(fixture, "send-never-1"));
    expect(arrived).toMatchObject({ ok: true, replayed: false, outcome: "delivered" });
    expect(fixture.effects().filter((effect) => effect.kind === "recipient" && effect.clientMessageId === "send-never-1")).toHaveLength(1);
    expect(await call(mcp, "send_message", sendArguments(fixture, "send-never-1", { recoveryOnly: true })))
      .toMatchObject({ ok: true, outcome: "settled", operationId: arrived.operationId, state: "delivered" });
    expect(fixture.effects().filter((effect) => effect.kind === "recipient" && effect.clientMessageId === "send-never-1")).toHaveLength(1);
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
       caller fields — learns nothing, and cannot dispatch a fresh mutation
       either: the refusal is the same under an existing and an absent key. */
    const forged = await call(stranger, "send_message", sendArguments(fixture, "send-owned-1", {
      recoveryOnly: true,
      callerConversationId: fixture.caller.conversationId,
      callerProject: "spoofed",
    }));
    expect(forged).toMatchObject({ ok: false, code: "caller_unidentified", retryable: false });
    expect(forged.details).toBeUndefined();
    expect(JSON.stringify(forged)).not.toContain(String(accepted.operationId));
    for (const [name, args] of [
      ["send_message", sendArguments(fixture, "send-owned-1")],
      ["send_message", sendArguments(fixture, "send-anonymous-1")],
      ["spawn_agent", spawnArguments(fixture, "spawn-anonymous-1")],
    ] as const) {
      const refused = await call(stranger, name, args);
      expect(refused).toMatchObject({ ok: false, code: "caller_unidentified", replayed: false });
      expect(refused.details).toBeUndefined();
    }
    expect(fixture.effects().filter((effect) => String(effect.clientMessageId ?? effect.clientAttemptId).includes("anonymous"))).toHaveLength(0);
    expect(fixture.responses().filter((response) => response.body.includes("anonymous"))).toHaveLength(0);
    expect(Object.values(fixture.registryFile().receipts).filter((receipt) => receipt.clientAttemptId === "spawn-anonymous-1")).toHaveLength(0);

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

test("send: admitted, response lost BEFORE the recipient acts, original-key recovery across MCP and host restart — one recipient delivery", async () => {
  const fixture = await causalFixture("llv-1490-send-barrier-");
  let host = await fixture.startHost();
  let mcp = await fixture.mcp();
  try {
    /* The production handler admits the send (the reservation exists), the
       response is cut after its status line, and the recipient has NOT yet
       taken anything: two barriers, admission and execution, and the loss
       happens between them. */
    fixture.control({ mode: "cut", sendEffect: "deliver", admission: "hold-effect" });
    const original = call(mcp, "send_message", sendArguments(fixture, "send-barrier-1"));
    await fixture.marker("admitted");
    await fixture.marker("accepted");
    expect(fixture.effects()).toHaveLength(0);
    const lost = await original;
    expect(lost).toMatchObject({ ok: true, recovered: true, outcome: "accepted", state: "in-flight", nextAction: "original-key-lookup" });
    expect(typeof lost.operationId).toBe("string");
    const operationId = lost.operationId as string;
    expect(fixture.effects()).toHaveLength(0);

    /* The MCP process that made the call is gone before anything executed.
       A fresh one, under the original key, reads the admission and starts
       nothing; the ordinary call under the key starts nothing either. */
    await mcp.close();
    mcp = await fixture.mcp({ name: "viewer-causal-proof-restarted" });
    expect(await call(mcp, "send_message", sendArguments(fixture, "send-barrier-1", { recoveryOnly: true })))
      .toMatchObject({ ok: true, outcome: "accepted", operationId, replayed: true });
    expect(await call(mcp, "send_message", sendArguments(fixture, "send-barrier-1")))
      .toMatchObject({ ok: true, outcome: "accepted", operationId, replayed: true });
    expect(fixture.effects()).toHaveLength(0);

    /* Execution is released: the recipient takes the admitted send once. */
    fixture.execute();
    const deadline = Date.now() + 10_000;
    while (fixture.effects().length === 0) {
      if (Date.now() > deadline) throw new Error("the admitted send never executed");
      await Bun.sleep(5);
    }
    const recovered = await call(mcp, "send_message", sendArguments(fixture, "send-barrier-1", { recoveryOnly: true }));
    expect(recovered).toMatchObject({ ok: true, outcome: "settled", operationId, state: "delivered", resend: "not-needed", nextAction: "follow-disposition" });

    /* The host restarts against the same stores: same answer, nothing new. */
    await host.kill();
    fixture.control({ mode: "respond" });
    host = await fixture.startHost();
    expect(await call(mcp, "send_message", sendArguments(fixture, "send-barrier-1")))
      .toMatchObject({ ok: true, outcome: "settled", operationId, state: "delivered" });
    const receipt = await mcp.client.callTool({ name: "message_receipt", arguments: { clientRequestId: "send-barrier-1-receipt", operationId } });
    expect(receipt.structuredContent).toMatchObject({ ok: true, operationId, state: "delivered" });

    const deliveries = fixture.effects().filter((effect) => effect.kind === "recipient");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ clientMessageId: "send-barrier-1", operationId });
    expect(Object.values(fixture.registryFile().heldDeliveries).filter((delivery) => delivery.clientMessageId === "send-barrier-1")).toHaveLength(1);
    expect(fixture.responses().filter((response) => response.pathname === "/api/tmux" && response.body.includes("send-barrier-1"))).toHaveLength(1);
  } finally {
    await mcp.close();
    await host.stop();
  }
}, 40_000);

test("spawn: admitted, response lost BEFORE the writer acts, original-key recovery across MCP and host restart — one launch, one conversation, one writer", async () => {
  const fixture = await causalFixture("llv-1490-spawn-barrier-");
  let host = await fixture.startHost();
  let mcp = await fixture.mcp();
  try {
    fixture.control({ mode: "cut", admission: "hold-effect" });
    const original = call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-barrier-1"));
    await fixture.marker("admitted");
    await fixture.marker("accepted");
    expect(fixture.effects()).toHaveLength(0);
    const lost = await original;
    expect(lost).toMatchObject({ ok: true, recovered: true, nextAction: "original-key-lookup" });
    expect(["accepted", "in-flight"]).toContain(String(lost.outcome));
    const launchId = lost.launchId as string;
    const conversationId = lost.conversationId as string;
    expect(typeof launchId).toBe("string");
    expect(typeof conversationId).toBe("string");
    expect(fixture.effects()).toHaveLength(0);

    await mcp.close();
    mcp = await fixture.mcp({ name: "viewer-causal-proof-restarted" });
    expect(await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-barrier-1", { recoveryOnly: true })))
      .toMatchObject({ ok: true, launchId, conversationId, replayed: true });
    expect(await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-barrier-1")))
      .toMatchObject({ ok: true, launchId, conversationId, replayed: true });
    expect(fixture.effects()).toHaveLength(0);

    fixture.execute();
    const deadline = Date.now() + 10_000;
    while (fixture.effects().length === 0) {
      if (Date.now() > deadline) throw new Error("the admitted launch never executed");
      await Bun.sleep(5);
    }
    expect(await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-barrier-1", { recoveryOnly: true })))
      .toMatchObject({ ok: true, launchId, conversationId });

    await host.kill();
    fixture.control({ mode: "respond" });
    host = await fixture.startHost();
    expect(await call(mcp, "spawn_agent", spawnArguments(fixture, "spawn-barrier-1")))
      .toMatchObject({ ok: true, launchId, conversationId });

    const launches = fixture.effects().filter((effect) => effect.kind === "writer");
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ launchId, conversationId, clientAttemptId: "spawn-barrier-1" });
    const receipts = Object.values(fixture.registryFile().receipts).filter((receipt) => receipt.clientAttemptId === "spawn-barrier-1");
    expect(receipts).toHaveLength(1);
    expect(String(receipts[0]?.conversationId)).toBe(conversationId);
    expect(fixture.responses().filter((response) => response.pathname === "/api/spawn" && response.body.includes(launchId))).toHaveLength(1);
  } finally {
    await mcp.close();
    await host.stop();
  }
}, 40_000);

test("a lookup from another process before the original ever claims stays unknown, writes nothing, and the original then dispatches once", async () => {
  const fixture = await causalFixture("llv-1490-before-claim-");
  const host = await fixture.startHost();
  const owner = await fixture.mcp({ name: "viewer-owner" });
  const observer = await fixture.mcp({ name: "viewer-observer" });
  try {
    fixture.control({ mode: "respond", sendEffect: "deliver" });
    for (const name of ["send_message", "spawn_agent"] as const) {
      const args = name === "send_message" ? sendArguments(fixture, "before-claim-1") : spawnArguments(fixture, "before-claim-1");
      const early = await call(observer, name, { ...args, recoveryOnly: true });
      expect(early).toMatchObject({ ok: false, code: "outcome_unknown", replayed: false, details: { outcome: "unknown", evidence: "none", nextAction: "original-key-lookup" } });
      /* The original, arriving after the lookup, is not suppressed: it
         claims, dispatches once, and the observer then reads its record. */
      const original = await call(owner, name, args);
      expect(original).toMatchObject({ ok: true, replayed: false });
      const late = await call(observer, name, { ...args, recoveryOnly: true });
      expect(late).toMatchObject({ ok: true, recovered: true, replayed: true });
      expect(late.operationId ?? late.launchId).toBe(original.operationId ?? original.launchId);
    }
    expect(fixture.effects().filter((effect) => effect.kind === "recipient")).toHaveLength(1);
    expect(fixture.effects().filter((effect) => effect.kind === "writer")).toHaveLength(1);
  } finally {
    await owner.close();
    await observer.close();
    await host.stop();
  }
}, 40_000);

test("send: a delayed 409 after recovery already proved delivery never regresses the answer — across MCP restart, one recipient delivery", async () => {
  const fixture = await causalFixture("llv-1490-late-verdict-");
  const host = await fixture.startHost();
  let original = await fixture.mcp({ name: "viewer-original" });
  const observer = await fixture.mcp({ name: "viewer-observer" });
  try {
    /* The handler delivers, the response is held, and what the original
       finally receives is the server's ambiguity verdict naming the admitted
       operation — the answer that, taken alone, settles as verify-first. */
    fixture.control({ mode: "hold", sendEffect: "deliver", lateVerdict: { status: 409 } });
    const held = call(original, "send_message", sendArguments(fixture, "send-late-verdict-1"));
    await fixture.marker("accepted");
    const during = await call(observer, "send_message", sendArguments(fixture, "send-late-verdict-1", { recoveryOnly: true }));
    expect(during).toMatchObject({ ok: true, recovered: true, outcome: "settled", state: "delivered", resend: "not-needed", nextAction: "follow-disposition" });
    const operationId = during.operationId as string;
    expect(typeof operationId).toBe("string");

    fixture.release();
    const late = await held;
    expect(late).toMatchObject({ ok: true, outcome: "settled", state: "delivered", resend: "not-needed", operationId, replayed: true });
    expect(JSON.stringify(late)).not.toContain("verify-first");
    for (const session of [original, observer]) {
      expect(await call(session, "send_message", sendArguments(fixture, "send-late-verdict-1")))
        .toMatchObject({ ok: true, outcome: "settled", state: "delivered", operationId, replayed: true });
    }

    /* A fresh MCP process against the same store reads the same answer. */
    await original.close();
    original = await fixture.mcp({ name: "viewer-original-restarted" });
    expect(await call(original, "send_message", sendArguments(fixture, "send-late-verdict-1")))
      .toMatchObject({ ok: true, outcome: "settled", state: "delivered", operationId, replayed: true });
    const receipt = await original.client.callTool({ name: "message_receipt", arguments: { clientRequestId: "send-late-verdict-1-receipt", operationId } });
    expect(receipt.structuredContent).toMatchObject({ ok: true, operationId, state: "delivered" });

    const deliveries = fixture.effects().filter((effect) => effect.kind === "recipient");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ clientMessageId: "send-late-verdict-1", operationId });
    expect(fixture.responses().filter((response) => response.pathname === "/api/tmux")).toHaveLength(1);
  } finally {
    await original.close();
    await observer.close();
    await host.stop();
  }
}, 40_000);

test("through the protocol: a lost claim discloses nothing to another caller, and an unreadable receipt row answers unknown without dispatching", async () => {
  const fixture = await causalFixture("llv-1490-store-damage-");
  const host = await fixture.startHost();
  const owner = await fixture.mcp({ name: "viewer-owner" });
  const other = await fixture.mcp({ caller: "other", name: "viewer-other" });
  try {
    fixture.control({ mode: "respond", sendEffect: "deliver" });
    const launched = await call(owner, "spawn_agent", spawnArguments(fixture, "spawn-lost-claim-1"));
    expect(launched).toMatchObject({ ok: true, replayed: false });
    const launchId = launched.launchId as string;
    const conversationId = launched.conversationId as string;
    const sent = await call(owner, "send_message", sendArguments(fixture, "send-corrupt-1"));
    expect(sent).toMatchObject({ ok: true, replayed: false });
    const operationId = sent.operationId as string;
    expect(fixture.effects()).toHaveLength(2);

    /* The receipt store is damaged underneath every process: the spawn's
       claim row is gone, and the send's row carries a binding that cannot be
       parsed. The downstream records — the launch receipt, the delivery —
       are intact. */
    const database = new Database(path.join(fixture.state, "mcp-receipts.sqlite"), { strict: true });
    database.query("DELETE FROM mcp_receipts WHERE receipt_key = ?").run("spawn_agent:spawn-lost-claim-1");
    database.query("UPDATE mcp_receipts SET binding_json = ? WHERE receipt_key = ?").run("{not json", "send_message:send-corrupt-1");
    database.close();

    for (const session of [other, owner]) {
      /* No claim: nothing establishes whose launch the intact receipt is, so
         nobody — another authenticated caller, or the owner — is handed it. */
      const absent = await call(session, "spawn_agent", spawnArguments(fixture, "spawn-lost-claim-1", { recoveryOnly: true }));
      expect(absent).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false, replayed: false, details: { outcome: "unknown", evidence: "none", nextAction: "original-key-lookup" } });
      expect(JSON.stringify(absent)).not.toContain(launchId);
      expect(JSON.stringify(absent)).not.toContain(conversationId);
      /* An unreadable row: unknown, with the guidance, and nothing read or
         dispatched on its behalf — explicit or ordinary. */
      for (const args of [sendArguments(fixture, "send-corrupt-1", { recoveryOnly: true }), sendArguments(fixture, "send-corrupt-1")]) {
        const unreadable = await call(session, "send_message", args);
        expect(unreadable).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false, details: { outcome: "unknown", evidence: "mcp-receipt-unreadable", nextAction: "original-key-lookup" } });
        expect(String(unreadable.error)).toContain("could not be read");
        expect(JSON.stringify(unreadable)).not.toContain(operationId);
      }
    }
    expect(fixture.effects()).toHaveLength(2);
    expect(fixture.responses().filter((response) => response.pathname === "/api/tmux")).toHaveLength(1);
    expect(fixture.responses().filter((response) => response.pathname === "/api/spawn")).toHaveLength(1);
  } finally {
    await owner.close();
    await other.close();
    await host.stop();
  }
}, 40_000);

for (const tool of ["send_message", "spawn_agent"] as const) {
  test(`${tool}: proxy errors after actual effect recover the original identity across process restart`, async () => {
    const fixture = await causalFixture("llv-1490-proxy-");
    let host = await fixture.startHost();
    let mcp = await fixture.mcp();
    try {
      // Cover timeout, throttling, nonstandard client/proxy and server errors,
      // with both unreadable and valid JSON bodies after actual acceptance.
      for (const status of [400, 408, 425, 429, 499, 500, 502, 503, 504]) {
        for (const lostJson of [false, true]) {
          const key = `proxy-${status}-${lostJson}`;
          const args = tool === "send_message" ? sendArguments(fixture, key) : spawnArguments(fixture, key);
          fixture.control({ lostStatus: status, lostJson });
          const before = fixture.effects().length;
          const result = await call(mcp, tool, args);
          expect(fixture.effects()).toHaveLength(before + 1);
          const effect = fixture.effects().at(-1)!;
          const ids = tool === "send_message"
            ? { operationId: effect.operationId }
            : { launchId: effect.launchId, conversationId: effect.conversationId };
          expect(result).toMatchObject({ ok: true, recovered: true, ...ids });
          expect(result.nextAction).not.toBe("new-request-permitted");
          await mcp.close();
          await host.kill();
          fixture.control({ mode: "respond" });
          host = await fixture.startHost();
          mcp = await fixture.mcp();
          for (const recoveryOnly of [true, false]) {
            expect(await call(mcp, tool, { ...args, recoveryOnly })).toMatchObject({ ok: true, ...ids });
          }
          expect(fixture.effects()).toHaveLength(before + 1);
          if (tool === "spawn_agent") {
            const receipts = Object.values(fixture.registryFile().receipts).filter((receipt) => receipt.clientAttemptId === key);
            expect(receipts).toHaveLength(1);
            expect(receipts[0]).toMatchObject({ conversationId: effect.conversationId });
          }
        }
      }
    } finally {
      await mcp.close();
      await host.stop();
    }
  }, 120_000);
}

test("path-only send: late registration after binding, lost response, and restart retain one delivery", async () => {
  const fixture = await causalFixture("llv-1490-path-");
  let host = await fixture.startHost();
  let mcp = await fixture.mcp();
  const transcriptPath = path.join(fixture.sandbox, "late-recipient.jsonl");
  const args = { clientRequestId: "late-path", transcriptPath, text: "late registered recipient" };
  try {
    expect(fixture.registry.conversationForPath(transcriptPath)).toBeNull();
    fixture.control({ mode: "hold-before", lostStatus: 408 });
    const original = call(mcp, "send_message", args);
    await fixture.marker("reached");
    // HTTP has received the already-bound request but has not handled it yet.
    fixture.registry.recordConversationContinuityPath(fixture.recipient.conversationId as `conversation_${string}`, transcriptPath);
    fixture.release();
    // The fixture replaces the accepted response with an unreadable 408.
    const result = await original;
    expect(result).toMatchObject({ ok: true, recovered: true, outcome: "settled" });
    await mcp.close();
    await host.kill();
    fixture.control({ mode: "respond" });
    host = await fixture.startHost();
    mcp = await fixture.mcp();
    const recovered = await call(mcp, "send_message", { ...args, recoveryOnly: true });
    expect(recovered).toMatchObject({ ok: true, outcome: "settled", operationId: fixture.effects()[0]!.operationId });
    expect(fixture.effects()).toHaveLength(1);
  } finally {
    await mcp.close();
    await host.stop();
  }
}, 40_000);


for (const { tool, idBearingError } of (["send_message", "spawn_agent"] as const)
  .flatMap((tool) => [false, true].map((idBearingError) => ({ tool, idBearingError })))) {
  test(`${tool}: ${idBearingError ? "ID-bearing error" : "incomplete successful JSON"} recovers admission before execution and across restart`, async () => {
    const fixture = await causalFixture("llv-1490-incomplete-");
    let host = await fixture.startHost();
    let mcp = await fixture.mcp();
    try {
      const answers = tool === "send_message"
        ? [{}, { ok: true }, { outcome: "delivered" }, { operationId: "op_incomplete" },
          { operationId: "op_incomplete", outcome: "delivered", receipt: { operationId: "op_other", status: "queued" } }]
        : [{}, { ok: true }, { state: "settled" }, { launchId: "launch_incomplete" },
          { launchId: "launch_incomplete", conversationId: "conversation_incomplete", state: "starting", initialMessage: "delivered" }];
      for (const [index, replacedAnswer] of (idBearingError ? [{}] : answers).entries()) {
        fixture.resetMarkers();
        fixture.control(idBearingError
          ? { admission: "hold-effect", mode: "hold", lateVerdict: { status: 503 } }
          : { admission: "hold-effect", replacedAnswer });
        const key = `incomplete-${index}`;
        const args = tool === "send_message" ? sendArguments(fixture, key) : spawnArguments(fixture, key);
        const before = fixture.effects().length;
        const original = call(mcp, tool, args);
        await fixture.marker("admitted");
        await fixture.marker("accepted");
        if (idBearingError) fixture.release();
        const result = await original;
        expect(fixture.effects()).toHaveLength(before);
        expect(result).toMatchObject({ ok: true, recovered: true, nextAction: "original-key-lookup" });
        expect(["accepted", "in-flight"]).toContain(String(result.outcome));
        const actual = JSON.parse(fixture.responses().at(-1)!.body);
        const ids = tool === "send_message"
          ? { operationId: actual.operationId }
          : { launchId: actual.launchId, conversationId: actual.conversationId };
        expect(result).toMatchObject(ids);
        expect(Object.values(ids).every((id) => typeof id === "string" && id.length > 0)).toBe(true);
        await mcp.close();
        mcp = await fixture.mcp();
        for (const recoveryOnly of [true, false]) {
          const replay = await call(mcp, tool, { ...args, recoveryOnly });
          expect(replay).toMatchObject({ ok: true, recovered: true, ...ids });
          expect(["accepted", "in-flight"]).toContain(String(replay.outcome));
        }
        expect(fixture.effects()).toHaveLength(before);
        fixture.execute();
        const deadline = Date.now() + 10_000;
        while (fixture.effects().length === before) {
          if (Date.now() > deadline) throw new Error("the admitted operation never executed");
          await Bun.sleep(5);
        }
        expect(fixture.effects()).toHaveLength(before + 1);
        expect(fixture.effects().at(-1)).toMatchObject(ids);
        await mcp.close();
        await host.kill();
        fixture.control({ mode: "respond" });
        host = await fixture.startHost();
        mcp = await fixture.mcp();
        for (const recoveryOnly of [true, false]) {
          const replay = await call(mcp, tool, { ...args, recoveryOnly });
          expect(replay).toMatchObject({ ok: true, ...ids });
          if (tool === "send_message") expect(replay).toMatchObject({ outcome: "settled", state: "delivered" });
        }
        expect(fixture.effects()).toHaveLength(before + 1);
        if (tool === "spawn_agent") {
          const receipts = Object.values(fixture.registryFile().receipts).filter((receipt) => receipt.clientAttemptId === key);
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject(ids);
        } else {
          const deliveries = Object.values(fixture.registryFile().heldDeliveries).filter((delivery) => delivery.clientMessageId === key);
          expect(deliveries).toHaveLength(1);
        }
      }
    } finally {
      await mcp.close();
      await host.stop();
    }
  }, 120_000);
}
