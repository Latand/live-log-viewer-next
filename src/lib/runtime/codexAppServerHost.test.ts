import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, spyOn, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { STRUCTURED_HOST_STAMP_ENV, structuredHostStamp } from "@/lib/scanner/process";
import { saveTelegramSession, TELEGRAM_CONNECTOR_TOKEN_ENV } from "@/lib/telegram/sessionStore";

import { CodexAppServerHost, MAX_APP_SERVER_LINE_BYTES, redactCodexHostDiagnostic } from "./codexAppServerHost";
import { encodeCodexStructuredUserText } from "./codexStructuredUserText";
import { FileRuntimeEventStore, type RuntimeEventStore } from "./eventStore";
import type { HostState, RuntimeEvent } from "./engineHost";
import { appendRuntimeLiveTurnDelta, runtimeLiveTurnItems, type RuntimeLiveTurn } from "./liveTurn";
import { adoptCodexRegistryHosts, bindCodexHostPersistence, persistCodexHost, startCodexStructuredHost, structuredHostsEnabled } from "./registry";
import { STRUCTURED_IMAGE_CAPABILITY, structuredContent, type StructuredImageRef } from "./structuredContent";
import { materializeStructuredHostAccess, READ_ONLY_STAGE_PERMISSION_PROFILE } from "./structuredSpawn";
import type { RuntimeVoiceDelivery } from "./voiceDelivery";
import { DEFAULT_VOICE_PERSONA, VOICE_PERSONA_FILE, legacyVoicePersonaBootstrapItemId, voicePersona } from "./voicePersona";

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

test("read-only structured hosts receive one writable isolated scratch root", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-read-only-scratch-test-"));
  const stateDirectory = path.join(directory, "state");
  const previousStateDirectory = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = stateDirectory;
  try {
    const access = materializeStructuredHostAccess(
      true,
      {
        NODE_ENV: "test",
        HOME: "/shared/home",
        XDG_CONFIG_HOME: "/shared/config",
        XDG_CACHE_HOME: "/shared/cache",
        TMPDIR: "/container-private/tmp",
      },
      "capability",
    );

    expect(access.env).toMatchObject({
      NODE_ENV: "test",
      LLV_SPAWN_CAPABILITY: "capability",
      HOME: "/shared/home",
      XDG_CONFIG_HOME: "/shared/config",
      XDG_CACHE_HOME: "/shared/cache",
      TMPDIR: path.join(access.scratchDirectory!, "tmp"),
      GH_CONFIG_DIR: "/shared/config/gh",
    });
    expect(path.dirname(access.scratchDirectory!)).toBe(path.join(stateDirectory, "scratch"));
    expect(access.scratchDirectory!.startsWith(`${stateDirectory}${path.sep}`)).toBeTrue();
    expect(access.codex).toEqual({
      permissionProfile: READ_ONLY_STAGE_PERMISSION_PROFILE,
      permissionProfileConfig: `permissions.${READ_ONLY_STAGE_PERMISSION_PROFILE}={extends=":read-only",filesystem={${JSON.stringify(access.scratchDirectory)}="write"}}`,
    });
    expect(access.host).toEqual({
      forwardGitHubConfig: true,
      releaseCleanup: expect.any(Function),
    });
    expect(fs.statSync(access.scratchDirectory!).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(access.scratchDirectory!, "tmp")).mode & 0o777).toBe(0o700);

    access.cleanup();
    expect(fs.existsSync(access.scratchDirectory!)).toBeFalse();

    const sourceEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", HOME: "/shared/home", TMPDIR: "/original/tmp" };
    const readWrite = materializeStructuredHostAccess(false, sourceEnv, "capability", directory);
    expect(readWrite).toMatchObject({
      env: { ...sourceEnv, LLV_SPAWN_CAPABILITY: "capability" },
      codex: { sandbox: "danger-full-access" },
      scratchDirectory: null,
    });
  } finally {
    if (previousStateDirectory === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
  mcpServers: Record<string, unknown> = {
    playwright: { command: "npx", enabled: true },
    "telegram-readonly": { command: "uv", enabled: true },
  };
  modelList: unknown[] = [{ id: "gpt-5.3-codex-spark", isDefault: true, inputModalities: ["text"] }];
  modelListFailuresRemaining = 0;
  realtimeStartError: string | null = null;
  realtimeStartDelayMs: number | null = null;
  suppressRealtimeStartNotifications = false;
  realtimeAppendErrorAt: number | null = null;
  responseChunkBytes: number | null = null;
  oversizedTurnStartResult = false;
  oversizedTurnStartErrorResult = false;
  oversizedTurnSteerResult = false;
  oversizedTurnInterruptResult = false;
  resumeReplayTurns: unknown[] | null = null;
  resumeItemsBackwardsCursor = "resume-items-anchor";
  rejectFullTurnPages = false;
  invalidCursorErrorsRemaining = 0;
  malformedTurnPage = false;
  malformedItemPage = false;
  malformedItemEntry = false;
  itemListError: string | null = null;
  /** Overrides the turn source served by `thread/turns/list` after construction,
      modeling history persisted underneath a live host. */
  turnsListSource: unknown[] | null = null;
  readonly acceptedRealtimeSpeech: string[] = [];
  injectItemsError: string | null = null;
  injectItemsDelayMs: number | null = null;
  holdInjectItems = false;
  readonly heldInjectItemIds: number[] = [];
  omitThreadPath = false;
  omitThreadReadPath = false;
  threadPath: string | null = null;
  private readonly serverRequestIds = new Set<string | number>();
  private turn = 0;

  constructor(
    private readonly threadId = "thread-149",
    private readonly resumedThreadId = threadId,
    private readonly ignoreTerm = false,
    private readonly turns: unknown[] = [],
    private readonly resumeStatus: unknown = undefined,
    private readonly resumeRequest: { id?: string; method: string; params: Record<string, unknown> }
      | Array<{ id?: string; method: string; params: Record<string, unknown> }>
      | null = null,
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
    if (method === "model/list") {
      if (this.modelListFailuresRemaining > 0) {
        this.modelListFailuresRemaining -= 1;
        return this.respondError(message.id, "model list probe timed out");
      }
      return this.respond(message.id, { data: this.modelList });
    }
    if (method === "config/read") return this.respond(message.id, {
      config: {
        mcp_servers: this.mcpServers,
      },
    });
    if (method === "thread/start" || method === "thread/resume") {
      const id = method === "thread/resume" ? this.resumedThreadId : this.threadId;
      if (method === "thread/resume" && this.resumeRequest) {
        for (const request of Array.isArray(this.resumeRequest) ? this.resumeRequest : [this.resumeRequest]) {
          if (request.id) this.request(request.id, request.method, request.params);
          else this.notify(request.method, request.params);
        }
      }
      const requestedExcludeTurns = method === "thread/resume"
        && (message.params as { excludeTurns?: boolean } | undefined)?.excludeTurns === true;
      const excludeTurns = requestedExcludeTurns && this.resumeReplayTurns === null;
      return this.respond(message.id, {
        thread: {
          id,
          ...(!this.omitThreadPath ? { path: this.threadPath ?? `/sessions/${id}.jsonl` } : {}),
          turns: excludeTurns ? [] : (this.resumeReplayTurns ?? this.turns),
          ...(this.resumeStatus ? { status: this.resumeStatus } : {}),
        },
        ...(requestedExcludeTurns ? {
          turnsBackwardsCursor: this.turns.length > 0 ? "0" : null,
          itemsBackwardsCursor: this.turns.some((turn) =>
            turn !== null
            && typeof turn === "object"
            && !Array.isArray(turn)
            && Array.isArray((turn as { items?: unknown }).items)
            && (turn as { items: unknown[] }).items.length > 0)
            ? this.resumeItemsBackwardsCursor
            : null,
        } : {}),
      });
    }
    if (method === "thread/turns/list") {
      if (this.malformedTurnPage) return this.respond(message.id, { nextCursor: null });
      const params = (message.params ?? {}) as {
        cursor?: string | null;
        itemsView?: string | null;
        limit?: number | null;
        sortDirection?: string | null;
      };
      if (params.cursor != null && this.invalidCursorErrorsRemaining > 0) {
        this.invalidCursorErrorsRemaining -= 1;
        return this.respondError(message.id, "invalid cursor: the thread history changed underneath this page");
      }
      if (this.rejectFullTurnPages && params.itemsView === "full") {
        return this.respondError(message.id, "full turn page exceeded the bounded replay budget");
      }
      const source = this.turnsListSource ?? this.readTurns ?? this.turns;
      const ordered = params.sortDirection === "desc" ? [...source].reverse() : [...source];
      const start = params.cursor != null ? Number(params.cursor) : 0;
      const limit = params.limit ?? 100;
      const data = ordered.slice(start, start + limit).map((value) => {
        if (params.itemsView !== "notLoaded" || !value || typeof value !== "object" || Array.isArray(value)) {
          return value;
        }
        const turn = { ...(value as Record<string, unknown>) };
        delete turn.items;
        return { ...turn, items: [], itemsView: "notLoaded" };
      });
      const nextCursor = start + limit < ordered.length ? String(start + limit) : null;
      const backwardsCursor = data.length > 0 ? String(start) : null;
      return this.respond(message.id, { data, nextCursor, backwardsCursor });
    }
    if (method === "thread/items/list") {
      if (this.itemListError) return this.respondError(message.id, this.itemListError);
      if (this.malformedItemPage) return this.respond(message.id, { nextCursor: null });
      if (this.malformedItemEntry) return this.respond(message.id, { data: [{ turnId: this.threadId }], nextCursor: null });
      const params = (message.params ?? {}) as {
        cursor?: string | null;
        limit?: number | null;
        sortDirection?: string | null;
        turnId?: string | null;
      };
      const source = this.turnsListSource ?? this.readTurns ?? this.turns;
      const entries = source.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const turn = value as { id?: unknown; items?: unknown };
        if (typeof turn.id !== "string" || !Array.isArray(turn.items)) return [];
        if (params.turnId != null && params.turnId !== turn.id) return [];
        return turn.items.map((item) => ({ turnId: turn.id as string, item }));
      });
      const ordered = params.sortDirection === "desc" ? entries.reverse() : entries;
      const start = params.cursor === this.resumeItemsBackwardsCursor
        ? 0
        : params.cursor != null ? Number(params.cursor) : 0;
      const limit = params.limit ?? 100;
      const data = ordered.slice(start, start + limit);
      const nextCursor = start + limit < ordered.length ? String(start + limit) : null;
      const backwardsCursor = data.length > 0 ? String(start) : null;
      return this.respond(message.id, { data, nextCursor, backwardsCursor });
    }
    if (method === "thread/read") {
      const includeTurns = (message.params as { includeTurns?: boolean } | undefined)?.includeTurns === true;
      return this.respond(message.id, {
        thread: {
          id: this.threadId,
          ...(!this.omitThreadReadPath ? { path: this.threadPath ?? `/sessions/${this.threadId}.jsonl` } : {}),
          turns: includeTurns ? (this.readTurns ?? this.turns) : [],
          ...(this.resumeStatus ? { status: this.resumeStatus } : {}),
        },
      });
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      if (this.oversizedTurnStartErrorResult) {
        return this.respondError(message.id, `turn refused ${"p".repeat(26 * 1024 * 1024)}`);
      }
      if (this.oversizedTurnStartResult) {
        this.persistUserMessage(message, turnId);
        this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
        this.respond(message.id, { turn: { id: turnId }, padding: "p".repeat(26 * 1024 * 1024) });
        this.completeUserMessage(message, turnId);
        return;
      }
      this.respond(message.id, { turn: { id: turnId } });
      this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
      this.completeUserMessage(message, turnId);
      return;
    }
    if (method === "turn/steer") {
      const turnId = (message.params as { expectedTurnId: string }).expectedTurnId;
      if (this.oversizedTurnSteerResult) {
        this.persistUserMessage(message, turnId);
        this.respond(message.id, { turnId, padding: "p".repeat(26 * 1024 * 1024) });
        this.completeUserMessage(message, turnId);
        return;
      }
      this.respond(message.id, { turnId });
      this.completeUserMessage(message, turnId);
      return;
    }
    if (method === "turn/interrupt") {
      if (this.oversizedTurnInterruptResult) {
        return this.respond(message.id, { padding: "p".repeat(26 * 1024 * 1024) });
      }
      return this.respond(message.id, {});
    }
    if (method === "thread/inject_items") {
      if (this.injectItemsError) return this.respondError(message.id, this.injectItemsError);
      if (this.holdInjectItems) {
        this.heldInjectItemIds.push(message.id);
        return;
      }
      if (this.injectItemsDelayMs !== null) {
        const requestId = message.id;
        setTimeout(() => {
          this.persistInjectedItems(message);
          this.respond(requestId, {});
        }, this.injectItemsDelayMs);
        return;
      }
      this.persistInjectedItems(message);
      return this.respond(message.id, {});
    }
    if (method === "thread/realtime/start") {
      if (this.realtimeStartDelayMs !== null) {
        const requestId = message.id;
        setTimeout(() => this.completeRealtimeStart(requestId), this.realtimeStartDelayMs);
        return;
      }
      this.completeRealtimeStart(message.id);
      return;
    }
    if (method === "thread/realtime/appendSpeech") {
      const attempt = this.requests.filter((request) =>
        request.method === "thread/realtime/appendSpeech").length;
      if (attempt === this.realtimeAppendErrorAt) {
        return this.respondError(message.id, "realtime channel replaced");
      }
      this.acceptedRealtimeSpeech.push((message.params as { text: string }).text);
      return this.respond(message.id, {});
    }
    if (method === "thread/realtime/stop") {
      return this.respond(message.id, {});
    }
  }

  completeNextInject(error: string | null = null): void {
    const id = this.heldInjectItemIds.shift();
    if (id === undefined) throw new Error("no held persona insertion");
    if (error) this.respondError(id, error);
    else this.respond(id, {});
  }

  private persistInjectedItems(message: Record<string, unknown>): void {
    if (!this.threadPath) return;
    const items = (message.params as { items?: unknown[] }).items ?? [];
    fs.appendFileSync(this.threadPath, items.map((payload) => JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-02T10:00:00.000Z",
      payload,
    })).join("\n") + "\n");
  }

  private completeRealtimeStart(requestId: number): void {
    this.respond(requestId, {});
    if (this.suppressRealtimeStartNotifications) return;
    if (this.realtimeStartError) {
      this.notify("thread/realtime/error", {
        threadId: this.threadId,
        message: this.realtimeStartError,
      });
      return;
    }
    this.notify("thread/realtime/started", {
      threadId: this.threadId,
      realtimeSessionId: "realtime-1",
      version: "v3",
    });
    this.notify("thread/realtime/sdp", {
      threadId: this.threadId,
      sdp: "v=0\r\nanswer",
    });
  }

  private respond(id: number, result: unknown): void {
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
    if (this.responseChunkBytes) {
      for (let offset = 0; offset < line.length; offset += this.responseChunkBytes) {
        this.stdout.write(line.slice(offset, offset + this.responseChunkBytes));
      }
      return;
    }
    this.stdout.write(line);
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

  private persistUserMessage(message: Record<string, unknown>, turnId: string): void {
    const params = message.params as { clientUserMessageId?: string; input?: unknown };
    if (!params.clientUserMessageId) return;
    const source = [...(this.turnsListSource ?? this.turns)];
    const item = { type: "userMessage", clientId: params.clientUserMessageId, content: params.input };
    const index = source.findIndex((value) => value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as { id?: unknown }).id === turnId);
    if (index >= 0) {
      const turn = source[index] as Record<string, unknown>;
      source[index] = { ...turn, items: [...(Array.isArray(turn.items) ? turn.items : []), item] };
    } else {
      source.push({ id: turnId, status: "inProgress", items: [item] });
    }
    this.turnsListSource = source;
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

const ownedFakeProcess = {
  pidAlive: () => true,
  processIdentity: () => "4242:owned",
};

/** Owned-process stubs whose termination signals stay inside the fake instead
    of reaching a real pid 4242 process group through `process.kill`. */
function stubbedTermination(server: FakeAppServer) {
  return {
    ...ownedFakeProcess,
    shutdownGraceMs: 2,
    signalProcess: (_pid: number, signal: NodeJS.Signals) => {
      queueMicrotask(() => server.emit("close", 0, signal));
    },
  };
}

async function nextEvent(iterable: AsyncIterable<unknown>): Promise<unknown> {
  return (await iterable[Symbol.asyncIterator]().next()).value;
}

describe("CodexAppServerHost", () => {
  test("structured Codex loads Telegram auth only for the granted root host", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-telegram-grant-"));
    const previousState = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = path.join(directory, "state");
    try {
      const stored = saveTelegramSession("1ApWapzMBu4placeholder-not-a-real-session");
      const rootServer = new FakeAppServer("telegram-root");
      rootServer.mcpServers = {
        viewer: { command: "viewer-mcp", enabled: true },
        telegram: { url: "http://127.0.0.1:8809/mcp", enabled: true },
      };
      const rootCapture: { options?: SpawnOptionsWithoutStdio } = {};
      const root = await CodexAppServerHost.start({
        cwd: "/repo",
        mcpServers: ["viewer", "telegram"],
        env: { NODE_ENV: "test", [TELEGRAM_CONNECTOR_TOKEN_ENV]: "B".repeat(43) },
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(rootServer, rootCapture),
      });
      expect(rootCapture.options?.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBe(stored.connectorToken);
      await root.release();

      const delegatedServer = new FakeAppServer("telegram-delegated");
      const delegatedCapture: { options?: SpawnOptionsWithoutStdio } = {};
      const delegated = await CodexAppServerHost.start({
        cwd: "/repo",
        mcpServers: ["viewer"],
        env: { NODE_ENV: "test", [TELEGRAM_CONNECTOR_TOKEN_ENV]: stored.connectorToken },
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(delegatedServer, delegatedCapture),
      });
      expect(delegatedCapture.options?.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBeUndefined();
      await delegated.release();
    } finally {
      if (previousState === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previousState;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fresh structured threads discover account MCP configuration and allow only Viewer", async () => {
    const server = new FakeAppServer("viewer-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      playwright: { command: "npx", enabled: true, default_tools_approval_mode: "writes" },
    };
    const captured: { args?: string[] } = {};
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });

    expect(captured.args).toEqual(["app-server", "--enable", "realtime_conversation"]);
    expect(server.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
          playwright: { enabled: false, default_tools_approval_mode: "writes" },
        },
      },
    });
    await host.release();
  });

  test("applies the isolated read-only-stage permission profile to fresh and adopted threads", async () => {
    const permissionProfile = "llv-read-only-stage";
    const permissionProfileConfig = 'permissions.llv-read-only-stage={extends=":read-only",filesystem={"/scratch"="write"}}';
    for (const threadId of [null, "scratch-thread"] as const) {
      const server = new FakeAppServer(threadId ?? "scratch-thread");
      const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
      const options = {
        cwd: "/repo",
        permissionProfile,
        permissionProfileConfig,
        forwardGitHubConfig: true,
        env: { NODE_ENV: "test" as const, GH_CONFIG_DIR: "/shared/config/gh" },
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server, captured),
      };
      const host = threadId
        ? await CodexAppServerHost.adopt(threadId, options)
        : await CodexAppServerHost.start(options);

      expect(captured.args).toEqual([
        "-c", `default_permissions=${JSON.stringify(permissionProfile)}`,
        "-c", permissionProfileConfig,
        "app-server", "--enable", "realtime_conversation",
      ]);
      expect(captured.options?.env?.GH_CONFIG_DIR).toBe("/shared/config/gh");
      const method = threadId ? "thread/resume" : "thread/start";
      const params = server.requests.find((request) => request.method === method)?.params as Record<string, unknown>;
      expect(params).toMatchObject({ permissions: permissionProfile });
      expect(params).not.toHaveProperty("sandbox");
      await host.release();
    }

    const readWriteServer = new FakeAppServer("read-write-thread");
    const readWriteCapture: { options?: SpawnOptionsWithoutStdio } = {};
    const readWriteHost = await CodexAppServerHost.start({
      cwd: "/repo",
      sandbox: "danger-full-access",
      env: { NODE_ENV: "test", GH_CONFIG_DIR: "/shared/config/gh" },
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(readWriteServer, readWriteCapture),
    });
    expect(readWriteCapture.options?.env?.GH_CONFIG_DIR).toBeUndefined();
    await readWriteHost.release();
  });

  test("starts a client-managed V3 WebRTC call on the hosted thread", async () => {
    const server = new FakeAppServer("voice-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    const started = await host.startRealtimeWebRtc("v=0\r\noffer");
    expect(started).toMatchObject({
      sdp: "v=0\r\nanswer",
      realtimeSessionId: "realtime-1",
      personaBootstrap: { insertion: "accepted" },
    });
    expect(started.personaBootstrap.receiptId).toMatch(/^voice_persona_[a-f0-9]{46}$/);
    expect(started.personaBootstrap.itemId).toMatch(/^msg_voice_persona_[a-f0-9]{46}$/);
    // SDP requires a terminal CRLF; a missing one is healed, never trimmed —
    // OpenAI rejects an unterminated offer with "unmarshal SDP: EOF".
    /* The live model is named explicitly (#664): letting the backend choose
       gave `gpt-live-1-boulder-alpha`, whose calls were cut at ~9s even on an
       account at 5% of its window. */
    expect(server.requests.find((request) => request.method === "thread/realtime/start")?.params).toEqual({
      threadId: "voice-thread",
      version: "v3",
      model: "gpt-live-1-codex",
      outputModality: "audio",
      transport: { type: "webrtc", sdp: "v=0\r\noffer\r\n" },
      clientManagedHandoffs: true,
      codexResponsesAsItems: true,
      includeStartupContext: true,
    });

    /* The thread owns the persona while a current V3 call may also receive a
       bounded unresolved conversation tail through its creation payload. */
    const injected = server.requests.find((request) => request.method === "thread/inject_items");
    expect((injected?.params as { threadId?: string })?.threadId).toBe("voice-thread");
    /* Shape and ordering only. Which text arrives is pinned by the override
       test below, where the expected string cannot also be the default. */
    expect((injected?.params as { items?: unknown[] })?.items).toEqual([{
      type: "message",
      id: started.personaBootstrap.itemId,
      role: "developer",
      content: [{ type: "input_text", text: voicePersona() }],
    }]);
    expect(server.requests.findIndex((request) => request.method === "thread/inject_items"))
      .toBeLessThan(server.requests.findIndex((request) => request.method === "thread/realtime/start"));

    await host.appendRealtimeSpeech("Worker inspected package.json");
    expect(server.requests.find((request) => request.method === "thread/realtime/appendSpeech")?.params).toEqual({
      threadId: "voice-thread",
      text: "Worker inspected package.json",
    });
    await host.stopRealtime();
    expect(server.requests.find((request) => request.method === "thread/realtime/stop")?.params).toEqual({
      threadId: "voice-thread",
    });
    await host.release();
  });

  test("reuses one canonical persona row and stable receipt after duplicate start and host restart", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-bootstrap-"));
    const transcriptPath = path.join(isolated, "voice-thread.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const configDirectory = path.join(isolated, "config");
    const overridePath = path.join(configDirectory, "agent-log-viewer", ...VOICE_PERSONA_FILE.split("/"));
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, "First resolved call persona.\n");

    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDirectory;
    let firstHost: CodexAppServerHost | null = null;
    let resumedHost: CodexAppServerHost | null = null;
    const offers = [
      "v=0\r\no=- 101 2 IN IP4 127.0.0.1\r\na=ice-ufrag:first\r\na=ice-pwd:first-password\r\na=fingerprint:sha-256 11:22\r\n",
      "v=0\r\no=- 202 2 IN IP4 127.0.0.1\r\na=ice-ufrag:second\r\na=ice-pwd:second-password\r\na=fingerprint:sha-256 33:44\r\n",
      "v=0\r\no=- 303 2 IN IP4 127.0.0.1\r\na=ice-ufrag:third\r\na=ice-pwd:third-password\r\na=fingerprint:sha-256 55:66\r\n",
    ] as const;
    try {
      const firstServer = new FakeAppServer("voice-thread");
      firstServer.threadPath = transcriptPath;
      firstHost = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(firstServer),
      });
      const first = await firstHost.startRealtimeWebRtc(offers[0]);
      expect(first.personaBootstrap.insertion).toBe("accepted");
      await firstHost.stopRealtime();

      fs.writeFileSync(overridePath, "Changed after the call was resolved.\n");
      const duplicate = await firstHost.startRealtimeWebRtc(offers[1]);
      expect(duplicate.personaBootstrap).toEqual(first.personaBootstrap);
      expect(firstServer.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(1);
      await firstHost.stopRealtime();
      await firstHost.release();
      firstHost = null;

      fs.writeFileSync(overridePath, "Changed again after host restart.\n");
      const resumedServer = new FakeAppServer("voice-thread");
      resumedServer.threadPath = transcriptPath;
      resumedHost = await CodexAppServerHost.adopt("voice-thread", {
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(resumedServer),
      });
      const recovered = await resumedHost.startRealtimeWebRtc(offers[2]);
      expect(recovered.personaBootstrap).toEqual(first.personaBootstrap);
      expect(resumedServer.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(0);

      const canonical = fs.readFileSync(transcriptPath, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { payload: { id?: string; content?: Array<{ text?: string }> } })
        .filter((line) => line.payload.id === first.personaBootstrap.itemId);
      expect(canonical).toHaveLength(1);
      expect(canonical[0]?.payload.content?.[0]?.text).toBe("First resolved call persona.");
    } finally {
      if (firstHost) await firstHost.release();
      if (resumedHost) await resumedHost.release();
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("recognizes one persisted legacy persona row across repeated host restarts", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-voice-bootstrap-"));
    const transcriptPath = path.join(isolated, "legacy-voice-thread.jsonl");
    const threadId = "legacy-voice-thread";
    const legacyItemId = legacyVoicePersonaBootstrapItemId(threadId);
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: legacyItemId,
        role: "developer",
        content: [{ type: "input_text", text: "Persisted legacy persona." }],
      },
    })}\n`);

    for (const suffix of ["first", "second"]) {
      const server = new FakeAppServer(threadId);
      server.threadPath = transcriptPath;
      const host = await CodexAppServerHost.adopt(threadId, {
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
      });
      try {
        const started = await host.startRealtimeWebRtc(`v=0\r\na=ice-ufrag:${suffix}\r\n`);
        expect(started.personaBootstrap.insertion).toBe("accepted");
        expect(started.personaBootstrap.itemId.length).toBeLessThanOrEqual(64);
        expect(server.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(0);
        await host.stopRealtime();
      } finally {
        await host.release();
      }
    }

    const personaRows = fs.readFileSync(transcriptPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { payload?: { id?: string; role?: string } })
      .filter((line) => line.payload?.role === "developer" && line.payload.id?.startsWith("msg_voice_persona_"));
    expect(personaRows).toHaveLength(1);
    expect(personaRows[0]?.payload?.id).toBe(legacyItemId);
    fs.rmSync(isolated, { recursive: true, force: true });
  });

  test("seeds a resumed realtime call with the interrupted duplex tail in canonical order", async () => {
    const threadId = "voice-context-thread";
    const turnId = "turn-overlap";
    const firstUser = {
      type: "userMessage",
      id: "user-first",
      content: [{ type: "text", text: encodeCodexStructuredUserText("Give the first status.") }],
    };
    const followUpText = `<realtime_delegation>
  <input>Repeat the previous status.</input>
  <transcript_delta>[redacted incomplete duplex delta]</transcript_delta>
