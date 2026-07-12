import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import { CodexAppServerHost } from "./codexAppServerHost";
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

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly signals: NodeJS.Signals[] = [];
  private turn = 0;

  constructor(
    private readonly threadId = "thread-149",
    private readonly resumedThreadId = threadId,
    private readonly ignoreTerm = false,
    private readonly turns: unknown[] = [],
    private readonly resumeStatus: unknown = undefined,
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
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  private accept(message: Record<string, unknown>): void {
    this.requests.push(message);
    if (typeof message.id !== "number") return;
    const method = message.method;
    if (method === "initialize") return this.respond(message.id, { userAgent: "codex_desktop_app/0.144.1 (Linux)" });
    if (method === "account/read") return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    if (method === "thread/start" || method === "thread/resume") {
      const id = method === "thread/resume" ? this.resumedThreadId : this.threadId;
      return this.respond(message.id, {
        thread: {
          id,
          path: `/sessions/${id}.jsonl`,
          turns: this.turns,
          ...(this.resumeStatus ? { status: this.resumeStatus } : {}),
        },
      });
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      this.respond(message.id, { turn: { id: turnId } });
      this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
      return;
    }
    if (method === "turn/steer") return this.respond(message.id, { turnId: (message.params as { expectedTurnId: string }).expectedTurnId });
    if (method === "turn/interrupt") return this.respond(message.id, {});
  }

  private respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}

function fakeSpawn(server: FakeAppServer, captured?: { options?: SpawnOptionsWithoutStdio }) {
  return (_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    if (captured) captured.options = options;
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
    expect(steer.params).toMatchObject({ expectedTurnId: "turn-1", clientUserMessageId: "delivery-two" });

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
      eventCursor: 6,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 7,
      activeTurnRef: "turn-1",
      pendingAttention: [],
    });
    await host.release();
  });

  test("resumes the same engine thread after a host-process replacement", async () => {
    const eventStore = new MemoryEventStore();
    const first = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(new FakeAppServer("durable-thread")) });
    await first.send({ id: "before-restart", text: "remember" });
    await first.release();
    const replacementServer = new FakeAppServer("durable-thread");
    const replacement = await CodexAppServerHost.adopt("durable-thread", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 3,
      spawnProcess: fakeSpawn(replacementServer),
    });
    expect(replacement.identity.threadId).toBe("durable-thread");
    expect(replacementServer.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    const replay = replacement.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "turn-1", seq: 2 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "unhosted", seq: 3 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "idle", seq: 4 });
    await replacement.release();
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

  test("resolves ledger attention during adoption and preserves resumed active flags", async () => {
    const eventStore = new MemoryEventStore();
    eventStore.append("crashed-attention", {
      kind: "attention",
      id: "item/commandExecution/requestApproval:approval-crash",
      method: "item/commandExecution/requestApproval",
      attention: { command: "date" },
      seq: 1,
    });
    const server = new FakeAppServer("crashed-attention", "crashed-attention", false, [], {
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
    expect((await replay.next()).value).toEqual({
      kind: "attention-resolved",
      id: "item/commandExecution/requestApproval:approval-crash",
      resolution: "host-restarted",
      seq: 2,
    });
    expect((await replay.next()).value).toEqual({
      kind: "session-status",
      status: "active",
      activeFlags: ["waitingForApproval"],
      seq: 3,
    });
    expect(await host.health()).toMatchObject({
      status: "active",
      pendingAttention: [],
      activeFlags: ["waitingForApproval"],
    });
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
    await host.release();
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
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
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
      eventCursor: 14,
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
      structuredHost: { eventCursor: 17, process: null, activeTurnRef: null, pendingAttention: [] },
    });
    const reclaimed = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: "replacement-viewer" });
    expect(reclaimed?.claimEpoch).toBe(5);
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
});
