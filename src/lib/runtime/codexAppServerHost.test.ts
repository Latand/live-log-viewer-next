import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import { CodexAppServerHost, redactCodexHostDiagnostic } from "./codexAppServerHost";
import type { RuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import { adoptCodexRegistryHosts, bindCodexHostPersistence, persistCodexHost, startCodexStructuredHost, structuredHostsEnabled } from "./registry";

class MemoryEventStore implements RuntimeEventStore {
  private readonly events = new Map<string, RuntimeEvent[]>();

  load(threadId: string): RuntimeEvent[] {
    return structuredClone(this.events.get(threadId) ?? []);
  }

  append(threadId: string, event: RuntimeEvent): void {
    const events = this.events.get(threadId) ?? [];
    events.push(structuredClone(event));
    this.events.set(threadId, events);
  }
}

class FailingEventStore implements RuntimeEventStore {
  readonly stored: RuntimeEvent[] = [];
  appendAttempts = 0;

  load(): RuntimeEvent[] {
    return structuredClone(this.stored);
  }

  append(_threadId: string, event: RuntimeEvent): void {
    this.appendAttempts += 1;
    if (this.appendAttempts >= 2) throw new Error("ENOSPC oauth_token=must-stay-private");
    this.stored.push(structuredClone(event));
  }
}

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly signals: NodeJS.Signals[] = [];
  autoResolveServerRequests = true;
  autoCompleteUserMessage = true;
  readTurns: unknown[] | null = null;
  readError: string | null = null;
  private readonly serverRequestIds = new Set<string | number>();
  private turn = 0;

  constructor(
    private readonly threadId = "thread-149",
    private readonly resumedThreadId = threadId,
    private readonly ignoreTerm = false,
    private readonly turns: unknown[] = [],
    private readonly resumeStatus: unknown = undefined,
    private readonly resumeRequest: { id: string; method: string; params: Record<string, unknown> } | null = null,
    private readonly ignoredMethods: string[] = [],
  ) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    queueMicrotask(() => this.emit("close", signal === "SIGKILL" ? null : 0, signal));
    return true;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(id: string, method: string, params: Record<string, unknown>): void {
    this.serverRequestIds.add(id);
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  private accept(message: Record<string, unknown>): void {
    this.requests.push(message);
    if ((typeof message.id === "string" || typeof message.id === "number")
      && this.serverRequestIds.delete(message.id)) {
      if (this.autoResolveServerRequests) {
        this.notify("serverRequest/resolved", { threadId: this.threadId, requestId: message.id });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const method = message.method;
    if (typeof method === "string" && this.ignoredMethods.includes(method)) return;
    if (method === "initialize") return this.respond(message.id, { userAgent: "codex_desktop_app/0.144.1 (Linux)" });
    if (method === "account/read") return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    if (method === "config/read") return this.respond(message.id, {
      config: {
        mcp_servers: {
          playwright: { command: "npx", enabled: true },
          "telegram-readonly": { command: "uv", enabled: true },
        },
      },
    });
    if (method === "thread/start" || method === "thread/resume") {
      const id = method === "thread/resume" ? this.resumedThreadId : this.threadId;
      if (method === "thread/resume" && this.resumeRequest) {
        this.request(this.resumeRequest.id, this.resumeRequest.method, this.resumeRequest.params);
      }
      return this.respond(message.id, {
        thread: {
          id,
          path: `/sessions/${id}.jsonl`,
          turns: this.turns,
          ...(this.resumeStatus ? { status: this.resumeStatus } : {}),
        },
      });
    }
    if (method === "thread/read") {
      if (this.readError) return this.respondError(message.id, this.readError);
      return this.respond(message.id, {
        thread: {
          id: this.threadId,
          path: `/sessions/${this.threadId}.jsonl`,
          turns: this.readTurns ?? this.turns,
        },
      });
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      this.respond(message.id, { turn: { id: turnId } });
      this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
      this.completeUserMessage(message, turnId);
      return;
    }
    if (method === "turn/steer") {
      const turnId = (message.params as { expectedTurnId: string }).expectedTurnId;
      this.respond(message.id, { turnId });
      this.completeUserMessage(message, turnId);
      return;
    }
    if (method === "turn/interrupt") return this.respond(message.id, {});
  }

  private respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private respondError(id: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { message } })}\n`);
  }

  private completeUserMessage(message: Record<string, unknown>, turnId: string): void {
    if (!this.autoCompleteUserMessage) return;
    const params = message.params as { clientUserMessageId?: string; input?: unknown };
    if (!params.clientUserMessageId) return;
    this.notify("item/completed", {
      threadId: this.threadId,
      turnId,
      item: { type: "userMessage", clientId: params.clientUserMessageId, content: params.input },
    });
  }
}

function fakeSpawn(server: FakeAppServer, captured?: { args?: string[]; options?: SpawnOptionsWithoutStdio }) {
  return (_command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    if (captured) {
      captured.args = args;
      captured.options = options;
    }
    return server as unknown as ChildProcessWithoutNullStreams;
  };
}

async function nextEvent(iterable: AsyncIterable<unknown>): Promise<unknown> {
  return (await iterable[Symbol.asyncIterator]().next()).value;
}

describe("CodexAppServerHost", () => {
  test("fans out replay, fences steering, answers attention, and persists host columns", async () => {
    const server = new FakeAppServer();
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      codexHome: "/codex-home",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        OPENAI_API_KEY: "must-not-cross",
        LLV_TOKEN: "must-not-cross",
        ANTHROPIC_AUTH_TOKEN: "must-not-cross",
        AWS_SESSION_TOKEN: "must-not-cross",
        PRIVATE_SERVICE_API_KEY: "must-not-cross",
      },
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });
    expect(captured.options?.env).toEqual({ NODE_ENV: "test", PATH: process.env.PATH, CODEX_HOME: "/codex-home" });
    expect(host.identity).toEqual({ threadId: "thread-149", path: "/sessions/thread-149.jsonl" });

    const first = host.attach(0);
    const second = host.attach(0);
    expect(await nextEvent(first)).toEqual({ kind: "session-status", status: "idle", seq: 1 });
    expect(await nextEvent(second)).toEqual({ kind: "session-status", status: "idle", seq: 1 });

    const started = await host.send({ id: "delivery-one", text: "begin" });
    expect(started).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect(await host.send({ id: "stale", text: "wrong", expectedTurnId: "turn-old" })).toEqual({ outcome: "rejected", reason: "stale-turn" });
    expect(await host.send({ id: "delivery-two", text: "steer", expectedTurnId: "turn-1" })).toEqual({ outcome: "steered", turnId: "turn-1" });
    const steer = server.requests.find((request) => request.method === "turn/steer")!;
    expect(steer.params).toMatchObject({
      expectedTurnId: "turn-1",
      clientUserMessageId: "delivery-two",
      input: [{ type: "text", text: "<!-- llv:structured-user -->\nsteer" }],
    });

    server.request("approval-1", "item/commandExecution/requestApproval", { command: "touch allowed" });
    await Bun.sleep(0);
    const attention = (await host.health()).pendingAttention[0]!;
    expect(attention).toBe("item/commandExecution/requestApproval:approval-1");
    await host.answer(attention, { decision: "accept" });
    expect(server.requests.at(-1)).toMatchObject({ id: "approval-1", result: { decision: "accept" } });
    server.request("approval-2", "item/commandExecution/requestApproval", { command: "echo resolved" });
    await Bun.sleep(0);
    const resolvedStream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    server.notify("serverRequest/resolved", { threadId: "thread-149", requestId: "approval-2" });
    expect((await resolvedStream.next()).value).toMatchObject({
      kind: "attention-resolved",
      id: "item/commandExecution/requestApproval:approval-2",
      resolution: "server-resolved",
    });
    expect((await host.health()).pendingAttention).toEqual([]);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-registry-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: host.identity.threadId };
    registry.upsert({
      key,
      artifactPath: host.identity.path!,
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:pending",
        process: null,
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 7,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 7,
      claimOwner: "viewer",
      pendingAction: null,
    });
    await persistCodexHost(registry, key, host, "viewer", 7);
    expect(registry.snapshot().entries["codex:thread-149"]?.structuredHost).toMatchObject({
      kind: "codex-app-server",
      endpoint: "stdio:4242",
      eventCursor: 8,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 7,
      activeTurnRef: "turn-1",
      pendingAttention: [],
    });
    await host.release();
  });

  test("resumes the same engine thread after a host-process replacement", async () => {
    const eventStore = new MemoryEventStore();
    const firstServer = new FakeAppServer("durable-thread");
    const first = await CodexAppServerHost.start({ cwd: "/repo", effort: "xhigh", eventStore, spawnProcess: fakeSpawn(firstServer) });
    await first.send({ id: "before-restart", text: "remember" });
    expect(firstServer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ effort: "xhigh" });
    await first.release();
    const replacementServer = new FakeAppServer("durable-thread");
    const replacement = await CodexAppServerHost.adopt("durable-thread", {
      cwd: "/repo",
      effort: "xhigh",
      eventStore,
      initialEventCursor: 3,
      spawnProcess: fakeSpawn(replacementServer),
    });
    expect(replacement.identity.threadId).toBe("durable-thread");
    expect(replacementServer.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    const replay = replacement.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "turn-1", seq: 2 });
    expect((await replay.next()).value).toMatchObject({ kind: "item", phase: "completed", seq: 3 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "unhosted", seq: 4 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "idle", seq: 5 });
    await replacement.send({ id: "after-restart", text: "recall" });
    expect(replacementServer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ effort: "xhigh" });
    await replacement.release();
  });

  test("managed-home adoption pins file-backed Codex credentials", async () => {
    const server = new FakeAppServer("managed-thread");
    const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
    const host = await CodexAppServerHost.adopt("managed-thread", {
      cwd: "/repo",
      codexHome: "/managed-codex-home",
      fileAuthCredentials: true,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });
    expect(captured.args).toEqual(["-c", "cli_auth_credentials_store=file", "-c", "mcp_servers={}", "app-server"]);
    expect(captured.options?.env?.CODEX_HOME).toBe("/managed-codex-home");
    expect(captured.options?.detached).toBeTrue();
    expect(server.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    const resume = server.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      config: {
        mcp_servers: {
          playwright: { enabled: false },
          "telegram-readonly": { enabled: false },
        },
        features: { apps: false, plugins: false },
        include_apps_instructions: false,
      },
    });
    await host.release();
  });

  test("rejects a resume response for a different durable thread", async () => {
    const server = new FakeAppServer("server-default", "different-thread");
    await expect(CodexAppServerHost.adopt("requested-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    })).rejects.toThrow("thread/resume returned a different thread id");
    expect(server.signals).toContain("SIGTERM");
  });

  test("rebuilds replay from resume history when a legacy host has no event ledger", async () => {
    const server = new FakeAppServer("history-thread", "history-thread", false, [{
      id: "history-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "persisted" }],
    }]);
    const host = await CodexAppServerHost.adopt("history-thread", {
      cwd: "/repo",
      initialEventCursor: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(5)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "history-turn", seq: 6 });
    expect((await replay.next()).value).toEqual({
      kind: "item",
      turnId: "history-turn",
      item: { type: "agentMessage", text: "persisted" },
      phase: "completed",
      seq: 7,
    });
    expect((await replay.next()).value).toEqual({ kind: "turn-ended", turnId: "history-turn", status: "completed", seq: 8 });
    expect(() => host.attach(0)).toThrow("runtime replay begins at sequence 6");
    await host.release();
  });

  test("confirms a retried queue entry from its persisted client id", async () => {
    const server = new FakeAppServer("delivery-thread", "delivery-thread");
    server.readTurns = [{
      id: "persisted-turn",
      status: "completed",
      items: [{ type: "userMessage", clientId: "operation-recovered", content: [{ type: "text", text: "hello" }] }],
    }];
    const host = await CodexAppServerHost.adopt("delivery-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-recovered", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "persisted-turn",
    });
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    await host.release();
  });

  test("keeps a send pending until the matching user item is persisted", async () => {
    const server = new FakeAppServer("confirm-after-rpc");
    server.autoCompleteUserMessage = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    let settled = false;
    const delivery = host.send({ id: "operation-confirmed", text: "hello" })
      .finally(() => { settled = true; });
    await Bun.sleep(0);

    expect(server.requests.some((request) => request.method === "turn/start")).toBeTrue();
    expect(settled).toBeFalse();

    server.notify("item/completed", {
      threadId: "confirm-after-rpc",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        clientId: "operation-confirmed",
        content: [{ type: "text", text: "hello" }],
      },
    });

    expect(await delivery).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    await host.release();
  });

  test("rejects a persisted client id whose user-message text differs", async () => {
    const server = new FakeAppServer("delivery-collision-thread", "delivery-collision-thread");
    server.readTurns = [{
      id: "persisted-turn",
      status: "completed",
      items: [{ type: "userMessage", clientId: "operation-collision", content: [{ type: "text", text: "original" }] }],
    }];
    const host = await CodexAppServerHost.adopt("delivery-collision-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    await expect(host.send({ id: "operation-collision", text: "changed" }))
      .rejects.toThrow("Codex queue entry id belongs to a different payload");
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    await host.release();
  });

  test("starts the first delivery when Codex reports an unmaterialized thread", async () => {
    const server = new FakeAppServer("fresh-delivery-thread");
    server.readError = "thread fresh-delivery-thread is not materialized yet; includeTurns is unavailable before first user message";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-first", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    await host.release();
  });

  test("closes an unresolved ledger turn when resume reports idle", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("crashed-turn", { kind: "turn-started", turnId: "turn-active", seq: 1 });
    eventStore.append("crashed-turn", { kind: "session-status", status: "active", seq: 2 });
    const server = new FakeAppServer("crashed-turn", "crashed-turn", false, [], { type: "idle" });
    const host = await CodexAppServerHost.adopt("crashed-turn", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(2)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-ended", turnId: "turn-active", status: "error", seq: 3 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "idle", seq: 4 });
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    await host.release();
  });

  test("completes partially recorded ledger history from the resume response", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("completed-after-crash", { kind: "turn-started", turnId: "crashed-turn", seq: 1 });
    const persistedItem = { type: "agentMessage", id: "response-item", text: "persisted response" };
    const server = new FakeAppServer("completed-after-crash", "completed-after-crash", false, [{
      id: "crashed-turn",
      status: "completed",
      items: [persistedItem],
    }], { type: "idle" });
    const host = await CodexAppServerHost.adopt("completed-after-crash", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({
      kind: "item",
      turnId: "crashed-turn",
      item: persistedItem,
      phase: "completed",
      seq: 2,
    });
    expect((await replay.next()).value).toEqual({
      kind: "turn-ended",
      turnId: "crashed-turn",
      status: "completed",
      seq: 3,
    });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "idle", seq: 4 });
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    await host.release();
  });

  test("restores the resumed active turn after a dead ledger", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("active-after-crash", { kind: "turn-started", turnId: "stale-turn", seq: 1 });
    eventStore.append("active-after-crash", { kind: "session-status", status: "dead", seq: 2 });
    const server = new FakeAppServer("active-after-crash", "active-after-crash", false, [{
      id: "resumed-turn",
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] });
    const host = await CodexAppServerHost.adopt("active-after-crash", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(2)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "resumed-turn", seq: 3 });
    expect((await replay.next()).value).toEqual({
      kind: "session-status",
      status: "active",
      activeFlags: ["running"],
      seq: 4,
    });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "resumed-turn" });
    expect(await host.send({ id: "steer-resumed", text: "continue", expectedTurnId: "resumed-turn" }))
      .toEqual({ outcome: "steered", turnId: "resumed-turn" });
    await host.interrupt("resumed-turn");
    expect(server.requests.some((request) => request.method === "turn/start")).toBeFalse();
    expect(server.requests.find((request) => request.method === "turn/steer")?.params)
      .toMatchObject({ expectedTurnId: "resumed-turn" });
    expect(server.requests.find((request) => request.method === "turn/interrupt")?.params)
      .toMatchObject({ turnId: "resumed-turn" });
    await host.release();
  });

  test("resolves ledger attention during adoption and preserves resumed active flags", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("crashed-attention", {
      kind: "attention",
      id: "item/commandExecution/requestApproval:approval-crash",
      method: "item/commandExecution/requestApproval",
      attention: { command: "date" },
      seq: 1,
    });
    const server = new FakeAppServer("crashed-attention", "crashed-attention", false, [{
      id: "approval-turn",
      status: "inProgress",
      items: [],
    }], {
      type: "active",
      activeFlags: ["waitingForApproval"],
    });
    const host = await CodexAppServerHost.adopt("crashed-attention", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "approval-turn", seq: 2 });
    expect((await replay.next()).value).toEqual({
      kind: "attention-resolved",
      id: "item/commandExecution/requestApproval:approval-crash",
      resolution: "host-restarted",
      seq: 3,
    });
    expect((await replay.next()).value).toEqual({
      kind: "session-status",
      status: "active",
      activeFlags: ["waitingForApproval"],
      seq: 4,
    });
    expect(await host.health()).toMatchObject({
      status: "active",
      activeTurnRef: "approval-turn",
      pendingAttention: [],
      activeFlags: ["waitingForApproval"],
    });
    await host.release();
  });

  test("preserves a live approval delivered by the resumed process", async () => {
    const attentionId = "item/commandExecution/requestApproval:live-approval";
    const server = new FakeAppServer("live-attention", "live-attention", false, [{
      id: "live-turn",
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["waitingForApproval"] }, {
      id: "live-approval",
      method: "item/commandExecution/requestApproval",
      params: { command: "date" },
    });
    const host = await CodexAppServerHost.adopt("live-attention", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    expect(await host.health()).toMatchObject({
      status: "attention",
      activeTurnRef: "live-turn",
      pendingAttention: [attentionId],
    });
    await host.answer(attentionId, { decision: "accept" });
    expect(server.requests.at(-1)).toMatchObject({ id: "live-approval", result: { decision: "accept" } });
    await host.release();
  });

  test("parses generated-schema thread status notifications", async () => {
    const server = new FakeAppServer("status-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    const fixtures = fs.readFileSync(path.join(import.meta.dir, "fixtures/codex-thread-status-v0.144.1.jsonl"), "utf8")
      .trim().split("\n");
    for (const [index, fixture] of fixtures.entries()) {
      server.stdout.write(`${fixture}\n`);
      const event = (await stream.next()).value as RuntimeEvent;
      if (index === 0) expect(event).toMatchObject({ kind: "session-status", status: "active", activeFlags: ["waitingForApproval"] });
      if (index === 1) expect(event).toMatchObject({ kind: "session-status", status: "idle" });
      if (index === 2) expect(event).toMatchObject({ kind: "session-status", status: "unhosted" });
      if (index === 3) expect(event).toMatchObject({ kind: "session-status", status: "dead", activeFlags: ["recovering"] });
    }
    expect((await stream.next()).done).toBeTrue();
    await host.release();
  });

  test("release awaits TERM and escalates to KILL before resolving", async () => {
    const server = new FakeAppServer("reap-thread", "reap-thread", true);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    await host.release();
    expect(server.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect((await stream.next()).value).toMatchObject({ kind: "session-status", status: "unhosted" });
    expect((await stream.next()).done).toBeTrue();
  });

  test("release escalates the process group after its leader exits during grace", async () => {
    const server = new FakeAppServer("group-reap-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });

    await host.release();
    await Bun.sleep(10);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  test("release cleans the detached process group after an unexpected leader exit", async () => {
    const server = new FakeAppServer("exited-group-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") throw new Error("group exited");
      },
    });

    server.emit("close", 0, null);
    await host.release();
    await Bun.sleep(10);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(server.signals).toEqual([]);
  });

  test("protocol failure starts bounded TERM and KILL cleanup", async () => {
    const server = new FakeAppServer("failed-thread", "failed-thread", true);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    server.stdout.write("malformed\n");
    await Bun.sleep(10);
    expect(server.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect((await stream.next()).value).toMatchObject({ kind: "session-status", status: "dead" });
    expect((await stream.next()).done).toBeTrue();
    const terminal = await host.health();
    server.notify("turn/started", { threadId: "failed-thread", turn: { id: "late-turn" } });
    server.request("late-approval", "item/commandExecution/requestApproval", { command: "date" });
    server.notify("thread/status/changed", { threadId: "failed-thread", status: { type: "active", activeFlags: ["running"] } });
    expect(await host.health()).toMatchObject({
      status: "dead",
      eventCursor: terminal.eventCursor,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    });
    await host.release();
  });

  test("an asynchronous stdin EPIPE fails and reaps the host", async () => {
    const server = new FakeAppServer("epipe-thread", "epipe-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 1_000,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const pendingSend = host.send({ id: "epipe-send", text: "start" });
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    server.stdin.emit("error", error);
    await expect(pendingSend).rejects.toThrow("stdin failed: broken pipe");
    expect(await host.health()).toMatchObject({ status: "dead", activeTurnRef: null, pendingAttention: [] });
    expect(server.signals).toContain("SIGTERM");
    await host.release();
  });

  test("keeps an answer pending until the app-server confirms resolution", async () => {
    const server = new FakeAppServer("confirmed-answer-thread");
    server.autoResolveServerRequests = false;
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    server.request("confirmed-answer", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    const attentionId = "item/commandExecution/requestApproval:confirmed-answer";
    let settled = false;
    const answer = host.answer(attentionId, { decision: "accept" }).finally(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    expect((await host.health()).pendingAttention).toEqual([attentionId]);
    expect(store.load("confirmed-answer-thread").some((event) => event.kind === "attention-resolved")).toBeFalse();
    server.notify("serverRequest/resolved", { threadId: "confirmed-answer-thread", requestId: "confirmed-answer" });
    await answer;
    expect((await host.health()).pendingAttention).toEqual([]);
    expect(store.load("confirmed-answer-thread").at(-1)).toMatchObject({
      kind: "attention-resolved",
      id: attentionId,
      resolution: "answered",
    });
    await host.release();
  });

  test("a synchronous answer write failure preserves no false resolution", async () => {
    const server = new FakeAppServer("sync-answer-failure");
    server.autoResolveServerRequests = false;
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    server.request("sync-answer", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    server.stdin.write = (() => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    }) as typeof server.stdin.write;
    await expect(host.answer("item/commandExecution/requestApproval:sync-answer", { decision: "accept" }))
      .rejects.toThrow("stdin failed: broken pipe");
    expect(store.load("sync-answer-failure").some((event) => event.kind === "attention-resolved")).toBeFalse();
    expect(await host.health()).toMatchObject({ status: "dead", pendingAttention: [] });
    await host.release();
  });

  test("an asynchronous answer write failure preserves no false resolution", async () => {
    const server = new FakeAppServer("async-answer-failure");
    server.autoResolveServerRequests = false;
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    server.request("async-answer", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    const answer = host.answer("item/commandExecution/requestApproval:async-answer", { decision: "accept" });
    server.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await expect(answer).rejects.toThrow("stdin failed: broken pipe");
    expect(store.load("async-answer-failure").some((event) => event.kind === "attention-resolved")).toBeFalse();
    expect(await host.health()).toMatchObject({ status: "dead", pendingAttention: [] });
    await host.release();
  });

  test("a mutating RPC timeout poisons the writer before retry", async () => {
    const server = new FakeAppServer("timeout-thread", "timeout-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    await expect(host.send({ id: "ambiguous-send", text: "start" })).rejects.toThrow("outcome is uncertain");
    expect(await host.send({ id: "retry", text: "duplicate" })).toEqual({ outcome: "rejected", reason: "dead-host" });
    expect(server.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(server.signals).toContain("SIGTERM");
    const terminal = await host.health();
    server.notify("turn/started", { threadId: "timeout-thread", turn: { id: "late-timeout-turn" } });
    expect(await host.health()).toMatchObject({ status: "dead", eventCursor: terminal.eventCursor, activeTurnRef: null });
    await host.release();
  });

  test("an active turn gives thread/read enough time to answer", async () => {
    const ignoredMethods: string[] = [];
    const server = new FakeAppServer("slow-read-thread", "slow-read-thread", false, [], undefined, null, ignoredMethods);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 20,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    expect(await host.send({ id: "first", text: "begin" })).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    ignoredMethods.push("thread/read");

    const pending = host.send({ id: "slow-read-follow-up", text: "continue", expectedTurnId: "turn-1" })
      .then((value) => ({ value }), (error: Error) => ({ error }));
    await Bun.sleep(35);
    const read = server.requests.findLast((request) => request.method === "thread/read")!;
    server.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: read.id,
      result: { thread: { id: "slow-read-thread", path: "/sessions/slow-read-thread.jsonl", turns: [] } },
    })}\n`);
    const result = await pending;

    if ("error" in result) throw result.error;
    expect(result.value).toEqual({ outcome: "steered", turnId: "turn-1" });
    await host.release();
  });

  test("a late timed-out thread/read response stays harmless after retry delivery", async () => {
    const ignoredMethods = ["thread/read"];
    const server = new FakeAppServer("late-read-thread", "late-read-thread", false, [], undefined, null, ignoredMethods);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const entry = { id: "late-read-retry", text: "continue" };

    await expect(host.send(entry)).rejects.toThrow("thread/read timed out");
    const firstRead = server.requests.findLast((request) => request.method === "thread/read")!;
    ignoredMethods.splice(0);

    expect(await host.send(entry)).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    server.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: firstRead.id,
      result: { thread: { id: "late-read-thread", path: "/sessions/late-read-thread.jsonl", turns: [] } },
    })}\n`);
    await Bun.sleep(0);

    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
    expect(server.signals).not.toContain("SIGTERM");
    expect(server.requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer")).toHaveLength(1);
    await host.release();
  });

  test("ledger failures are contained, reject pending work, and close subscribers", async () => {
    const store = new FailingEventStore();
    const server = new FakeAppServer("ledger-thread", "ledger-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 1_000,
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    const pendingSend = host.send({ id: "pending-ledger-send", text: "start" });
    server.notify("account/rateLimits/updated", { rateLimits: {} });
    await expect(pendingSend).rejects.toThrow("runtime event ledger failed");
    expect(await host.health()).toMatchObject({ status: "dead", eventCursor: 1 });
    expect(store.appendAttempts).toBe(2);
    server.notify("account/rateLimits/updated", { rateLimits: { retry: true } });
    expect(store.appendAttempts).toBe(2);
    expect((await stream.next()).done).toBeTrue();
    expect(server.signals).toContain("SIGTERM");
    await host.release();
  });

  test("a shutdown ledger failure still releases the bound registry claim", async () => {
    const store = new FailingEventStore();
    const server = new FakeAppServer("release-ledger-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-ledger-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "release-ledger-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/release-ledger-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:4242",
        process: { pid: 4242, startIdentity: null },
        eventCursor: 1,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 4,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 4,
      claimOwner: "release-owner",
      pendingAction: null,
    });
    await bindCodexHostPersistence(registry, key, host, "release-owner", 4);
    await host.release();
    expect(store.appendAttempts).toBe(2);
    expect(registry.snapshot().entries["codex:release-ledger-thread"]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { process: null, endpoint: "stdio:released", activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    });
  });

  test("diagnostics redact credential labels, cookies, JWTs, and provider key prefixes", () => {
    const secrets = [
      "oauth-secret-value",
      "auth-secret-value",
      "session-secret-value",
      "client-secret-value",
      "cookie-secret-value",
      "generic-secret-value",
      "eyJabcdefghijk.abcdefghijk.abcdefghijk",
      "sk-ant-abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    ];
    const redacted = redactCodexHostDiagnostic([
      `oauth_token=${secrets[0]}`,
      `auth_token=${secrets[1]}`,
      `session_token=${secrets[2]}`,
      `client_secret=${secrets[3]}`,
      `cookie=${secrets[4]}`,
      `token=${secrets[5]}`,
      secrets[6],
      secrets[7],
      secrets[8],
    ].join(" "));
    for (const secret of secrets) expect(redacted).not.toContain(secret);
  });

  test("requires an exact opt-in value", async () => {
    expect(structuredHostsEnabled({ NODE_ENV: "test" })).toBeFalse();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "true" })).toBeFalse();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" })).toBeTrue();
    await expect(startCodexStructuredHost(
      { cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(new FakeAppServer()) },
      { NODE_ENV: "test" },
    )).rejects.toThrow("structured hosts are disabled");
  });

  test("boot adoption resumes every flagged Codex registry row", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-adoption-"));
    const registryPath = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(registryPath);
    const key = { engine: "codex" as const, sessionId: "adopted-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/adopted-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 12,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 3,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 3,
      claimOwner: null,
      pendingAction: null,
    });
    const disabled = await adoptCodexRegistryHosts(
      registry,
      () => ({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(new FakeAppServer("adopted-thread")) }),
      { NODE_ENV: "test" },
    );
    expect(disabled).toEqual([]);

    const server = new FakeAppServer("adopted-thread");
    const eventStore = new MemoryEventStore();
    const adopted = await adoptCodexRegistryHosts(
      registry,
      () => ({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(adopted).toHaveLength(1);
    expect(server.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost).toMatchObject({
      eventCursor: 13,
      writerClaimEpoch: 4,
      endpoint: "stdio:4242",
    });
    const receipt = await adopted[0]!.host.send({ id: "persist-turn", text: "start" });
    expect(receipt.outcome).toBe("turn-started");
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost).toMatchObject({
      eventCursor: 15,
      activeTurnRef: "turn-1",
    });
    server.request("persist-attention", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost?.pendingAttention).toEqual([
      "item/commandExecution/requestApproval:persist-attention",
    ]);
    await adopted[0]!.host.answer("item/commandExecution/requestApproval:persist-attention", { decision: "decline" });
    expect(registry.snapshot().entries["codex:adopted-thread"]?.structuredHost?.pendingAttention).toEqual([]);
    await adopted[0]!.host.release();
    expect(registry.snapshot().entries["codex:adopted-thread"]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { eventCursor: 18, process: null, activeTurnRef: null, pendingAttention: [] },
    });
    const restartedRegistry = new AgentRegistry(registryPath);
    const replacement = new FakeAppServer("adopted-thread");
    const releasedRows = await adoptCodexRegistryHosts(
      restartedRegistry,
      () => ({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(replacement) }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(releasedRows).toHaveLength(1);
    expect(replacement.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    expect(restartedRegistry.snapshot().entries["codex:adopted-thread"]).toMatchObject({
      status: "idle",
      host: null,
      claimEpoch: 5,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:4242",
        writerClaimEpoch: 5,
      },
    });
    await releasedRows[0]!.host.release();
  });

  test("failed restart adoption leaves a loud dead structured host", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-failed-adoption-"));
    const registryPath = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(registryPath);
    const key = { engine: "codex" as const, sessionId: "failed-adoption-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/failed-adoption-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "unhosted",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 9,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 2,
        activeTurnRef: "turn-old",
        pendingAttention: ["approval-old"],
        activeFlags: ["waitingForApproval"],
      },
      claimEpoch: 2,
      claimOwner: null,
      pendingAction: null,
    });
    const restartedRegistry = new AgentRegistry(registryPath);
    let adoptionAttempted = false;
    const adopted = await adoptCodexRegistryHosts(
      restartedRegistry,
      () => {
        adoptionAttempted = true;
        return {
          cwd: "/repo",
          eventStore: new MemoryEventStore(),
          spawnProcess: fakeSpawn(new FakeAppServer("failed-adoption-thread", "different-thread")),
        };
      },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(adopted).toEqual([]);
    expect(adoptionAttempted).toBeTrue();
    expect(restartedRegistry.snapshot().entries["codex:failed-adoption-thread"]).toMatchObject({
      status: "dead",
      host: null,
      claimOwner: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:released",
        process: null,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
    });
  });

  test("concurrent startup adoption creates one writer and advances its claim epoch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-claim-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "claimed-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/claimed-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 2,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 8,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 8,
      claimOwner: null,
      pendingAction: null,
    });
    const servers: FakeAppServer[] = [];
    const adopt = () => adoptCodexRegistryHosts(
      registry,
      () => {
        const server = new FakeAppServer("claimed-thread");
        servers.push(server);
        return { cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) };
      },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    const [first, second] = await Promise.all([adopt(), adopt()]);
    expect(first.length + second.length).toBe(1);
    expect(servers).toHaveLength(1);
    expect(registry.snapshot().entries["codex:claimed-thread"]).toMatchObject({
      claimEpoch: 9,
      structuredHost: { writerClaimEpoch: 9 },
    });
    await [...first, ...second][0]!.host.release();
  });

  test("late state from an old host cannot cross an advanced writer epoch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-fence-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "fenced-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/fenced-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 0,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "old-owner",
      pendingAction: null,
    });
    const server = new FakeAppServer("fenced-thread");
    const host = await CodexAppServerHost.adopt("fenced-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    await bindCodexHostPersistence(registry, key, host, "old-owner", 1);
    const started = await host.send({ id: "before-fence", text: "start" });
    expect(started).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    server.request("stale-approval", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    const current = registry.snapshot().entries["codex:fenced-thread"]!;
    registry.upsert({
      ...current,
      structuredHost: {
        ...current.structuredHost!,
        endpoint: "stdio:new",
        eventCursor: 99,
        writerClaimEpoch: 2,
      },
      claimEpoch: 2,
      claimOwner: "new-owner",
    });
    const requestCount = server.requests.length;
    expect(await host.send({ id: "stale-send", text: "blocked", expectedTurnId: "turn-1" }))
      .toEqual({ outcome: "rejected", reason: "dead-host" });
    await expect(host.interrupt("turn-1")).rejects.toThrow("unavailable");
    await expect(host.answer("item/commandExecution/requestApproval:stale-approval", { decision: "accept" }))
      .rejects.toThrow("unavailable");
    expect(server.requests).toHaveLength(requestCount);
    server.notify("thread/status/changed", { threadId: "fenced-thread", status: { type: "active", activeFlags: ["running"] } });
    await Bun.sleep(0);
    expect(registry.snapshot().entries["codex:fenced-thread"]).toMatchObject({
      claimEpoch: 2,
      claimOwner: "new-owner",
      structuredHost: { endpoint: "stdio:new", eventCursor: 99, writerClaimEpoch: 2 },
    });
    await host.release();
  });

  test("structured status transitions advance migration readiness revisions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-revision-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const artifactPath = "/sessions/revision-thread.jsonl";
    registry.reconcileConversations([{
      engine: "codex",
      path: artifactPath,
      accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T20:00:00.000Z",
    }]);
    const key = { engine: "codex" as const, sessionId: "revision-thread" };
    registry.upsert({
      key,
      artifactPath,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    const before = registry.snapshot();
    registry.setStructuredHost(key, {
      kind: "codex-app-server",
      endpoint: "stdio:42",
      process: { pid: 42, startIdentity: "42:start" },
      eventCursor: 1,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "idle");
    const after = registry.snapshot();
    expect(after.conversationRevision.codex).toBe(before.conversationRevision.codex + 1);
    expect(after.engineRouting.codex.revision).toBe(before.engineRouting.codex.revision + 1);
  });

  test("legacy host upserts preserve coexisting structured columns", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-coexistence-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "coexisting-thread" };
    const structuredHost = {
      kind: "codex-app-server" as const,
      endpoint: "stdio:42",
      process: { pid: 42, startIdentity: "42:start" },
      eventCursor: 8,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 3,
      activeTurnRef: "turn-live",
      pendingAttention: ["approval-live"],
      activeFlags: ["running"],
    };
    registry.upsert({
      key,
      artifactPath: "/sessions/coexisting-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: null,
      structuredHost,
      claimEpoch: 3,
      claimOwner: "structured-owner",
      pendingAction: null,
    });
    registry.upsert({
      key,
      artifactPath: "/sessions/coexisting-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: {
        kind: "tmux",
        endpoint: "/tmp/tmux.sock",
        server: { pid: 10, startIdentity: "10:start" },
        paneId: "%1",
        panePid: { pid: 11, startIdentity: "11:start" },
        windowName: "codex",
        agent: { pid: 12, startIdentity: "12:start" },
        argv: ["codex"],
      },
      claimEpoch: 3,
      claimOwner: "structured-owner",
      pendingAction: null,
    });
    expect(registry.snapshot().entries["codex:coexisting-thread"]?.structuredHost).toEqual(structuredHost);
    expect(registry.ownsStructuredHostClaim(key, "structured-owner", 3)).toBeTrue();
    registry.markUnhosted(key);
    expect(registry.snapshot().entries["codex:coexisting-thread"]).toMatchObject({
      status: "live",
      host: null,
      structuredHost,
    });
  });
});