</realtime_delegation>`;
    const followUp = {
      type: "userMessage",
      id: "user-follow-up",
      content: [{ type: "text", text: encodeCodexStructuredUserText(followUpText) }],
    };
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "item", turnId, item: firstUser, phase: "completed", seq: 2 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "The first status is", seq: 3 });
    eventStore.append(threadId, { kind: "delta", turnId, text: " ready.", seq: 4 });
    eventStore.append(threadId, {
      kind: "item",
      turnId,
      item: { type: "contextCompaction", id: "compaction-one" },
      phase: "completed",
      seq: 5,
    });
    eventStore.append(threadId, { kind: "item", turnId, item: followUp, phase: "completed", seq: 6 });
    eventStore.append(threadId, { kind: "turn-ended", turnId, status: "interrupted", seq: 7 });
    eventStore.append(threadId, { kind: "session-status", status: "idle", seq: 8 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "interrupted",
      items: [firstUser, { type: "contextCompaction", id: "compaction-one" }, followUp],
    }], { type: "idle" });
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 8,
      spawnProcess: fakeSpawn(server),
    });
    const diagnostics: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => { diagnostics.push(values); };
    try {
      await host.startRealtimeWebRtc("v=0\r\noffer");
    } finally {
      console.info = originalInfo;
    }

    expect(server.requests.find((request) => request.method === "thread/realtime/start")?.params)
      .toMatchObject({
        initialItems: [
          { role: "assistant", text: "The first status is ready." },
          { role: "user", text: followUpText },
        ],
      });
    expect(diagnostics).toEqual([["[realtime context] selected", {
      providerStartupContext: true,
      durableTail: [
        { role: "assistant", source: "durable-delta", bytes: 26 },
        { role: "user", source: "durable-item", bytes: Buffer.byteLength(followUpText, "utf8") },
      ],
      truncated: false,
    }]]);
    expect(JSON.stringify(diagnostics)).not.toContain("The first status");
    expect(JSON.stringify(diagnostics)).not.toContain("realtime_delegation");
    await host.release();
  });

  test("leaves committed assistant context with the provider startup selector", async () => {
    const server = new FakeAppServer("voice-committed-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    server.notify("turn/started", {
      threadId: "voice-committed-thread",
      turn: { id: "turn-committed" },
    });
    server.notify("item/agentMessage/delta", {
      threadId: "voice-committed-thread",
      turnId: "turn-committed",
      delta: "Committed status.",
    });
    server.notify("item/completed", {
      threadId: "voice-committed-thread",
      turnId: "turn-committed",
      item: { type: "agentMessage", id: "assistant-committed", text: "Committed status." },
    });
    await Bun.sleep(0);

    await host.startRealtimeWebRtc("v=0\r\noffer");

    const params = server.requests.find((request) => request.method === "thread/realtime/start")?.params;
    expect(params).toMatchObject({ includeStartupContext: true });
    expect((params as { initialItems?: unknown[] }).initialItems).toBeUndefined();
    await host.release();
  });

  test("publishes a semantic voice chunk before the assistant response completes", async () => {
    const threadId = "voice-semantic-stream-thread";
    const turnId = "turn-semantic-stream";
    const eventDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-semantic-stream-"));
    const eventStore = new FileRuntimeEventStore(eventDirectory);
    const server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });
    await host.startRealtimeWebRtc("v=0\r\noffer");
    server.notify("turn/started", {
      threadId,
      turn: { id: turnId },
    });
    server.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      delta: "The first substantial part is ready and can be spoken while the remaining investigation continues, while enough related detail stays together to preserve the meaning and keep the spoken reply natural. ",
    });
    server.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      delta: "This second sentence starts the next semantic batch.",
    });
    await Bun.sleep(0);

    const streamed = eventStore.load(threadId).filter((event) =>
      (event as { kind: string }).kind === "voice-chunk");
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({
      kind: "voice-chunk",
      turnId,
      delivery: {
        sourceTurnId: turnId,
        streamChunk: { index: 0 },
      },
    });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: turnId });
    expect(eventStore.load(threadId).some((event) => event.kind === "item")).toBeFalse();

    const terminalText = "The first substantial part is ready and can be spoken while the remaining investigation continues, while enough related detail stays together to preserve the meaning and keep the spoken reply natural. This second sentence starts the next semantic batch.";
    server.notify("item/completed", {
      threadId,
      turnId,
      item: { type: "agentMessage", id: "assistant-semantic-stream", text: terminalText },
    });
    await Bun.sleep(0);
    const completedEvents = eventStore.load(threadId);
    const finalItem = completedEvents.findLast((event) => event.kind === "item");
    const voiceResponse = finalItem && "voiceResponse" in finalItem
      ? finalItem.voiceResponse
      : undefined;
    const streamedText = completedEvents
      .filter((event) => event.kind === "voice-chunk")
      .map((event) => event.delivery.responses[0]!.text)
      .join("");
    expect(streamedText + (voiceResponse?.text ?? "")).toBe(terminalText);
    await host.release();
    fs.rmSync(eventDirectory, { recursive: true, force: true });
  });

  test("bounds unacknowledged semantic chunks instead of forwarding every delta", async () => {
    const threadId = "voice-semantic-backpressure-thread";
    const turnId = "turn-semantic-backpressure";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });
    await host.startRealtimeWebRtc("v=0\r\noffer");
    server.notify("turn/started", { threadId, turn: { id: turnId } });
    for (let index = 0; index < 10; index += 1) {
      server.notify("item/agentMessage/delta", {
        threadId,
        turnId,
        delta: `${index}: ${"One cohesive explanation remains in a single speech request to keep quota use bounded and delivery natural. ".repeat(2)}`,
      });
    }
    await Bun.sleep(0);

    expect(eventStore.load(threadId).filter((event) => event.kind === "voice-chunk")).toHaveLength(6);
    await host.release();
  });

  test("bounds the unresolved realtime tail by UTF-8 bytes and item count", async () => {
    const server = new FakeAppServer("voice-bounded-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    server.notify("turn/started", {
      threadId: "voice-bounded-thread",
      turn: { id: "turn-bounded" },
    });
    server.notify("item/agentMessage/delta", {
      threadId: "voice-bounded-thread",
      turnId: "turn-bounded",
      delta: "🙂".repeat(3_000),
    });
    for (let index = 0; index < 20; index += 1) {
      server.notify("item/completed", {
        threadId: "voice-bounded-thread",
        turnId: "turn-bounded",
        item: {
          type: "userMessage",
          id: `user-${index}`,
          content: [{
            type: "text",
            text: encodeCodexStructuredUserText(`${"界".repeat(3_000)} follow-up-${index}`),
          }],
        },
      });
    }
    await Bun.sleep(0);
    const diagnostics: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => { diagnostics.push(values); };
    try {
      await host.startRealtimeWebRtc("v=0\r\noffer");
    } finally {
      console.info = originalInfo;
    }

    const params = server.requests.find((request) => request.method === "thread/realtime/start")?.params;
    const items = (params as { initialItems: Array<{ role: string; text: string }> }).initialItems;
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.role)).toEqual(["assistant", "user", "user"]);
    expect(items[1]?.text.endsWith("follow-up-18")).toBeTrue();
    expect(items[2]?.text.endsWith("follow-up-19")).toBeTrue();
    expect(items.every((item) => Buffer.byteLength(item.text, "utf8") <= 8 * 1024)).toBeTrue();
    expect(items.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0))
      .toBeLessThanOrEqual(24 * 1024);
    expect(items.every((item) => !item.text.includes("�"))).toBeTrue();
    expect(diagnostics).toMatchObject([["[realtime context] selected", { truncated: true }]]);
    expect(JSON.stringify(diagnostics)).not.toContain("follow-up-19");
    await host.release();
  });

  test("delivers a large multi-item response exactly once and deduplicates after host recovery", async () => {
    const eventStore = new MemoryEventStore();
    const firstServer = new FakeAppServer("voice-delivery-thread");
    const firstHost = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(firstServer),
    });
    const firstText = `${"🙂界".repeat(20_000)}\n`;
    const secondText = `${"🫶🏽".repeat(5_000)}done`;
    const delivery: RuntimeVoiceDelivery = {
      deliveryId: 'voice:["turn-delivery",["response-one","response-two"]]',
      turnId: "turn-delivery",
      responses: [
        { responseId: "response-one", text: firstText },
        { responseId: "response-two", text: secondText },
      ],
      ready: true,
    };

    await expect(firstHost.deliverRealtimeWorkerResponse(delivery)).resolves.toEqual({
      deliveryId: delivery.deliveryId,
      acknowledged: true,
    });
    await firstHost.deliverRealtimeWorkerResponse(delivery);
    expect(firstServer.acceptedRealtimeSpeech.join("")).toBe(firstText + secondText);
    expect(firstServer.acceptedRealtimeSpeech.every((chunk) =>
      Buffer.byteLength(chunk, "utf8") <= 8 * 1024)).toBeTrue();
    expect(eventStore.load("voice-delivery-thread").at(-1)).toMatchObject({
      kind: "realtime-delivery-acknowledged",
      deliveryId: delivery.deliveryId,
    });
    await expect(firstHost.deliverRealtimeWorkerResponse({
      ...delivery,
      responses: [
        { responseId: "response-one", text: "different content" },
        { responseId: "response-two", text: secondText },
      ],
    })).rejects.toThrow("delivery id belongs to different content");
    await firstHost.release();

    const replacementServer = new FakeAppServer("voice-delivery-thread");
    const replacementHost = await CodexAppServerHost.adopt("voice-delivery-thread", {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(replacementServer),
    });
    await replacementHost.deliverRealtimeWorkerResponse(delivery);
    expect(replacementServer.acceptedRealtimeSpeech).toEqual([]);
    await replacementHost.release();
  });

  test("resumes the exact Unicode suffix after a partial realtime send", async () => {
    const eventStore = new MemoryEventStore();
    const firstServer = new FakeAppServer("voice-partial-thread");
    firstServer.realtimeAppendErrorAt = 2;
    const firstHost = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(firstServer),
    });
    const text = `boundary:${"🙂🫶🏽界".repeat(8_000)}:end`;
    const delivery: RuntimeVoiceDelivery = {
      deliveryId: 'voice:["turn-partial",["response-partial"]]',
      turnId: "turn-partial",
      responses: [{ responseId: "response-partial", text }],
      ready: true,
    };

    await expect(firstHost.deliverRealtimeWorkerResponse(delivery))
      .rejects.toThrow("realtime channel replaced");
    const acceptedPrefix = firstServer.acceptedRealtimeSpeech.join("");
    expect(acceptedPrefix.length).toBeGreaterThan(0);
    expect(text.startsWith(acceptedPrefix)).toBeTrue();
    await firstHost.release();

    const replacementServer = new FakeAppServer("voice-partial-thread");
    const replacementHost = await CodexAppServerHost.adopt("voice-partial-thread", {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(replacementServer),
    });
    await replacementHost.deliverRealtimeWorkerResponse(delivery);
    expect(acceptedPrefix + replacementServer.acceptedRealtimeSpeech.join("")).toBe(text);
    await replacementHost.release();
  });

  test("the operator's override is the text that reaches the call's thread", async () => {
    /* The call path has to resolve the persona the way production does, not
       just inject some persona. With no override file on disk the resolver and
       the built-in default are the same string, so a call that injected the
       default would satisfy any assertion written against the resolver. An
       isolated config dir holding a known override splits the two apart: this
       expected text exists nowhere in the source, so only a call that actually
       read the override can produce it. */
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-persona-config-"));
    const overridePath = path.join(configDirectory, "agent-log-viewer", ...VOICE_PERSONA_FILE.split("/"));
    const override = "Isolated override persona for this call.";
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    /* Written with surrounding whitespace, because the resolver trims and the
       injected item must carry the trimmed text. */
    fs.writeFileSync(overridePath, `  ${override}\n`);
    expect(override).not.toBe(DEFAULT_VOICE_PERSONA);

    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDirectory;
    try {
      const server = new FakeAppServer("voice-thread");
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
      });
      await host.startRealtimeWebRtc("v=0\r\noffer");

      const injected = server.requests.find((request) => request.method === "thread/inject_items");
      const item = (injected?.params as {
        items?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>;
      })?.items?.[0];
      expect(item).toMatchObject({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: override }],
      });
      await host.release();
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      fs.rmSync(configDirectory, { recursive: true, force: true });
    }
  });

  test("a browser offer with its terminal CRLF is forwarded byte-for-byte", async () => {
    const server = new FakeAppServer("voice-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    await host.startRealtimeWebRtc("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n");
    const start = server.requests.find((request) => request.method === "thread/realtime/start");
    expect((start?.params as { transport?: { sdp?: string } })?.transport?.sdp)
      .toBe("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n");
    await host.release();
  });

  test("the V3 realtime session inherits the hosted thread's MCP configuration", async () => {
    const server = new FakeAppServer("voice-mcp-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      "agent-browser": { command: "browser-mcp", enabled: true, default_tools_approval_mode: "writes" },
      "telegram-readonly": { command: "telegram-mcp", enabled: true, default_tools_approval_mode: "prompt" },
    };
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      mcpServers: ["viewer", "agent-browser"],
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    /* The hosted thread is the only place the MCP table lives: thread/start
       enables the granted servers and restates realtime_conversation. The grant
       bound ships empty of connectors, so Viewer is the whole surface (#739). */
    expect(server.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
          "agent-browser": { enabled: false, default_tools_approval_mode: "writes" },
          "telegram-readonly": { enabled: false },
        },
        features: { realtime_conversation: true },
      },
    });

    await host.startRealtimeWebRtc("v=0\r\noffer");
    const realtimeStart = server.requests.find((request) => request.method === "thread/realtime/start");
    const params = realtimeStart?.params as Record<string, unknown>;
    /* App-server contract (codex 0.145.0): thread/realtime/start names the
       thread and nothing else — no MCP table, config, or tool list rides the
       call, so the session can only inherit the thread's servers above. */
    expect(params.threadId).toBe("voice-mcp-thread");
    expect(Object.keys(params).sort()).toEqual([
      "clientManagedHandoffs",
      "codexResponsesAsItems",
      "includeStartupContext",
      "model",
      "outputModality",
      "threadId",
      "transport",
      "version",
    ]);
    expect(server.requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    await host.release();
  });

  test("surfaces the app-server realtime admission error", async () => {
    const server = new FakeAppServer("voice-error-thread");
    server.realtimeStartError = "AVAS route unavailable";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    await expect(host.startRealtimeWebRtc("v=0\r\noffer")).rejects.toThrow("AVAS route unavailable");
    await host.release();
  });

  test("fresh structured threads enable only granted servers and disable the rest", async () => {
    const server = new FakeAppServer("custom-mcp-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      "agent-browser": { command: "browser-mcp", enabled: true, default_tools_approval_mode: "writes" },
      "telegram-readonly": { command: "telegram-mcp", enabled: true, default_tools_approval_mode: "prompt" },
    };
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      mcpServers: ["agent-browser"],
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(server.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
          "agent-browser": { enabled: false, default_tools_approval_mode: "writes" },
          "telegram-readonly": { enabled: false, default_tools_approval_mode: "prompt" },
        },
      },
    });
    await host.release();
  });

  test("round-trips image blocks through turn start and image-only steering", async () => {
    const server = new FakeAppServer("image-thread");
    server.modelList = [
      { id: "gpt-5.6-sol", isDefault: true, inputModalities: ["text", "image"] },
      { id: "gpt-5.3-codex-spark", isDefault: false, inputModalities: ["text"] },
    ];
    const resolved: StructuredImageRef[] = [];
    const first = {
      sha256: "1".repeat(64),
      mime: "image/png" as const,
      bytes: 67,
    };
    const second = {
      sha256: "2".repeat(64),
      mime: "image/webp" as const,
      bytes: 44,
    };
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.6-sol",
      eventStore: new MemoryEventStore(),
      resolveImagePath: (ref) => {
        resolved.push(ref);
        return `/runtime-images/${ref.sha256}`;
      },
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).activeFlags).toContain(STRUCTURED_IMAGE_CAPABILITY);
    const firstContent = structuredContent("inspect", [first]);
    expect(await host.send({ id: "image-start", ...firstContent })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    expect(server.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      input: [
        { type: "localImage", path: `/runtime-images/${first.sha256}` },
        { type: "text", text: `<!-- llv:structured-user sha256=${firstContent.contentDigest} -->\ninspect` },
      ],
      clientUserMessageId: "image-start",
    });

    const secondContent = structuredContent("", [second]);
    expect(await host.send({ id: "image-steer", expectedTurnId: "turn-1", ...secondContent })).toEqual({
      outcome: "steered",
      turnId: "turn-1",
    });
    expect(server.requests.find((request) => request.method === "turn/steer")?.params).toMatchObject({
      expectedTurnId: "turn-1",
      input: [
        { type: "localImage", path: `/runtime-images/${second.sha256}` },
        { type: "text", text: `<!-- llv:structured-user sha256=${secondContent.contentDigest} -->\n` },
      ],
      clientUserMessageId: "image-steer",
    });
    expect(resolved).toEqual([first, second]);
    await host.release();
  });

  test("an image echo past the old line bound no longer kills the host, and reaches storage bounded", async () => {
    const server = new FakeAppServer("oversized-thread");
    server.modelList = [{ id: "gpt-5.6-sol", isDefault: true, inputModalities: ["text", "image"] }];
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.6-sol",
      eventStore: store,
      resolveImagePath: (ref) => `/runtime-images/${ref.sha256}`,
      spawnProcess: fakeSpawn(server),
    });

    const body = Buffer.alloc(18 * 1024 * 1024, 9).toString("base64");
    expect(body.length).toBeGreaterThan(16 * 1024 * 1024);
    server.notify("item/completed", {
      threadId: "oversized-thread",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        clientId: "oversized-image",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${body}` },
          { type: "text", text: "look at this" },
        ],
      },
    });
    await Bun.sleep(50);

    expect((await host.health()).status).not.toBe("dead");
    const items = store.load("oversized-thread").filter((event) => event.kind === "item");
    expect(items).not.toHaveLength(0);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain(body.slice(0, 256));
    expect(serialized.length).toBeLessThan(64 * 1024);
    expect(serialized).toContain("localImage");
    await host.release();
  });

  test("keeps image affordance disabled for a text-only selected model", async () => {
    const server = new FakeAppServer("spark-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.3-codex-spark",
      eventStore: new MemoryEventStore(),
      resolveImagePath: () => { throw new Error("image path must stay unresolved"); },
      spawnProcess: fakeSpawn(server),
    });
    expect((await host.health()).activeFlags).not.toContain(STRUCTURED_IMAGE_CAPABILITY);
    await expect(host.send({
      id: "spark-image",
      content: { text: "inspect", images: [{ sha256: "3".repeat(64), mime: "image/png", bytes: 67 }] },
    })).rejects.toThrow("does not advertise image input");
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    await host.release();
  });

  test("a transient capability probe fault stays fail-closed and recovers on the next image send", async () => {
    const server = new FakeAppServer("probe-thread");
    server.modelList = [{ id: "gpt-5.6-sol", isDefault: true, inputModalities: ["text", "image"] }];
    /* Startup probe and the first on-demand retry both fault. */
    server.modelListFailuresRemaining = 2;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.6-sol",
      eventStore: new MemoryEventStore(),
      resolveImagePath: (ref) => `/runtime-images/${ref.sha256}`,
      spawnProcess: fakeSpawn(server),
    });
    const imageEntry = (id: string) => ({
      id,
      content: { text: "inspect", images: [{ sha256: "4".repeat(64), mime: "image/png" as const, bytes: 67 }] },
    });

    /* Probe-unavailable: fail closed with a retryable reason, never the
       model-incompatible verdict, and never actuate the turn. */
    expect((await host.health()).activeFlags).not.toContain(STRUCTURED_IMAGE_CAPABILITY);
    await expect(host.send(imageEntry("probe-image-one"))).rejects.toThrow("temporarily unavailable");
    expect(server.requests.some((request) => request.method === "turn/start")).toBeFalse();

    /* The probe recovers: the next image send re-discovers capability inside
       the same host lifetime and delivers. */
    expect(await host.send(imageEntry("probe-image-two"))).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect((await host.health()).activeFlags).toContain(STRUCTURED_IMAGE_CAPABILITY);

    /* A genuine text-only verdict still rejects with the model reason. */
    await host.release();
    const textOnlyServer = new FakeAppServer("probe-verdict-thread");
    textOnlyServer.modelListFailuresRemaining = 1;
    const textOnlyHost = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.3-codex-spark",
      eventStore: new MemoryEventStore(),
      resolveImagePath: () => { throw new Error("image path must stay unresolved"); },
      spawnProcess: fakeSpawn(textOnlyServer),
    });
    await expect(textOnlyHost.send(imageEntry("probe-image-three"))).rejects.toThrow("does not advertise image input");
    await textOnlyHost.release();
  });

  test("fans out replay, fences steering, answers attention, and persists host columns", async () => {
    const server = new FakeAppServer();
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    const blockedCredential = ["must", "stay", "private"].join("-");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      codexHome: "/codex-home",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        [["OPENAI", "API", "KEY"].join("_")]: blockedCredential,
        [["LLV", "TOKEN"].join("_")]: blockedCredential,
        [["ANTHROPIC", "AUTH", "TOKEN"].join("_")]: blockedCredential,
        [["AWS", "SESSION", "TOKEN"].join("_")]: blockedCredential,
        [["PRIVATE", "SERVICE", "API", "KEY"].join("_")]: blockedCredential,
      },
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });
    /* The allowlisted env, plus the provenance stamp the resources rail needs
       to tell this host from any other process wearing the same argv (#1199). */
    expect(captured.options?.env).toEqual({
      NODE_ENV: "test",
      PATH: process.env.PATH,
      CODEX_HOME: "/codex-home",
      [STRUCTURED_HOST_STAMP_ENV]: structuredHostStamp(),
    });
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

  test("a per-turn effort snapshot on the queue entry outranks the host default on turn/start (issue #390)", async () => {
    const overrideServer = new FakeAppServer("per-turn-effort");
    const overrideHost = await CodexAppServerHost.start({
      cwd: "/repo", effort: "medium", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(overrideServer),
    });
    await overrideHost.send({ id: "with-override", text: "run hot", runtime: { effort: "ultra", fast: true } });
    expect(overrideServer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ effort: "ultra" });
    await overrideHost.release();

    // A tier outside the codex vocabulary falls back to the host default
    // instead of failing the turn over a settings blemish.
    const invalidServer = new FakeAppServer("per-turn-invalid");
    const invalidHost = await CodexAppServerHost.start({
      cwd: "/repo", effort: "medium", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(invalidServer),
    });
    await invalidHost.send({ id: "with-blemish", text: "stay safe", runtime: { effort: "warp9" } });
    expect(invalidServer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ effort: "medium" });
    await invalidHost.release();
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

  test("accepts a legal resume response above the legacy frame guard", async () => {
    const threadId = "long-durable-thread";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "session-status", status: "idle", seq: 1 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: "historical-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "x".repeat(5 * 1024 * 1024) }],
    }]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });

    expect(server.requests.find((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ threadId });
    expect(await host.health()).toMatchObject({ status: "idle", eventCursor: 5 });
    await host.release();
  });

  /* An mcpToolCall replay item shaped like the production frame: one turn of
     Viewer tool calls whose result text dominates the envelope's byte count. */
  const fatReplayTurn = (turnId: string, itemPrefix: string, count: number, text: string) => ({
    id: turnId,
    status: "completed",
    items: Array.from({ length: count }, (_, index) => ({
      id: `${itemPrefix}-${index}`,
      type: "mcpToolCall",
      status: "completed",
      result: { Ok: { content: [{ type: "text", text }] } },
    })),
  });

  test("an overflowing thread/resume replay recovers metadata and paginates history", async () => {
    const threadId = "overflowing-resume-thread";
    const pagedTurns = [{
      id: "persisted-turn",
      status: "completed",
      items: [{ id: "persisted-item", type: "agentMessage", text: "bounded history" }],
    }];
    const server = new FakeAppServer(threadId, threadId, false, pagedTurns);
    const replayText = "x".repeat(16 * 1024);
    server.resumeReplayTurns = [fatReplayTurn("overflowing-turn", "overflowing-item", 4_200, replayText)];
    server.responseChunkBytes = 64 * 1024;
    const eventStore = new MemoryEventStore();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.adopt(threadId, {
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
      });

      const metadataReads = server.requests.filter((request) => request.method === "thread/read");
      expect(metadataReads).toHaveLength(1);
      expect(metadataReads[0]?.params).toEqual({ threadId, includeTurns: false });
      expect(server.requests.some((request) => request.method === "thread/turns/list")).toBeTrue();
      expect(server.requests.some((request) => request.method === "thread/items/list")).toBeTrue();
      expect(server.requests.some((request) => request.method === "thread/read"
        && (request.params as { includeTurns?: boolean }).includeTurns === true)).toBeFalse();
      expect(eventStore.load(threadId)).toContainEqual(expect.objectContaining({
        kind: "item",
        item: expect.objectContaining({ id: "persisted-item" }),
      }));
      expect((await host.health()).status).not.toBe("dead");
      expect(await host.send({ id: "post-recovery", text: "ping" })).toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  /* One legal paginated item can exceed the frame guard after the first
     string-reduction pass. Progressive shrinking keeps the page admissible. */
  test("an item page still oversized after string reduction shrinks without failing adoption", async () => {
    const threadId = "shrink-resume-thread";
    /* Every text part sits exactly at the string cap, so the first reduction
       pass keeps all ~25 MB and only the shrink passes can fit the frame. */
    const content = Array.from({ length: 1550 }, () => ({ type: "text", text: "z".repeat(16 * 1024) }));
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: "shrink-turn",
      status: "completed",
      items: [{
        id: "shrink-call-0",
        type: "mcpToolCall",
        status: "completed",
        result: { Ok: { content } },
      }],
    }]);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).status).not.toBe("dead");
    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).toContain("truncated");
    expect(await host.send({ id: "post-shrink", text: "ping" })).toMatchObject({ outcome: "turn-started" });
    await host.release();
  }, 30_000);

  /* A page is only as large as the records inside it. One whose bounded
     reduction exceeds the reducer output budget is re-requested a record at a
     time, so a size-coupled page cannot make the session unreachable on every
     adoption attempt (#301 Expected 1). */
  test("an item page over the reducer output budget is retried one item at a time and adoption completes", async () => {
    const threadId = "overflowing-item-page-thread";
    /* Three inline images: each survives the reducer's image cap whole, and
       together they pass the reduced-output budget that a ten-record page
       would have to fit. */
    const inlineImage = `data:image/png;base64,${"A".repeat(22_400_000)}`;
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: "overflow-turn",
      status: "completed",
      items: Array.from({ length: 3 }, (_, index) => ({
        id: `page-overflow-item-${index}`,
        type: "agentMessage",
        text: inlineImage,
      })),
    }]);
    const eventStore = new MemoryEventStore();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.adopt(threadId, {
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
      });

      const narrowed = server.requests.filter((request) => request.method === "thread/items/list"
        && (request.params as { limit?: number }).limit === 1);
      expect(narrowed).toHaveLength(1);
      const ids = eventStore.load(threadId)
        .filter((event) => event.kind === "item")
        .map((event) => (event.item as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string" && id.startsWith("page-overflow-item-"));
      expect(ids).toEqual(["page-overflow-item-0", "page-overflow-item-1", "page-overflow-item-2"]);
      expect((await host.health()).status).not.toBe("dead");
      expect(await host.send({ id: "after-page-overflow", text: "still reachable" }))
        .toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  /* One persisted record whose bounded reduction is still over the budget sits
     outside the supported envelope. Hydration stops there and says so rather
     than failing adoption, so everything newer stays readable (#301 Expected
     1 and 2). */
  test("a single item still over the reducer budget ends hydration with a diagnostic and adoption completes", async () => {
    const threadId = "unadmittable-item-thread";
    const inlineImage = `data:image/png;base64,${"A".repeat(22_400_000)}`;
    const server = new FakeAppServer(threadId, threadId, false, [
      {
        id: "unadmittable-turn",
        status: "completed",
        items: [{
          id: "unadmittable-item",
          type: "mcpToolCall",
          status: "completed",
          result: { Ok: { content: Array.from({ length: 3 }, () => ({ type: "text", text: inlineImage })) } },
        }],
      },
      {
        id: "newer-turn",
        status: "completed",
        items: [{ id: "newer-item", type: "agentMessage", text: "readable history" }],
      },
    ]);
    const eventStore = new MemoryEventStore();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.adopt(threadId, {
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
      });

      const stored = eventStore.load(threadId);
      expect(stored.some((event) => event.kind === "item"
        && (event.item as { id?: unknown }).id === "newer-item")).toBeTrue();
      expect(stored.some((event) => event.kind === "item"
        && (event.item as { id?: unknown }).id === "unadmittable-item")).toBeFalse();
      const diagnostics = stored.filter((event) => event.kind === "item"
        && /oversized JSONL frame: observed \d+ bytes, bound \d+ bytes, message type response to thread\/items\/list/
          .test(String((event.item as { text?: unknown }).text ?? "")));
      expect(diagnostics.length).toBeGreaterThan(0);
      expect((await host.health()).status).not.toBe("dead");
      expect(await host.send({ id: "after-unadmittable-item", text: "still reachable" }))
        .toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  /* The single-frame history path this issue removes must not regrow: neither
     adoption nor delivery may ask for a full turn page or a full thread read
     (#301 P2). */
  test("adoption and delivery never request full turn pages or full thread reads", async () => {
    const threadId = "no-full-history-thread";
    const server = new FakeAppServer(threadId, threadId, false, smallHistoryTurns(12));
    server.rejectFullTurnPages = true;
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    server.turnsListSource = [
      ...smallHistoryTurns(12),
      {
        id: "persisted-turn",
        status: "completed",
        items: [{ type: "userMessage", clientId: "already-persisted", content: [{ type: "text", text: "hello" }] }],
      },
    ];
    expect(await host.send({ id: "already-persisted", text: "hello" }))
      .toEqual({ outcome: "turn-started", turnId: "persisted-turn" });
    expect(await host.send({ id: "fresh-delivery", text: "next" }))
      .toMatchObject({ outcome: "turn-started" });

    expect(server.requests.some((request) => request.method === "thread/turns/list"
      && (request.params as { itemsView?: unknown }).itemsView === "full")).toBeFalse();
    expect(server.requests.some((request) => request.method === "thread/read"
      && (request.params as { includeTurns?: unknown }).includeTurns === true)).toBeFalse();
    await host.release();
  });

  test("inline image history in an item page reaches the ledger only as a bounded reference", async () => {
    const threadId = "image-replay-thread";
    const body = Buffer.alloc(1024 * 1024, 5).toString("base64");
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: "image-turn",
      status: "completed",
      items: [{
        id: "image-echo",
        type: "userMessage",
        clientId: "image-echo",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${body}` },
          { type: "text", text: "replayed screenshot" },
        ],
      }],
    }]);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      resolveImagePath: (ref) => `/runtime-images/${ref.sha256}`,
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).status).not.toBe("dead");
    const serialized = JSON.stringify(eventStore.load(threadId).filter((event) => event.kind === "item"));
    expect(serialized).toContain("localImage");
    expect(serialized).not.toContain(body.slice(0, 256));
    expect(serialized.length).toBeLessThan(64 * 1024);
    await host.release();
  });

  test("a queued send settles exactly once across an oversized paginated confirmation", async () => {
    const threadId = "oversized-read-thread";
    const fatText = "y".repeat(1024 * 1024);
    const server = new FakeAppServer(threadId, threadId);
    const fatTurn = fatReplayTurn("persisted-turn", "read-call", 26, fatText);
    server.readTurns = [{
      ...fatTurn,
      items: [
        ...fatTurn.items,
        { type: "userMessage", clientId: "operation-recovered", content: [{ type: "text", text: "hello" }] },
      ],
    }];
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-recovered", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "persisted-turn",
    });
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    expect((await host.health()).status).not.toBe("dead");
    await host.release();
  });

  const smallHistoryTurns = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    items: [{ id: `item-${index}`, type: "agentMessage", text: `reply ${index}` }],
  }));

  test("adoption resumes metadata-only and hydrates history through bounded turn pages", async () => {
    const threadId = "paginated-resume-thread";
    const server = new FakeAppServer(threadId, threadId, false, smallHistoryTurns(25));
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect(server.requests.find((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ threadId, excludeTurns: true });
    const pages = server.requests.filter((request) => request.method === "thread/turns/list");
    expect(pages).toHaveLength(3);
    expect(pages[0]?.params).toMatchObject({ threadId, cursor: "0", itemsView: "notLoaded", sortDirection: "desc", limit: 10 });
    expect((pages[1]?.params as { cursor?: unknown }).cursor).toBe("10");
    expect((pages[2]?.params as { cursor?: unknown }).cursor).toBe("20");
    const itemPages = server.requests.filter((request) => request.method === "thread/items/list");
    expect(itemPages[0]?.params).toMatchObject({
      threadId,
      cursor: server.resumeItemsBackwardsCursor,
      sortDirection: "desc",
      limit: 10,
    });

    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    expect(items.map((event) => (event.item as { id: string }).id))
      .toEqual(Array.from({ length: 25 }, (_, index) => `item-${index}`));
    const started = eventStore.load(threadId).filter((event) => event.kind === "turn-started");
    expect(started).toHaveLength(25);
    expect((await host.health()).status).not.toBe("dead");
    expect(await host.send({ id: "after-paginated-resume", text: "ping" })).toMatchObject({ outcome: "turn-started" });
    await host.release();
  });

  test("single-turn history hydrates through bounded item pages", async () => {
    const threadId = "single-large-turn-thread";
    const itemText = "x".repeat(1_100_000);
    const turns = [{
      id: "concentrated-turn",
      status: "completed",
      items: Array.from({ length: 25 }, (_, index) => ({
        id: `concentrated-item-${index}`,
        type: "agentMessage",
        text: itemText,
      })),
    }];
    expect(Buffer.byteLength(JSON.stringify(turns))).toBeGreaterThan(MAX_APP_SERVER_LINE_BYTES);
    const server = new FakeAppServer(threadId, threadId, false, turns);
    server.rejectFullTurnPages = true;
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    const turnPages = server.requests.filter((request) => request.method === "thread/turns/list");
    expect(turnPages).toHaveLength(1);
    expect(turnPages[0]?.params).toMatchObject({ itemsView: "notLoaded", limit: 10 });
    const itemPages = server.requests.filter((request) => request.method === "thread/items/list");
    expect(itemPages).toHaveLength(3);
    expect(itemPages[0]?.params).toMatchObject({
      cursor: server.resumeItemsBackwardsCursor,
      sortDirection: "desc",
      limit: 10,
    });
    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    expect(items.map((event) => (event.item as { id: string }).id))
      .toEqual(Array.from({ length: 25 }, (_, index) => `concentrated-item-${index}`));
    expect((await host.health()).status).not.toBe("dead");
    expect(await host.send({ id: "after-concentrated-history", text: "still reachable" }))
      .toMatchObject({ outcome: "turn-started" });
    await host.release();
  }, 30_000);

  test("a session past the size that killed the host resumes through pages and takes a message", async () => {
    const threadId = "large-session-thread";
    /* The production shape combines many turns of modest items. Their
       structure exceeds the frame bound even after string truncation. */
    const itemText = "x".repeat(16_000);
    const turns = Array.from({ length: 170 }, (_, turnIndex) => ({
      id: `bulk-turn-${turnIndex}`,
      status: "completed",
      items: Array.from({ length: 10 }, (_, itemIndex) => ({
        id: `bulk-item-${turnIndex}-${itemIndex}`,
        type: "mcpToolCall",
        status: "completed",
        result: { Ok: { content: [{ type: "text", text: itemText }] } },
      })),
    }));
    expect(JSON.stringify(turns).length).toBeGreaterThan(MAX_APP_SERVER_LINE_BYTES);
    const server = new FakeAppServer(threadId, threadId, false, turns);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).status).not.toBe("dead");
    expect(server.requests.filter((request) => request.method === "thread/turns/list").length).toBeGreaterThan(1);
    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    expect(items).toHaveLength(1_700);
    expect(new Set(items.map((event) => (event.item as { id: string }).id)).size).toBe(1_700);
    expect(await host.send({ id: "large-session-message", text: "still deliverable" }))
      .toMatchObject({ outcome: "turn-started" });
    await host.release();
  }, 30_000);

  test("a stale turn-page cursor restarts the sweep once without duplicating history", async () => {
    const threadId = "stale-cursor-thread";
    const server = new FakeAppServer(threadId, threadId, false, smallHistoryTurns(25));
    server.invalidCursorErrorsRemaining = 1;
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    const pages = server.requests.filter((request) => request.method === "thread/turns/list");
    /* The resume anchor fails once; the current newest page starts a three-page retry. */
    expect(pages).toHaveLength(4);
    expect((pages[0]?.params as { cursor?: unknown }).cursor).toBe("0");
    expect((pages[1]?.params as { cursor?: unknown }).cursor).toBeUndefined();
    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    expect(items.map((event) => (event.item as { id: string }).id))
      .toEqual(Array.from({ length: 25 }, (_, index) => `item-${index}`));
    expect(eventStore.load(threadId).filter((event) => event.kind === "turn-started")).toHaveLength(25);
    expect((await host.health()).status).not.toBe("dead");
    await host.release();
  });

  test("a turn repeated across pages reconciles once with its freshest content", async () => {
    const threadId = "changed-underneath-thread";
    const turns = smallHistoryTurns(24);
    /* The same turn id surfaces again later in the sweep with an extra item,
       modeling a thread that changed while pages were being read. */
    turns.push({
      id: "turn-3",
      status: "completed",
      items: [
        { id: "item-3", type: "agentMessage", text: "reply 3" },
        { id: "item-3-followup", type: "agentMessage", text: "reply 3 refreshed" },
      ],
    });
    const server = new FakeAppServer(threadId, threadId, false, turns);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    const ids = items.map((event) => (event.item as { id: string }).id);
    expect(ids.filter((id) => id === "item-3")).toHaveLength(1);
    expect(ids).toContain("item-3-followup");
    expect(eventStore.load(threadId)
      .filter((event) => event.kind === "turn-started" && event.turnId === "turn-3")).toHaveLength(1);
    await host.release();
  });

  test("delivery confirmation scans persisted history through bounded descending pages", async () => {
    const threadId = "paginated-confirmation-thread";
    const server = new FakeAppServer(threadId, threadId);
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    /* History persisted underneath the live host after adoption. */
    server.turnsListSource = [
      ...smallHistoryTurns(15),
      {
        id: "persisted-turn",
        status: "completed",
        items: [{ type: "userMessage", clientId: "operation-recovered", content: [{ type: "text", text: "hello" }] }],
      },
    ];
    expect(await host.send({ id: "operation-recovered", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "persisted-turn",
    });
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    const scans = server.requests.filter((request) =>
      request.method === "thread/items/list" && (request.params as { sortDirection?: string }).sortDirection === "desc");
    expect(scans.length).toBeGreaterThan(0);
    expect(server.requests.some((request) => request.method === "thread/read")).toBeFalse();
    await host.release();
  });

  test("delivery confirmation treats an unloaded paginated thread as empty history", async () => {
    const threadId = "unloaded-confirmation-thread";
    const server = new FakeAppServer(threadId, threadId);
    server.itemListError = "thread not loaded";
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-recovered", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    expect(server.requests.some((request) => request.method === "thread/read")).toBeFalse();
    await host.release();
  });

  test("a malformed delivery-history page fails before starting a duplicate turn", async () => {
    const server = new FakeAppServer("malformed-page-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    server.malformedItemPage = true;

    await expect(host.send({ id: "possibly-persisted", text: "hello" }))
      .rejects.toThrow("thread/items/list returned no data array");
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    expect((await host.health()).status).not.toBe("dead");
    await host.release();
  });

  test("a malformed delivery-history item fails before starting a duplicate turn", async () => {
    const server = new FakeAppServer("malformed-item-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    server.malformedItemEntry = true;

    await expect(host.send({ id: "possibly-persisted-item", text: "hello" }))
      .rejects.toThrow("thread/items/list returned a malformed item entry");
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    expect((await host.health()).status).not.toBe("dead");
    await host.release();
  });

  test("an oversized notification frame is skipped with a surfaced diagnostic and the host survives", async () => {
    const threadId = "oversized-notification-thread";
    const server = new FakeAppServer(threadId);
    const eventStore = new MemoryEventStore();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });

      server.notify("item/completed", {
        threadId,
        turnId: "turn-9",
        item: { type: "agentMessage", text: "z".repeat(26 * 1024 * 1024) },
      });
      await Bun.sleep(20);
      expect((await host.health()).status).not.toBe("dead");

      const diagnostics = eventStore.load(threadId)
        .filter((event) => event.kind === "item" && JSON.stringify(event.item).includes("oversized"));
      expect(diagnostics).toHaveLength(1);
      const text = ((diagnostics[0] as { item: { text: string } }).item).text;
      expect(text).toContain("item/completed");
      expect(text).toContain(`${MAX_APP_SERVER_LINE_BYTES}`);
      expect(text).toMatch(/\d{8} bytes/);
      expect(warn).toHaveBeenCalled();

      expect(await host.send({ id: "after-skip", text: "still reachable" })).toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  test("an oversized completion buffered before restore keeps adoption reachable", async () => {
    const threadId = "oversized-pre-restore-completion-thread";
    const turnId = "turn-completed-before-restore";
    const body = Buffer.alloc(19 * 1024 * 1024, 7).toString("base64");
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(
      threadId,
      threadId,
      false,
      [{ id: turnId, status: "inProgress", items: [] }],
      { type: "active", activeFlags: ["running"] },
      {
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "completed",
            items: [{
              id: "large-image-result",
              type: "userMessage",
              content: [{ type: "input_image", image_url: `data:image/png;base64,${body}` }],
            }],
          },
        },
      },
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.adopt(threadId, {
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });

      expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
      expect(eventStore.load(threadId)).toContainEqual(expect.objectContaining({
        kind: "turn-ended",
        turnId,
        status: "completed",
      }));
      expect(eventStore.load(threadId).some((event) => event.kind === "item"
        && JSON.stringify(event.item).includes("pre-restore notification exceeded")))
        .toBeTrue();
      expect(await host.send({ id: "after-pre-restore-completion", text: "continue" }))
        .toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  test("a legal chunked completion keeps its full content", async () => {
    const threadId = "chunked-legal-completion-thread";
    const server = new FakeAppServer(threadId);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });
    const text = "u".repeat(512 * 1024);
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId: "turn-legal",
        item: { id: "legal-item", type: "agentMessage", text },
      },
    })}\n`;
    for (let offset = 0; offset < line.length; offset += 64 * 1024) {
      server.stdout.write(line.slice(offset, offset + 64 * 1024));
    }
    await Bun.sleep(10);

    const item = eventStore.load(threadId).find((event) => event.kind === "item"
      && (event.item as { id?: string }).id === "legal-item");
    expect(item).toMatchObject({ item: { text } });
    expect(eventStore.load(threadId).some((event) => event.kind === "item"
      && JSON.stringify(event.item).includes("oversized"))).toBeFalse();
    await host.release();
  });

  test("an oversized turn completion preserves the active-turn lifecycle", async () => {
    const threadId = "oversized-turn-completion-thread";
    const server = new FakeAppServer(threadId);
    const eventStore = new MemoryEventStore();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });
      const first = await host.send({ id: "before-large-completion", text: "hello" });
      expect(first.outcome).toBe("turn-started");
      const turnId = first.outcome === "turn-started" ? first.turnId : "unexpected";

      server.notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          items: [{ type: "agentMessage", text: "z".repeat(26 * 1024 * 1024) }],
        },
      });
      await Bun.sleep(20);

      expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
      expect(eventStore.load(threadId)).toContainEqual(expect.objectContaining({
        kind: "turn-ended",
        turnId,
        status: "completed",
      }));
      expect(await host.send({ id: "after-large-completion", text: "again" }))
        .toMatchObject({ outcome: "turn-started" });
      expect(server.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
      expect(server.requests.some((request) => request.method === "turn/steer")).toBeFalse();
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  test("an oversized item completion still settles pending delivery", async () => {
    const threadId = "oversized-delivery-completion-thread";
    const server = new FakeAppServer(threadId);
    server.autoCompleteUserMessage = false;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
        deliveryConfirmationTimeoutMs: 100,
        ...stubbedTermination(server),
      });
      const delivery = host.send({ id: "large-delivery-completion", text: "hello" });
      const deadline = Date.now() + 2_000;
      let turnStart: Record<string, unknown> | undefined;
      while (!turnStart && Date.now() < deadline) {
        turnStart = server.requests.find((request) => request.method === "turn/start");
        await Bun.sleep(5);
      }
      expect(turnStart).toBeDefined();
      const params = turnStart?.params as { input: unknown };
      server.notify("item/completed", {
        threadId,
        turnId: "turn-1",
        item: {
          type: "userMessage",
          clientId: "large-delivery-completion",
          content: params.input,
          padding: "p".repeat(26 * 1024 * 1024),
        },
      });

      await expect(delivery).resolves.toEqual({ outcome: "turn-started", turnId: "turn-1" });
      expect((await host.health()).status).not.toBe("dead");
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  /* A mutating acknowledgement too large to admit is a delivery whose turn id
     is late, not a delivery that failed: the persisted user item carries the
     outcome, so the first send resolves with it (#301 Expected 1 and 3). */
  test("an oversized turn/start acknowledgement resolves the delivery from the persisted user item", async () => {
    const server = new FakeAppServer("oversized-turn-start-thread");
    server.oversizedTurnStartResult = true;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });

      const entry = { id: "oversized-turn-start", text: "hi" };
      expect(await host.send(entry)).toEqual({ outcome: "turn-started", turnId: "turn-1" });
      expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
      expect(server.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);

      expect(await host.send({
        id: "after-oversized-response",
        text: "again",
        expectedTurnId: "turn-1",
      })).toEqual({ outcome: "steered", turnId: "turn-1" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  test("an oversized turn/steer acknowledgement resolves as steered without a duplicate steer", async () => {
    const server = new FakeAppServer("oversized-turn-steer-thread");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });
      expect(await host.send({ id: "first-turn", text: "begin" }))
        .toEqual({ outcome: "turn-started", turnId: "turn-1" });
      server.oversizedTurnSteerResult = true;
      const steer = { id: "oversized-steer", text: "continue", expectedTurnId: "turn-1" };

      expect(await host.send(steer)).toEqual({ outcome: "steered", turnId: "turn-1" });
      expect((await host.health()).status).not.toBe("dead");
      expect(server.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  /* An oversized `error` envelope means the server refused: nothing started,
     so this delivery fails with the diagnostic while the writer stays open. */
  test("an oversized error acknowledgement rejects the delivery and leaves later deliveries writable", async () => {
    const server = new FakeAppServer("oversized-error-ack-thread");
    server.oversizedTurnStartErrorResult = true;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });

      await expect(host.send({ id: "refused-delivery", text: "hi" }))
        .rejects.toThrow(/oversized JSONL frame.*message type response to turn\/start/);
      expect((await host.health()).status).not.toBe("dead");

      server.oversizedTurnStartErrorResult = false;
      expect(await host.send({ id: "later-delivery", text: "still writable" }))
        .toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  /* An acknowledgement without a client id used to close the writer forever:
     the card said alive and nothing could ever be delivered again (#301). */
  test("an oversized turn/interrupt acknowledgement leaves deliveries writable", async () => {
    const server = new FakeAppServer("oversized-interrupt-ack-thread");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });
      expect(await host.send({ id: "interrupt-turn", text: "begin" }))
        .toEqual({ outcome: "turn-started", turnId: "turn-1" });
      server.oversizedTurnInterruptResult = true;

      await expect(host.interrupt("turn-1"))
        .rejects.toThrow(/oversized JSONL frame.*message type response to turn\/interrupt/);
      expect((await host.health()).status).not.toBe("dead");

      expect(await host.send({ id: "after-interrupt", text: "still writable", expectedTurnId: "turn-1" }))
        .toEqual({ outcome: "steered", turnId: "turn-1" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  test("an oversized response that no request is awaiting is skipped and the host survives", async () => {
    const server = new FakeAppServer("oversized-response-thread");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });

      server.stdout.write(`{"id":777,"result":{"blob":"${"w".repeat(26 * 1024 * 1024)}"}}\n`);
      await Bun.sleep(20);
      expect((await host.health()).status).not.toBe("dead");
      expect(warn).toHaveBeenCalled();
      expect(await host.send({ id: "after-unmatched", text: "still here" })).toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  test("an oversized server request with a colliding client rpc id receives its own error response", async () => {
    const threadId = "oversized-collision-thread";
    const server = new FakeAppServer(threadId, threadId, false, [], undefined, null, ["turn/start"]);
    const eventStore = new MemoryEventStore();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });

      /* Hold turn/start unanswered so its rpc id stays pending, then emit an
         oversized server request reusing that exact numeric id — the server's
         outgoing-request counter and the client's rpc counter are independent
         id spaces, so this collision is legal. */
      const sendPromise = host.send({ id: "collide", text: "hi" });
      sendPromise.catch(() => {});
      const requestDeadline = Date.now() + 2000;
      while (!server.requests.some((request) => request.method === "turn/start") && Date.now() < requestDeadline) {
        await Bun.sleep(5);
      }
      const turnStart = server.requests.find((request) => request.method === "turn/start") as
        { id: number; params: { input: unknown } };
      expect(typeof turnStart?.id).toBe("number");

      server.stdout.write(`{"jsonrpc":"2.0","id":${turnStart.id},"method":"execCommandApproval","params":{"pad":"${"x".repeat(26 * 1024 * 1024)}"}}\n`);
      const replyDeadline = Date.now() + 2000;
      let errorReply: Record<string, unknown> | undefined;
      while (!errorReply && Date.now() < replyDeadline) {
        errorReply = server.requests.find((request) => request.id === turnStart.id && request.error !== undefined);
        await Bun.sleep(5);
      }
      expect(errorReply?.error).toMatchObject({ message: "oversized frame skipped by client" });
      expect((await host.health()).status).not.toBe("dead");

      const diagnostics = eventStore.load(threadId)
        .filter((event) => event.kind === "item" && JSON.stringify(event.item).includes("oversized"));
      expect(diagnostics).toHaveLength(1);
      expect(((diagnostics[0] as { item: { text: string } }).item).text).toContain("execCommandApproval");

      server.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: turnStart.id, result: { turn: { id: "turn-collide" } } })}\n`);
      server.notify("item/completed", {
        threadId,
        turnId: "turn-collide",
        item: { type: "userMessage", clientId: "collide", content: turnStart.params.input },
      });
      await expect(sendPromise).resolves.toMatchObject({ outcome: "turn-started", turnId: "turn-collide" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  test("an unterminated oversized tail buffer is discarded to the next newline and the host survives", async () => {
    const threadId = "oversized-tail-thread";
    const server = new FakeAppServer(threadId);
    const eventStore = new MemoryEventStore();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = await CodexAppServerHost.start({
        cwd: "/repo",
        eventStore,
        spawnProcess: fakeSpawn(server),
        ...stubbedTermination(server),
      });

      /* One giant notification frame delivered without its terminating newline
         first, then the newline plus a healthy frame on the same stream. */
      const giant = `{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"${threadId}","turnId":"turn-1","item":{"type":"agentMessage","text":"${"q".repeat(26 * 1024 * 1024)}"}}}`;
      for (let offset = 0; offset < giant.length; offset += 4 * 1024 * 1024) {
        server.stdout.write(giant.slice(offset, offset + 4 * 1024 * 1024));
        await Bun.sleep(1);
      }
      await Bun.sleep(10);
      expect((await host.health()).status).not.toBe("dead");
      server.stdout.write("\n");
      await Bun.sleep(10);

      expect((await host.health()).status).not.toBe("dead");
      const diagnostics = eventStore.load(threadId)
        .filter((event) => event.kind === "item" && JSON.stringify(event.item).includes("oversized"));
      expect(diagnostics).toHaveLength(1);
      const text = ((diagnostics[0] as { item: { text: string } }).item).text;
      expect(text).toContain("item/completed");
      expect(text).toContain(`${MAX_APP_SERVER_LINE_BYTES}`);
      expect(await host.send({ id: "after-tail-discard", text: "ping" })).toMatchObject({ outcome: "turn-started" });
      await host.release();
    } finally {
      warn.mockRestore();
    }
  });

  test("managed-home adoption discovers Viewer and resumes with every unrelated MCP server disabled", async () => {
    const server = new FakeAppServer("managed-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      playwright: { command: "npx", enabled: true },
      "telegram-readonly": { command: "uv", enabled: true },
    };
    const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
    const host = await CodexAppServerHost.adopt("managed-thread", {
      cwd: "/repo",
      codexHome: "/managed-codex-home",
      fileAuthCredentials: true,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });
    expect(captured.args).toEqual([
      "-c",
      "cli_auth_credentials_store=file",
      "app-server",
      "--enable",
      "realtime_conversation",
    ]);
    expect(captured.options?.env?.CODEX_HOME).toBe("/managed-codex-home");
    expect(captured.options?.detached).toBeTrue();
    expect(server.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    const resume = server.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
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
    const eventStore = new MemoryEventStore();
    eventStore.append("requested-thread", { kind: "session-status", status: "idle", seq: 1 });
    await expect(CodexAppServerHost.adopt("requested-thread", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    })).rejects.toThrow("thread/resume returned a different thread id");
    expect(server.signals).toContain("SIGTERM");
    expect(eventStore.load("requested-thread")).toEqual([
      { kind: "session-status", status: "idle", seq: 1 },
    ]);
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
    server.itemListError = "thread fresh-delivery-thread is not materialized yet; history is unavailable before first user message";
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

  test.each([2906, 2908])("anchors pre-restore notifications after durable sequence 2907 when the registry cursor is %i", async (registryCursor) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-cursor-recovery-"));
    const threadId = `cursor-recovery-${registryCursor}`;
    const ledgerPath = path.join(directory, `${encodeURIComponent(threadId)}.jsonl`);
    const durableEvents = Array.from({ length: 2_907 }, (_, index) => JSON.stringify({
      kind: "session-status",
      status: "idle",
      seq: index + 1,
    })).join("\n");
    fs.writeFileSync(ledgerPath, `${durableEvents}\n`, { mode: 0o600 });
    const eventStore = new FileRuntimeEventStore(directory);
    const diagnostics: unknown[] = [];
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" }, {
      id: "approval-before-restore",
      method: "item/commandExecution/requestApproval",
      params: { command: "date" },
    });

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: registryCursor,
      onEventCursorRecovery: (diagnostic) => diagnostics.push(diagnostic),
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(-3)).toEqual([
      { kind: "session-status", status: "idle", seq: 2_907 },
      {
        kind: "attention",
        id: "item/commandExecution/requestApproval:approval-before-restore",
        method: "item/commandExecution/requestApproval",
        attention: { command: "date" },
        seq: 2_908,
      },
      { kind: "session-status", status: "idle", seq: 2_909 },
    ]);
    expect(await host.health()).toMatchObject({
      status: "attention",
      eventCursor: 2_909,
      pendingAttention: ["item/commandExecution/requestApproval:approval-before-restore"],
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      kind: "runtime-event-cursor-recovery",
      sessionId: threadId,
      durableTailSeq: 2_907,
      registryCursor,
      chosenNextSeq: 2_908,
      action: "use-durable-tail",
    })]);
    await host.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("persists overlapping pre-restore lifecycle notifications exactly once after a 942-record ledger", async () => {
    const threadId = ["019f66b5", "8694", "7410", "8671", "fbec75484a86"].join("-");
    const turnId = "turn-after-942";
    const item = { type: "agentMessage", id: "item-after-942", text: "resumed response" };
    const eventStore = new MemoryEventStore();
    for (let seq = 1; seq <= 942; seq += 1) {
      eventStore.append(threadId, { kind: "session-status", status: "idle", seq });
    }
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "completed",
      items: [item],
    }], { type: "idle" }, [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/started", params: { threadId, turnId, item } },
      { method: "item/completed", params: { threadId, turnId, item } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 942,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(942)).toEqual([
      { kind: "turn-started", turnId, seq: 943 },
      { kind: "item", turnId, item, phase: "started", seq: 944 },
      { kind: "item", turnId, item, phase: "completed", seq: 945 },
      { kind: "turn-ended", turnId, status: "completed", seq: 946 },
      { kind: "session-status", status: "idle", seq: 947 },
    ]);
    await host.release();

    const restartCursor = eventStore.load(threadId).at(-1)!.seq;
    const replacement = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: restartCursor,
      spawnProcess: fakeSpawn(new FakeAppServer(threadId, threadId, false, [{
        id: turnId,
        status: "completed",
        items: [item],
      }], { type: "idle" })),
    });
    const lifecycle = eventStore.load(threadId).filter((event) =>
      event.kind === "turn-started" || event.kind === "item" || event.kind === "turn-ended");
    expect(lifecycle).toEqual([
      { kind: "turn-started", turnId, seq: 943 },
      { kind: "item", turnId, item, phase: "started", seq: 944 },
      { kind: "item", turnId, item, phase: "completed", seq: 945 },
      { kind: "turn-ended", turnId, status: "completed", seq: 946 },
    ]);
    await replacement.release();
  });

  test("a buffered completion keeps a stale active resume snapshot terminal", async () => {
    const threadId = "buffered-terminal-stale-active-snapshot";
    const turnId = "turn-completed-during-resume";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, {
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stale-resume-registry-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: threadId };
    registry.upsert({
      key,
      artifactPath: `/sessions/${threadId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:released",
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
    const stopPersistence = await bindCodexHostPersistence(registry, key, host, "viewer", 7);

    expect(eventStore.load(threadId)).toEqual([
      { kind: "turn-started", turnId, seq: 1 },
      { kind: "turn-ended", turnId, status: "completed", seq: 2 },
      { kind: "session-status", status: "idle", seq: 3 },
    ]);
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    expect(registry.snapshot().entries[`codex:${threadId}`]).toMatchObject({
      status: "idle",
      structuredHost: { eventCursor: 3, activeTurnRef: null },
    });

    stopPersistence();
    await host.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("a newer buffered turn survives the stale snapshot of its completed predecessor", async () => {
    const threadId = "buffered-successor-after-stale-snapshot";
    const completedTurnId = "turn-stale-snapshot";
    const activeTurnId = "turn-started-during-resume";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: completedTurnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      {
        method: "turn/completed",
        params: { threadId, turn: { id: completedTurnId, status: "completed" } },
      },
      { method: "turn/started", params: { threadId, turn: { id: activeTurnId } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId)).toEqual([
      { kind: "turn-started", turnId: completedTurnId, seq: 1 },
      { kind: "turn-ended", turnId: completedTurnId, status: "completed", seq: 2 },
      { kind: "turn-started", turnId: activeTurnId, seq: 3 },
      { kind: "session-status", status: "active", activeFlags: ["running"], seq: 4 },
    ]);
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: activeTurnId });
    await host.release();
  });

  test("deduplicates a buffered lifecycle overlap against the durable crash prefix", async () => {
    const threadId = `${["019f66b5", "8694", "7410", "8671", "fbec75484a86"].join("-")}-overlap`;
    const turnId = "turn-overlapping-942";
    const item = { type: "agentMessage", id: "item-overlapping-942", text: "resumed response" };
    const eventStore = new MemoryEventStore();
    for (let seq = 1; seq <= 940; seq += 1) {
      eventStore.append(threadId, { kind: "session-status", status: "idle", seq });
    }
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 941 });
    eventStore.append(threadId, { kind: "item", turnId, item, phase: "started", seq: 942 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "completed",
      items: [item],
    }], { type: "idle" }, [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/started", params: { threadId, turnId, item } },
      { method: "item/completed", params: { threadId, turnId, item } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 942,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(942)).toEqual([
      { kind: "item", turnId, item, phase: "completed", seq: 943 },
      { kind: "turn-ended", turnId, status: "completed", seq: 944 },
      { kind: "session-status", status: "idle", seq: 945 },
    ]);
    await host.release();
  });

  test("reconciles repeated buffered deltas by occurrence against the durable crash prefix", async () => {
    const threadId = "buffered-delta-overlap";
    const turnId = "buffered-delta-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "same fragment", seq: 2 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "same fragment" } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "same fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).filter((event) => event.kind === "delta")).toEqual([
      { kind: "delta", turnId, text: "same fragment", seq: 2 },
      { kind: "delta", turnId, text: "same fragment", seq: 3 },
    ]);
    await host.release();
  });

  test("matches buffered delta overlap against the ordered durable suffix", async () => {
    const threadId = "buffered-delta-ordered-overlap";
    const turnId = "buffered-delta-ordered-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "first fragment", seq: 2 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "second fragment", seq: 3 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "second fragment" } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "first fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 3,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).filter((event) => event.kind === "delta")).toEqual([
      { kind: "delta", turnId, text: "first fragment", seq: 2 },
      { kind: "delta", turnId, text: "second fragment", seq: 3 },
      { kind: "delta", turnId, text: "first fragment", seq: 4 },
    ]);
    await host.release();
  });

  test("reactivates a dead durable turn before its buffered resumed delta", async () => {
    const threadId = "buffered-dead-turn-reactivation";
    const turnId = "buffered-resumed-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "session-status", status: "dead", seq: 2 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "resumed fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(2)).toEqual([
      { kind: "turn-started", turnId, seq: 3 },
      { kind: "delta", turnId, text: "resumed fragment", seq: 4 },
      { kind: "session-status", status: "active", activeFlags: ["running"], seq: 5 },
    ]);
    await host.release();
  });

  test("preserves buffered terminal ordering before the next resumed turn", async () => {
    const threadId = "buffered-cross-turn-order";
    const completedTurnId = "buffered-completed-turn";
    const activeTurnId = "buffered-next-turn";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [
      { id: completedTurnId, status: "completed", items: [] },
      { id: activeTurnId, status: "inProgress", items: [] },
    ], { type: "active", activeFlags: ["running"] }, [
      { method: "turn/completed", params: { threadId, turn: { id: completedTurnId, status: "completed" } } },
      { method: "turn/started", params: { threadId, turn: { id: activeTurnId } } },
      { method: "item/agentMessage/delta", params: { threadId, turnId: activeTurnId, delta: "next turn fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId)).toEqual([
      { kind: "turn-started", turnId: completedTurnId, seq: 1 },
      { kind: "turn-ended", turnId: completedTurnId, status: "completed", seq: 2 },
      { kind: "turn-started", turnId: activeTurnId, seq: 3 },
      { kind: "delta", turnId: activeTurnId, text: "next turn fragment", seq: 4 },
      { kind: "session-status", status: "active", activeFlags: ["running"], seq: 5 },
    ]);
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: activeTurnId });
    await host.release();
  });

  /* #1284: one app-server connection carries every thread of a session tree, so
     a native sub-agent's turn streams down the same pipe as its parent's. Left
     unfiltered, the two turn ids alternate in the parent's ledger and the live
     projection opens a fresh item on every switch — the parent's answer rendered
     as a column of mid-sentence fragments. */
  test("keeps a sibling thread's interleaved turn out of the parent's stream", async () => {
    const parentThreadId = "parent-thread-stream";
    const childThreadId = "child-thread-stream";
    const parentTurnId = "turn-parent-stream";
    const childTurnId = "turn-child-stream";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(parentThreadId);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    server.notify("turn/started", { threadId: parentThreadId, turn: { id: parentTurnId } });
    server.notify("item/agentMessage/delta", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      itemId: "parent-item",
      delta: "The parent answer ",
    });
    /* The sub-agent's whole lifecycle, interleaved delta by delta. */
    server.notify("turn/started", { threadId: childThreadId, turn: { id: childTurnId } });
    server.notify("item/agentMessage/delta", {
      threadId: childThreadId,
      turnId: childTurnId,
      itemId: "child-item",
      delta: "VERDICT",
    });
    server.notify("item/agentMessage/delta", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      itemId: "parent-item",
      delta: "stays one ",
    });
    server.notify("item/agentMessage/delta", {
      threadId: childThreadId,
      turnId: childTurnId,
      itemId: "child-item",
      delta: "_HELD",
    });
    server.notify("item/completed", {
      threadId: childThreadId,
      turnId: childTurnId,
      item: { type: "agentMessage", id: "child-item", text: "VERDICT_HELD" },
    });
    server.notify("turn/completed", {
      threadId: childThreadId,
      turn: { id: childTurnId, status: "completed" },
    });
    server.notify("thread/status/changed", { threadId: childThreadId, status: { type: "idle" } });
    server.notify("item/agentMessage/delta", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      itemId: "parent-item",
      delta: "continuous stream.",
    });
    await Bun.sleep(0);

    const events = eventStore.load(parentThreadId);
    expect(events.filter((event) => event.kind !== "session-status")).toEqual([
      { kind: "turn-started", turnId: parentTurnId, seq: 2 },
      { kind: "delta", turnId: parentTurnId, text: "The parent answer ", seq: 3 },
      { kind: "delta", turnId: parentTurnId, text: "stays one ", seq: 4 },
      { kind: "delta", turnId: parentTurnId, text: "continuous stream.", seq: 5 },
    ]);
    /* The parent's own record of the delegation is untouched, and the child's
       turn neither idles the parent's session nor steals its active turn. */
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: parentTurnId });

    const live = events.reduce<RuntimeLiveTurn | null>(
      (turn, event) => event.kind === "delta"
        ? appendRuntimeLiveTurnDelta(turn, event.turnId, event.text)
        : turn,
      null,
    );
    expect(runtimeLiveTurnItems(live).map((item) => item.text))
      .toEqual(["The parent answer stays one continuous stream."]);

    server.notify("item/completed", {
      threadId: parentThreadId,
      turnId: parentTurnId,
      item: {
        type: "collabAgentToolCall",
        id: "collab-1",
        tool: "spawnAgent",
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        status: "completed",
        agentsStates: {},
      },
    });
    await Bun.sleep(0);
    expect(eventStore.load(parentThreadId).findLast((event) => event.kind === "item"))
      .toMatchObject({ turnId: parentTurnId, item: { type: "collabAgentToolCall" } });
    await host.release();
  });

  test("skips a sibling thread's buffered frames when replaying a crash prefix", async () => {
    const threadId = "buffered-sibling-thread";
    const siblingThreadId = "buffered-sibling-child";
    const turnId = "buffered-sibling-turn";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "turn-started", turnId, seq: 1 });
    eventStore.append(threadId, { kind: "delta", turnId, text: "durable fragment", seq: 2 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "inProgress",
      items: [],
    }], { type: "active", activeFlags: ["running"] }, [
      {
        method: "item/agentMessage/delta",
        params: { threadId: siblingThreadId, turnId: "buffered-sibling-child-turn", delta: "sibling fragment" },
      },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "durable fragment" } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "replayed fragment" } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 2,
      spawnProcess: fakeSpawn(server),
    });

    /* The sibling frame is neither replayed nor counted: counting it would put a
       key at the head of the buffered prefix that replay never emits, breaking
       the overlap match and re-emitting the durable fragment as a duplicate. */
    expect(eventStore.load(threadId).filter((event) => event.kind === "delta")).toEqual([
      { kind: "delta", turnId, text: "durable fragment", seq: 2 },
      { kind: "delta", turnId, text: "replayed fragment", seq: 3 },
    ]);
    await host.release();
  });

  test("reuses a buffered approval already present in the durable crash prefix", async () => {
    const threadId = "buffered-attention-overlap";
    const attentionId = "item/commandExecution/requestApproval:buffered-approval";
    const attention = { command: "date" };
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, {
      kind: "attention",
      id: attentionId,
      method: "item/commandExecution/requestApproval",
      attention,
      seq: 1,
    });
    const server = new FakeAppServer(threadId, threadId, false, [], { type: "idle" }, {
      id: "buffered-approval",
      method: "item/commandExecution/requestApproval",
      params: attention,
    });

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).filter((event) => event.kind === "attention")).toEqual([{
      kind: "attention",
      id: attentionId,
      method: "item/commandExecution/requestApproval",
      attention,
      seq: 1,
    }]);
    expect(await host.health()).toMatchObject({ status: "attention", pendingAttention: [attentionId] });
    await host.answer(attentionId, { decision: "accept" });
    await host.release();
  });

  test("orders a buffered terminal-only suffix after reconstructed resume history", async () => {
    const threadId = `${["019f66b5", "8694", "7410", "8671", "fbec75484a86"].join("-")}-terminal-suffix`;
    const turnId = "turn-terminal-suffix-942";
    const item = { type: "agentMessage", id: "item-terminal-suffix-942", text: "resumed response" };
    const eventStore = new MemoryEventStore();
    for (let seq = 1; seq <= 942; seq += 1) {
      eventStore.append(threadId, { kind: "session-status", status: "idle", seq });
    }
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: turnId,
      status: "completed",
      items: [item],
    }], { type: "idle" }, [
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 942,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).slice(942)).toEqual([
      { kind: "turn-started", turnId, seq: 943 },
      { kind: "item", turnId, item, phase: "completed", seq: 944 },
      { kind: "turn-ended", turnId, status: "completed", seq: 945 },
      { kind: "session-status", status: "idle", seq: 946 },
    ]);
    await host.release();
  });

  test("a deferred completed turn cannot clear the newer resumed active turn", async () => {
    const threadId = "deferred-terminal-active-turn";
    const completedTurnId = "turn-completed-before-resume";
    const activeTurnId = "turn-active-after-resume";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId, threadId, false, [
      { id: completedTurnId, status: "completed", items: [] },
      { id: activeTurnId, status: "inProgress", items: [] },
    ], { type: "active", activeFlags: ["running"] }, [
      { method: "turn/completed", params: { threadId, turn: { id: completedTurnId, status: "completed" } } },
    ]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect(eventStore.load(threadId).filter((event) =>
      event.kind === "turn-started" && event.turnId === activeTurnId)).toEqual([
      { kind: "turn-started", turnId: activeTurnId, seq: 3 },
    ]);
    expect(await host.health()).toMatchObject({
      status: "active",
      activeTurnRef: activeTurnId,
      activeFlags: ["running"],
    });
    await host.release();
  });

  test("fails closed before host emission advances beyond the safe-integer cursor range", async () => {
    const threadId = "cursor-near-safe-limit";
    const eventStore = new MemoryEventStore();
    const server = new FakeAppServer(threadId);
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: Number.MAX_SAFE_INTEGER - 1,
      spawnProcess: fakeSpawn(server),
    });
    expect(eventStore.load(threadId)).toEqual([
      { kind: "session-status", status: "idle", seq: Number.MAX_SAFE_INTEGER },
    ]);

    server.notify("account/rateLimits/updated", { credits: "unchanged" });
    await Bun.sleep(0);

    expect(eventStore.load(threadId)).toEqual([
      { kind: "session-status", status: "idle", seq: Number.MAX_SAFE_INTEGER },
    ]);
    expect(await host.health()).toMatchObject({
      status: "dead",
      eventCursor: Number.MAX_SAFE_INTEGER,
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
      if (index === 3) expect(event).toMatchObject({ kind: "session-status", status: "idle", activeFlags: ["recovering"] });
    }
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    expect(server.signals).toEqual([]);
    await host.release();
    expect((await stream.next()).value).toMatchObject({ kind: "session-status", status: "unhosted" });
    expect((await stream.next()).done).toBeTrue();
  });

  test("release awaits TERM and escalates to KILL before resolving", async () => {
    const server = new FakeAppServer("reap-thread", "reap-thread", true);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
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
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") queueMicrotask(() => {
          alive = false;
          server.emit("close", 0, signal);
        });
      },
    });

    await host.release();

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  test("release cleans the detached process group after an unexpected leader exit", async () => {
    const server = new FakeAppServer("exited-group-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") throw new Error("group exited");
      },
    });

    alive = false;
    server.emit("close", 0, null);
    await host.release();
    await Bun.sleep(10);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(server.signals).toEqual([]);
  });

  test("a timed-out release converges after a late child reap and permits cleanup retry", async () => {
    const server = new FakeAppServer("late-reap-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      signalProcess: () => {},
      ...ownedFakeProcess,
    });
    const states: HostState[] = [];
    host.onStateChange((state) => states.push(state));

    await expect(host.release()).rejects.toThrow("Codex app-server child could not be reaped");
    server.emit("close", 0, "SIGKILL");
    await Bun.sleep(0);

    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
    expect(states.at(-1)).toMatchObject({ status: "unhosted", pid: null });
    await expect(host.release()).resolves.toBeUndefined();
  });

  test("release converges when the owned child exits without a close event", async () => {
    const server = new FakeAppServer("missing-close-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity: string | null = "4242:owned";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => processIdentity !== null,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") processIdentity = null;
      },
    });

    await expect(host.release()).resolves.toBeUndefined();

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
    expect(server.signals).toEqual([]);
  });

  test("release cleans the process group when TERM removes the leader without a close event", async () => {
    const server = new FakeAppServer("term-missing-close-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") alive = false;
      },
    });

    await expect(host.release()).resolves.toBeUndefined();
    await Bun.sleep(6);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(server.signals).toEqual([]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
  });

  test("release never signals a recycled child pid", async () => {
    const server = new FakeAppServer("recycled-pid-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity = "4242:owned";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => true,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    });
    processIdentity = "4242:recycled";

    await expect(host.release()).resolves.toBeUndefined();

    expect(signals).toEqual([]);
    expect(server.signals).toEqual([]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
  });

  test("an identity-bound release refuses a different authorized process", async () => {
    const server = new FakeAppServer("identity-bound-release-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });

    expect(await host.releaseIfOwned({ pid: server.pid, startIdentity: "4242:other" })).toBeFalse();
    expect(server.signals).toEqual([]);

    await host.release();
  });

  test("release preserves ownership when the initial identity lookup is unknown", async () => {
    const server = new FakeAppServer("initial-identity-unknown-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => null,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    });

    await expect(host.release()).rejects.toThrow("Codex app-server child ownership is unknown");
    expect(signals).toEqual([]);
    expect(await host.health()).toMatchObject({ pid: 4242, processStartIdentity: null });

    alive = false;
    server.emit("close", 0, null);
    await Bun.sleep(0);
    await expect(host.release()).resolves.toBeUndefined();
  });

  test("release preserves ownership during a transient identity lookup failure", async () => {
    const server = new FakeAppServer("later-identity-unknown-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity: string | null = "4242:owned";
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") queueMicrotask(() => {
          alive = false;
          server.emit("close", 0, signal);
        });
      },
    });
    processIdentity = null;

    await expect(host.release()).rejects.toThrow("Codex app-server child ownership is unknown");
    expect(signals).toEqual([]);
    expect(await host.health()).toMatchObject({ pid: 4242, processStartIdentity: null });

    processIdentity = "4242:owned";
    await expect(host.release()).resolves.toBeUndefined();
    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  test("release retries TERM when a transient identity lookup immediately recovers", async () => {
    const server = new FakeAppServer("immediate-identity-recovery-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let failNextIdentityRead = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => {
        if (!failNextIdentityRead) return "4242:owned";
        failNextIdentityRead = false;
        return null;
      },
      pidAlive: () => true,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });
    failNextIdentityRead = true;

    await expect(host.release()).resolves.toBeUndefined();

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  test("release skips group cleanup after the reaped leader pid is reused", async () => {
    const server = new FakeAppServer("reaped-recycled-pid-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity = "4242:owned";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => true,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") {
          processIdentity = "4242:recycled";
          queueMicrotask(() => server.emit("close", 0, signal));
        }
      },
    });

    await host.release();
    await Bun.sleep(6);

    expect(signals).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null });
  });

  test("protocol failure starts bounded TERM and KILL cleanup", async () => {
    const server = new FakeAppServer("failed-thread", "failed-thread", true);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
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

  test("protocol failure retries TERM when identity recovers after one read", async () => {
    const server = new FakeAppServer("failed-transient-identity-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let failureIdentityReads = 0;
    let injectIdentityFailure = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => {
        if (!injectIdentityFailure) return "4242:owned";
        failureIdentityReads += 1;
        return failureIdentityReads === 2 ? null : "4242:owned";
      },
      pidAlive: () => true,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });
    injectIdentityFailure = true;

    server.stdout.write("malformed\n");
    await Bun.sleep(10);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(await host.health()).toMatchObject({ status: "dead", pid: null });
  });

  test("protocol failure keeps retrying fenced cleanup until identity recovers", async () => {
    const server = new FakeAppServer("failed-delayed-identity-recovery-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity: string | null = "4242:owned";
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") {
          alive = false;
          queueMicrotask(() => server.emit("close", 0, signal));
        }
      },
    });
    processIdentity = null;

    server.stdout.write("malformed\n");
    await Bun.sleep(6);
    expect(signals).toEqual([]);
    expect(await host.health()).toMatchObject({ status: "dead", pid: 4242 });

    processIdentity = "4242:owned";
    await Bun.sleep(12);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(await host.health()).toMatchObject({ status: "dead", pid: null });
  });

  test("an asynchronous stdin EPIPE fails and reaps the host", async () => {
    const server = new FakeAppServer("epipe-thread", "epipe-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 1_000,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
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
      ...ownedFakeProcess,
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

  test("context compaction can outlive the RPC deadline without killing delivery ownership", async () => {
    const server = new FakeAppServer("compaction-delivery-thread");
    server.autoCompleteUserMessage = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });

    const delivery = host.send({ id: "compaction-delivery", text: "continue after compaction" });
    await Bun.sleep(10);
    server.notify("item/started", {
      threadId: "compaction-delivery-thread",
      turnId: "turn-1",
      item: { id: "compaction-one", type: "contextCompaction" },
    });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
    expect(server.signals).toEqual([]);

    const request = server.requests.find((candidate) => candidate.method === "turn/start")!;
    const params = request.params as { input: unknown };
    server.notify("item/completed", {
      threadId: "compaction-delivery-thread",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        clientId: "compaction-delivery",
        content: params.input,
      },
    });

    expect(await delivery).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect(server.signals).toEqual([]);
    await host.release();
  });

  test("accepts a legal item page above the legacy frame guard", async () => {
    const server = new FakeAppServer("large-read-thread");
    server.readTurns = [{
      id: "historical-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "x".repeat(5 * 1024 * 1024) }],
    }];
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "new-delivery", text: "continue" }))
      .toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
    await host.release();
  });

  test("a late timed-out thread/items/list page response stays harmless after retry delivery", async () => {
    const ignoredMethods = ["thread/items/list"];
    const server = new FakeAppServer("late-page-thread", "late-page-thread", false, [], undefined, null, ignoredMethods);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const entry = { id: "late-page-retry", text: "continue" };

    await expect(host.send(entry)).rejects.toThrow("thread/items/list timed out");
    const firstPage = server.requests.findLast((request) => request.method === "thread/items/list")!;
    ignoredMethods.splice(0);

    expect(await host.send(entry)).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    server.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: firstPage.id,
      result: { data: [], nextCursor: null },
    })}\n`);
    await Bun.sleep(0);

    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
    expect(server.signals).not.toContain("SIGTERM");
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
      ...ownedFakeProcess,
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

  test("ledger failure converges without close and releases the writer claim", async () => {
    const store = new FailingEventStore();
    const server = new FakeAppServer("ledger-missing-close-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: store,
      spawnProcess: fakeSpawn(server),
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") alive = false;
      },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-failed-ledger-registry-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "ledger-missing-close-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/ledger-missing-close-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:4242",
        process: { pid: 4242, startIdentity: "4242:owned" },
        eventCursor: 1,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 8,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 8,
      claimOwner: "failed-owner",
      pendingAction: null,
    });
    await bindCodexHostPersistence(registry, key, host, "failed-owner", 8);

    server.notify("account/rateLimits/updated", { rateLimits: {} });
    await Bun.sleep(10);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(await host.health()).toMatchObject({ status: "dead", pid: null });
    expect(registry.snapshot().entries["codex:ledger-missing-close-thread"]).toMatchObject({
      status: "dead",
      claimOwner: null,
      structuredHost: { process: null, endpoint: "stdio:released" },
    });
    fs.rmSync(directory, { recursive: true, force: true });
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
    const joined = (...parts: string[]) => parts.join("");
    const secrets = [
      joined("oauth", "-secret-value"),
      joined("auth", "-secret-value"),
      joined("session", "-secret-value"),
      joined("client", "-secret-value"),
      joined("cookie", "-secret-value"),
      joined("generic", "-secret-value"),
      joined("eyJabcdefghijk", ".abcdefghijk", ".abcdefghijk"),
      joined("sk", "-ant-", "abcdefghijklmnopqrstuvwxyz"),
      joined("gh", "p_", "abcdefghijklmnopqrstuvwxyz1234567890"),
    ];
    const redacted = redactCodexHostDiagnostic([
      `${["oauth", "token"].join("_")}=${secrets[0]}`,
      `${["auth", "token"].join("_")}=${secrets[1]}`,
      `${["session", "token"].join("_")}=${secrets[2]}`,
      `${["client", "secret"].join("_")}=${secrets[3]}`,
      `cookie=${secrets[4]}`,
      `token=${secrets[5]}`,
      secrets[6],
      secrets[7],
      secrets[8],
    ].join(" "));
    for (const secret of secrets) expect(redacted).not.toContain(secret);
  });

  test("reports a bounded redacted stderr diagnostic when the app-server exits during startup", async () => {
    const server = new FakeAppServer(
      "startup-exit-thread",
      "startup-exit-thread",
      false,
      [],
      undefined,
      null,
      ["initialize"],
    );
    const started = CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 100,
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    await Bun.sleep(0);
    server.stderr.write(`${"x".repeat(20 * 1024)}\nYour authentication token has been invalidated oauth_token=must-stay-private\n`);
    server.emit("close", 1, null);

    const failure: unknown = await started.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected Codex startup to fail");
    expect(failure.message).toContain("Codex app-server child exited");
    expect(failure.message).toContain("Your authentication token has been invalidated");
    expect(failure.message).not.toContain("must-stay-private");
    expect(failure.message.length).toBeLessThanOrEqual(500);
  });

  test("keeps structured hosting enabled unless the rollback switch is explicit", async () => {
    expect(structuredHostsEnabled({ NODE_ENV: "test" })).toBeTrue();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "true" })).toBeTrue();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" })).toBeTrue();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "0" })).toBeFalse();
    await expect(startCodexStructuredHost(
      { cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(new FakeAppServer()) },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "0" },
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
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "0" },
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
    expect(eventStore.load("adopted-thread").at(-1)?.seq).toBe(15);
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

  test("boot adoption starts only Codex rows admitted by its candidate filter", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-filtered-structured-adoption-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    for (const sessionId of ["unfinished-thread", "terminal-thread"]) {
      registry.upsert({
        key: { engine: "codex", sessionId },
        artifactPath: `/sessions/${sessionId}.jsonl`,
        cwd: "/repo",
        accountId: null,
        status: "live",
        host: null,
        structuredHost: {
          kind: "codex-app-server",
          endpoint: "stdio:old",
          process: null,
          eventCursor: 2,
          protocolVersion: "0.144.1",
          writerClaimEpoch: 1,
          activeTurnRef: `turn-${sessionId}`,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 1,
        claimOwner: null,
        pendingAction: null,
      });
    }
    const starts: string[] = [];
    const adopted = await adoptCodexRegistryHosts(
      registry,
      (entry) => {
        starts.push(entry.key.sessionId);
        return {
          cwd: "/repo",
          eventStore: new MemoryEventStore(),
          spawnProcess: fakeSpawn(new FakeAppServer(entry.key.sessionId)),
        };
      },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
      (entry) => entry.key.sessionId === "unfinished-thread",
    );

    expect(starts).toEqual(["unfinished-thread"]);
    expect(adopted).toHaveLength(1);
    expect(registry.snapshot().entries["codex:terminal-thread"]).toMatchObject({
      status: "live",
      claimEpoch: 1,
      claimOwner: null,
    });
    await adopted[0]!.host.release();
    fs.rmSync(directory, { recursive: true, force: true });
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

  test("startup adoption retains an unreaped Codex child until late cleanup converges", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-uncertain-codex-adoption-"));
    const scratchDirectory = path.join(directory, "scratch");
    fs.mkdirSync(scratchDirectory);
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = "uncertain-codex-adoption";
    registry.upsert({
      key: { engine: "codex", sessionId },
      artifactPath: `/sessions/${sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:released",
        process: null,
        eventCursor: 9,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 2,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 2,
      claimOwner: null,
      pendingAction: null,
    });
    const server = new FakeAppServer(sessionId, "different-thread");

    const adopted = await adoptCodexRegistryHosts(
      registry,
      () => ({
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        shutdownGraceMs: 2,
        spawnProcess: fakeSpawn(server),
        signalProcess: () => {},
        releaseCleanup: () => fs.rmSync(scratchDirectory, { recursive: true, force: true }),
        ...ownedFakeProcess,
      }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );

    expect(adopted).toEqual([]);
    expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
      status: "idle",
      claimOwner: expect.any(String),
      structuredHost: {
        endpoint: "stdio:4242",
        process: { pid: 4242 },
        writerClaimEpoch: 3,
      },
    });
    expect(fs.existsSync(scratchDirectory)).toBeTrue();

    server.emit("close", 0, "SIGKILL");
    await Bun.sleep(0);
    expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
      status: "dead",
      claimOwner: null,
      structuredHost: { endpoint: "stdio:released", process: null },
    });
    expect(fs.existsSync(scratchDirectory)).toBeFalse();
  });

  test("concurrent startup adoption creates one writer and advances its claim epoch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-claim-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "claimed-thread" };
    const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
    fs.mkdirSync(path.join(directory, "events"), { recursive: true });
    fs.writeFileSync(path.join(directory, "events", "claimed-thread.jsonl"), `${Array.from(
      { length: 2_907 },
      (_, index) => JSON.stringify({ kind: "session-status", status: "idle", seq: index + 1 }),
    ).join("\n")}\n`, { mode: 0o600 });
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
        eventCursor: 2_908,
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
        const server = new FakeAppServer("claimed-thread", "claimed-thread", false, [], { type: "idle" }, {
          id: "concurrent-approval",
          method: "item/commandExecution/requestApproval",
          params: { command: "date" },
        });
        servers.push(server);
        return {
          cwd: "/repo",
          eventStore,
          onEventCursorRecovery: () => {},
          spawnProcess: fakeSpawn(server),
        };
      },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    const [first, second] = await Promise.all([adopt(), adopt()]);
    expect(first.length + second.length).toBe(1);
    expect(servers).toHaveLength(1);
    expect(await adopt()).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(registry.snapshot().entries["codex:claimed-thread"]).toMatchObject({
      claimEpoch: 9,
      structuredHost: {
        writerClaimEpoch: 9,
        eventCursor: 2_909,
        pendingAttention: ["item/commandExecution/requestApproval:concurrent-approval"],
      },
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

test("a refused persona insertion returns a bounded rejected receipt before realtime starts", async () => {
  const server = new FakeAppServer("voice-thread");
  server.injectItemsError = "Invalid request: unknown field `role`";
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });

  const rejected = await host.startRealtimeWebRtc("v=0\r\noffer");
  expect(rejected).toMatchObject({
    sdp: null,
    realtimeSessionId: null,
    personaBootstrap: {
      insertion: "rejected",
      diagnostic: "Codex app-server request failed: Invalid request: unknown field `role`",
    },
  });
  expect(rejected.personaBootstrap.receiptId).toMatch(/^voice_persona_[a-f0-9]{46}$/);
  expect(rejected.personaBootstrap.diagnostic?.length).toBeLessThanOrEqual(500);
  expect(server.requests.find((request) => request.method === "thread/realtime/start")).toBeUndefined();
  expect(host.currentRealtimeSessionId()).toBeNull();
  await host.release();
});

test("replacement hosts reject an unverifiable canonical transcript without reinserting", async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-bootstrap-scan-fault-"));
  const transcriptPath = path.join(isolated, "voice-thread.jsonl");
  const linkedPath = path.join(isolated, "linked-thread.jsonl");
  fs.writeFileSync(transcriptPath, "");
  fs.symlinkSync(transcriptPath, linkedPath);
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const firstServer = new FakeAppServer("voice-thread");
  firstServer.threadPath = linkedPath;
  const firstHost = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(firstServer),
  });
  let replacementHost: CodexAppServerHost | null = null;
  try {
    const first = await firstHost.startRealtimeWebRtc("v=0\r\no=- 404 2 IN IP4 127.0.0.1\r\n");
    expect(first).toMatchObject({
      sdp: null,
      personaBootstrap: { insertion: "rejected", diagnostic: expect.stringContaining("ELOOP") },
    });
    await firstHost.release();

    const replacementServer = new FakeAppServer("voice-thread");
    replacementServer.threadPath = linkedPath;
    replacementHost = await CodexAppServerHost.adopt("voice-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(replacementServer),
    });
    const replacement = await replacementHost.startRealtimeWebRtc("v=0\r\no=- 405 2 IN IP4 127.0.0.1\r\n");
    expect(replacement.personaBootstrap).toEqual(first.personaBootstrap);
    expect(firstServer.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(0);
    expect(replacementServer.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(0);
    expect(fs.readFileSync(transcriptPath, "utf8")).toBe("");
    expect(warnings).toHaveBeenCalledWith(
      "[voice persona bootstrap] canonical scan unavailable; refusing insertion",
      expect.objectContaining({ code: "ELOOP", diagnostic: expect.stringContaining("ELOOP") }),
    );
    expect(warnings).toHaveBeenCalledTimes(2);
  } finally {
    warnings.mockRestore();
    await replacementHost?.release();
    await firstHost.release();
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("an unrecoverable transcript path rejects before persona insertion", async () => {
  const server = new FakeAppServer("voice-thread");
  server.omitThreadPath = true;
  server.omitThreadReadPath = true;
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  try {
    const first = await host.startRealtimeWebRtc("v=0\r\no=- 406 2 IN IP4 127.0.0.1\r\n");
    const repeated = await host.startRealtimeWebRtc("v=0\r\no=- 407 2 IN IP4 127.0.0.1\r\n");
    expect(repeated.personaBootstrap).toEqual(first.personaBootstrap);
    expect(first).toMatchObject({
      sdp: null,
      personaBootstrap: {
        insertion: "rejected",
        diagnostic: "canonical transcript path is unavailable",
      },
    });
    expect(server.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(0);
    expect(server.requests.filter((request) => request.method === "thread/realtime/start")).toHaveLength(0);
  } finally {
    await host.release();
  }
});

test("replacement hosts recover an omitted canonical path and persist one persona row", async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-bootstrap-path-recovery-"));
  const transcriptPath = path.join(isolated, "voice-thread.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const firstServer = new FakeAppServer("voice-thread");
  firstServer.omitThreadPath = true;
  firstServer.threadPath = transcriptPath;
  const firstHost = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(firstServer),
  });
  let replacementHost: CodexAppServerHost | null = null;
  try {
    const first = await firstHost.startRealtimeWebRtc("v=0\r\no=- 408 2 IN IP4 127.0.0.1\r\n");
    await firstHost.release();

    const replacementServer = new FakeAppServer("voice-thread");
    replacementServer.omitThreadPath = true;
    replacementServer.threadPath = transcriptPath;
    replacementHost = await CodexAppServerHost.adopt("voice-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(replacementServer),
    });
    const recovered = await replacementHost.startRealtimeWebRtc("v=0\r\no=- 409 2 IN IP4 127.0.0.1\r\n");
    expect(recovered.personaBootstrap).toEqual(first.personaBootstrap);
    expect(firstServer.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(1);
    expect(replacementServer.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(0);
    expect(fs.readFileSync(transcriptPath, "utf8").split(recovered.personaBootstrap.itemId)).toHaveLength(2);
  } finally {
    await replacementHost?.release();
    await firstHost.release();
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("a persisted persona row recovers an ambiguous insertion failure", async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-bootstrap-ambiguous-"));
  const transcriptPath = path.join(isolated, "voice-thread.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const server = new FakeAppServer("voice-thread");
  server.threadPath = transcriptPath;
  server.holdInjectItems = true;
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  try {
    const pending = host.startRealtimeWebRtc("v=0\r\no=- 909 2 IN IP4 127.0.0.1\r\n");
    void pending.catch(() => undefined);
    for (let attempt = 0; attempt < 100 && server.heldInjectItemIds.length < 1; attempt += 1) {
      await Bun.sleep(1);
    }
    const request = server.requests.find((candidate) => candidate.method === "thread/inject_items");
    const item = (request?.params as { items?: unknown[] } | undefined)?.items?.[0];
    if (!item) throw new Error("persona insertion item missing");
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "response_item", payload: item })}\n`);
    server.completeNextInject("thread/inject_items response was lost");

    expect(await pending).toMatchObject({
      sdp: "v=0\r\nanswer",
      personaBootstrap: { insertion: "accepted" },
    });
    expect(server.requests.filter((candidate) => candidate.method === "thread/realtime/start")).toHaveLength(1);
  } finally {
    await host.release();
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("an uncertain persona insertion timeout fences the writer and recovers on a replacement host", async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-bootstrap-timeout-"));
  const transcriptPath = path.join(isolated, "voice-thread.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const firstServer = new FakeAppServer("voice-thread", "voice-thread", true);
  firstServer.threadPath = transcriptPath;
  firstServer.injectItemsDelayMs = 25;
  const firstHost = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(firstServer),
    realtimePersonaTimeoutMs: 10,
    shutdownGraceMs: 50,
  });
  let replacementHost: CodexAppServerHost | null = null;
  try {
    await expect(firstHost.startRealtimeWebRtc("v=0\r\no=- 910 2 IN IP4 127.0.0.1\r\n"))
      .rejects.toThrow("thread/inject_items timed out; outcome is uncertain");
    await Bun.sleep(40);
    expect((await firstHost.health()).status).toBe("dead");

    const replacementServer = new FakeAppServer("voice-thread");
    replacementServer.threadPath = transcriptPath;
    replacementHost = await CodexAppServerHost.adopt("voice-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(replacementServer),
    });
    const recovered = await replacementHost.startRealtimeWebRtc("v=0\r\no=- 911 2 IN IP4 127.0.0.1\r\n");
    expect(recovered.personaBootstrap.insertion).toBe("accepted");
    expect(replacementServer.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(0);
    expect(fs.readFileSync(transcriptPath, "utf8").split(recovered.personaBootstrap.itemId)).toHaveLength(2);
  } finally {
    await replacementHost?.release();
    await firstHost.release();
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("persona bootstrap completes before the single fenced realtime-start deadline begins", async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-realtime-start-deadline-"));
  const transcriptPath = path.join(isolated, "voice-thread.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const server = new FakeAppServer("voice-thread");
  server.threadPath = transcriptPath;
  server.injectItemsDelayMs = 20;
  server.realtimeStartDelayMs = 20;
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
    realtimePersonaTimeoutMs: 50,
    realtimeStartTimeoutMs: 30,
  });
  try {
    expect(await host.startRealtimeWebRtc("v=0\r\no=- 912 2 IN IP4 127.0.0.1\r\n")).toMatchObject({
      sdp: "v=0\r\nanswer",
      realtimeSessionId: "realtime-1",
      personaBootstrap: { insertion: "accepted" },
    });
    expect(server.requests.filter((request) => request.method === "thread/realtime/start")).toHaveLength(1);
  } finally {
    await Bun.sleep(25);
    if (host.currentRealtimeSessionId()) await host.stopRealtime();
    await host.release();
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("the realtime notification deadline poisons a writer after the start RPC succeeds", async () => {
  const server = new FakeAppServer("voice-thread");
  server.suppressRealtimeStartNotifications = true;
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
    realtimeStartTimeoutMs: 10,
  });
  try {
    await expect(host.startRealtimeWebRtc("v=0\r\no=- 913 2 IN IP4 127.0.0.1\r\n"))
      .rejects.toThrow("thread/realtime/start timed out; outcome is uncertain");
    expect((await host.health()).status).toBe("dead");
    expect(server.requests.filter((request) => request.method === "thread/realtime/start")).toHaveLength(1);
  } finally {
    await host.release();
  }
});

test("a successor start joins the cancelled call's in-flight persona insertion", async () => {
  const server = new FakeAppServer("voice-thread");
  server.holdInjectItems = true;
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  try {
    const cancelled = host.startRealtimeWebRtc("v=0\r\no=- 1001 2 IN IP4 127.0.0.1\r\n");
    void cancelled.catch(() => undefined);
    for (let attempt = 0; attempt < 100 && server.heldInjectItemIds.length < 1; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(server.heldInjectItemIds).toHaveLength(1);
    await host.stopRealtime();

    const successor = host.startRealtimeWebRtc("v=0\r\no=- 1002 2 IN IP4 127.0.0.1\r\n");
    void successor.catch(() => undefined);
    await Bun.sleep(10);
    expect(server.heldInjectItemIds).toHaveLength(1);
    expect(server.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(1);
    server.completeNextInject();

    await expect(cancelled).rejects.toThrow("stopped during startup");
    expect(await successor).toMatchObject({
      sdp: "v=0\r\nanswer",
      personaBootstrap: { insertion: "accepted" },
    });
    expect(server.requests.filter((request) => request.method === "thread/realtime/start")).toHaveLength(1);
  } finally {
    await host.release();
  }
});

test("a cancelled persona insertion failure cannot reject the successor start", async () => {
  const server = new FakeAppServer("voice-thread");
  server.holdInjectItems = true;
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  try {
    const cancelled = host.startRealtimeWebRtc("v=0\r\no=- 707 2 IN IP4 127.0.0.1\r\n");
    void cancelled.catch(() => undefined);
    for (let attempt = 0; attempt < 100 && server.heldInjectItemIds.length < 1; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(server.heldInjectItemIds).toHaveLength(1);
    await host.stopRealtime();

    const successor = host.startRealtimeWebRtc("v=0\r\no=- 808 2 IN IP4 127.0.0.1\r\n");
    void successor.catch(() => undefined);
    await Bun.sleep(10);
    expect(server.heldInjectItemIds).toHaveLength(1);
    server.completeNextInject("cancelled call insertion failed");
    await expect(cancelled).rejects.toThrow("stopped during startup");
    for (let attempt = 0; attempt < 100 && server.heldInjectItemIds.length < 1; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(server.requests.filter((request) => request.method === "thread/inject_items")).toHaveLength(2);
    server.completeNextInject();

    expect(await successor).toMatchObject({
      sdp: "v=0\r\nanswer",
      personaBootstrap: { insertion: "accepted" },
    });
    expect(server.requests.filter((request) => request.method === "thread/realtime/start")).toHaveLength(1);
  } finally {
    await host.release();
  }
});

test("a rejected persona insertion retries the same resolved payload and stable receipt", async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-bootstrap-retry-"));
  const transcriptPath = path.join(isolated, "voice-thread.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const configDirectory = path.join(isolated, "config");
  const overridePath = path.join(configDirectory, "agent-log-viewer", ...VOICE_PERSONA_FILE.split("/"));
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  fs.writeFileSync(overridePath, "Resolved before the rejected insertion.\n");
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configDirectory;

  const server = new FakeAppServer("voice-thread");
  server.threadPath = transcriptPath;
  server.injectItemsError = "temporary insertion refusal";
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  try {
    const rejected = await host.startRealtimeWebRtc(
      "v=0\r\no=- 505 2 IN IP4 127.0.0.1\r\na=ice-ufrag:rejected\r\n",
    );
    expect(rejected.personaBootstrap.insertion).toBe("rejected");

    fs.writeFileSync(overridePath, "A later edit must not change this call.\n");
    server.injectItemsError = null;
    const accepted = await host.startRealtimeWebRtc(
      "v=0\r\no=- 606 2 IN IP4 127.0.0.1\r\na=ice-ufrag:retry\r\n",
    );
    expect(accepted.personaBootstrap.receiptId).toBe(rejected.personaBootstrap.receiptId);
    expect(accepted.personaBootstrap.itemId).toBe(rejected.personaBootstrap.itemId);
    expect(accepted.personaBootstrap.insertion).toBe("accepted");

    const attempts = server.requests.filter((request) => request.method === "thread/inject_items");
    expect(attempts).toHaveLength(2);
    expect((attempts[1]?.params as { items: Array<{ content: Array<{ text: string }> }> }).items[0]?.content[0]?.text)
      .toBe("Resolved before the rejected insertion.");
    expect(fs.readFileSync(transcriptPath, "utf8").split(accepted.personaBootstrap.itemId)).toHaveLength(2);
  } finally {
    await host.release();
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("releasing the host hangs up a live call so the account's slot is freed", async () => {
  /* A realtime session the backend still believes is open holds the account's
     one concurrent slot, and every later call is refused with "You have
     reached your usage limit." — the same sentence an exhausted window
     produces. A deploy replacing the runtime host mid-call is exactly how that
     orphan gets created. */
  const server = new FakeAppServer("voice-thread");
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  await host.startRealtimeWebRtc("v=0\r\noffer");
  await host.release();
  expect(server.requests.some((request) => request.method === "thread/realtime/stop")).toBe(true);
});

test("a host with no live call releases without a stray hangup", async () => {
  const server = new FakeAppServer("voice-thread");
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  await host.release();
  expect(server.requests.some((request) => request.method === "thread/realtime/stop")).toBe(false);
});
