import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeEvent } from "./engineHost";
import type { RuntimeEventStore } from "./eventStore";

/**
 * Per-thread Computer Use grant (issue #687). Codex resolves plugins from the
 * operator's global configuration, so these cases pin what the Viewer controls:
 * which thread asks for the plugin subsystem, which desktop-session variables
 * reach the host process, and what happens when the realized tool surface is
 * wider than the grant.
 */

class MemoryEventStore implements RuntimeEventStore {
  private readonly events: RuntimeEvent[] = [];
  load(): RuntimeEvent[] { return structuredClone(this.events); }
  append(_threadId: string, event: RuntimeEvent): void { this.events.push(structuredClone(event)); }
}

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5151;
  readonly requests: Array<Record<string, unknown>> = [];
  /** MCP servers the thread gains from plugins on top of its own table. */
  pluginServers: string[] = [];
  statusError: string | null = null;

  constructor(private readonly threadId = "thread-687") {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.emit("close", signal === "SIGKILL" ? null : 0, signal));
    return true;
  }

  private accept(message: Record<string, unknown>): void {
    this.requests.push(message);
    if (typeof message.id !== "number") return;
    const method = message.method;
    if (method === "initialize") return this.respond(message.id, { userAgent: "codex_desktop_app/0.145.0 (Linux)" });
    if (method === "account/read") return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" } });
    if (method === "model/list") return this.respond(message.id, { data: [{ id: "gpt-5.3-codex-spark", isDefault: true }] });
    if (method === "config/read") return this.respond(message.id, {
      config: {
        mcp_servers: { viewer: { command: "agent-log-viewer-mcp" }, playwright: { command: "npx" } },
        plugins: { "computer-use@openai-bundled": { enabled: true }, "browser@openai-bundled": { enabled: true } },
      },
    });
    if (method === "thread/start" || method === "thread/resume") {
      return this.respond(message.id, { thread: { id: this.threadId, path: `/sessions/${this.threadId}.jsonl` } });
    }
    if (method === "mcpServerStatus/list") {
      if (this.statusError) return this.respondError(message.id, this.statusError);
      return this.respond(message.id, {
        data: ["viewer", "playwright", ...this.pluginServers].map((name) => ({ name, tools: {} })),
      });
    }
  }

  private respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private respondError(id: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);
  }
}

function fakeSpawn(server: FakeAppServer, captured?: { options?: SpawnOptionsWithoutStdio }) {
  return (_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    if (captured) captured.options = options;
    return server as unknown as ChildProcessWithoutNullStreams;
  };
}

const DESKTOP_ENV: NodeJS.ProcessEnv & Record<string, string | undefined> = {
  NODE_ENV: "test",
  DISPLAY: ":0",
  XAUTHORITY: "/tmp/xauth-test",
  WAYLAND_DISPLAY: "wayland-9",
  XDG_SESSION_TYPE: "wayland",
  XDG_CURRENT_DESKTOP: "GNOME",
  DESKTOP_SESSION: "gnome",
  XDG_RUNTIME_DIR: "/tmp/runtime-test",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/runtime-test/bus",
  SECRET_TOKEN: "must-not-leak",
  PATH: process.env.PATH,
};

test("a granted thread turns the plugin subsystem on for itself and allowlists computer use only", async () => {
  const server = new FakeAppServer();
  server.pluginServers = ["computer-use"];
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    plugins: ["computer-use"],
    env: DESKTOP_ENV,
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  const config = (server.requests.find((request) => request.method === "thread/start")
    ?.params as { config: { features: Record<string, unknown>; plugins: Record<string, { enabled: boolean }> } }).config;
  expect(config.features).toMatchObject({ plugins: true, apps: false, multi_agent: false });
  expect(config.plugins).toEqual({
    "computer-use@openai-bundled": { enabled: true },
    "browser@openai-bundled": { enabled: false },
  });
  await host.release();
});

test("a session without a grant leaves the plugin subsystem off", async () => {
  const server = new FakeAppServer();
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    env: DESKTOP_ENV,
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  });
  const config = (server.requests.find((request) => request.method === "thread/start")
    ?.params as { config: Record<string, unknown> }).config;
  expect(config.features).toMatchObject({ plugins: false });
  expect(config).not.toHaveProperty("plugins");
  /* No grant, no desktop reach: the verification RPC is not even asked for. */
  expect(server.requests.some((request) => request.method === "mcpServerStatus/list")).toBe(false);
  await host.release();
});

test("only a granted host receives the desktop session environment", async () => {
  const granted = { options: undefined as SpawnOptionsWithoutStdio | undefined };
  const denied = { options: undefined as SpawnOptionsWithoutStdio | undefined };
  const grantedServer = new FakeAppServer();
  grantedServer.pluginServers = ["computer-use"];
  const grantedHost = await CodexAppServerHost.start({
    cwd: "/repo",
    plugins: ["computer-use"],
    env: DESKTOP_ENV,
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(grantedServer, granted),
  });
  const deniedHost = await CodexAppServerHost.start({
    cwd: "/repo",
    env: DESKTOP_ENV,
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(new FakeAppServer(), denied),
  });
  const grantedEnv: Record<string, string | undefined> = { ...granted.options?.env };
  const deniedEnv: Record<string, string | undefined> = { ...denied.options?.env };
  for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION"]) {
    expect(grantedEnv[name]).toBe(DESKTOP_ENV[name]!);
    expect(deniedEnv).not.toHaveProperty(name);
  }
  /* Session bus and runtime dir every host already needs; the grant does not
     open the environment any further than the enumerated desktop variables. */
  expect(deniedEnv.XDG_RUNTIME_DIR).toBe(DESKTOP_ENV.XDG_RUNTIME_DIR);
  expect(grantedEnv.DBUS_SESSION_BUS_ADDRESS).toBe(DESKTOP_ENV.DBUS_SESSION_BUS_ADDRESS);
  expect(grantedEnv).not.toHaveProperty("SECRET_TOKEN");
  await grantedHost.release();
  await deniedHost.release();
});

test("a granted thread that surfaces another plugin's server never opens", async () => {
  const server = new FakeAppServer();
  server.pluginServers = ["computer-use", "browser"];
  await expect(CodexAppServerHost.start({
    cwd: "/repo",
    plugins: ["computer-use"],
    env: DESKTOP_ENV,
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  })).rejects.toThrow("Codex plugin grant surfaced servers outside the allowlist: browser");
});

test("a grant that cannot be verified is not granted", async () => {
  const server = new FakeAppServer();
  server.statusError = "mcpServerStatus/list is unavailable";
  await expect(CodexAppServerHost.start({
    cwd: "/repo",
    plugins: ["computer-use"],
    env: DESKTOP_ENV,
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server),
  })).rejects.toThrow("Codex plugin grant could not be verified");
});

test("a stored profile naming an ungrantable plugin gets no grant at all", async () => {
  const server = new FakeAppServer();
  const captured = { options: undefined as SpawnOptionsWithoutStdio | undefined };
  const host = await CodexAppServerHost.start({
    cwd: "/repo",
    plugins: ["browser", "*"],
    env: DESKTOP_ENV,
    eventStore: new MemoryEventStore(),
    spawnProcess: fakeSpawn(server, captured),
  });
  const config = (server.requests.find((request) => request.method === "thread/start")
    ?.params as { config: Record<string, unknown> }).config;
  expect(config.features).toMatchObject({ plugins: false });
  expect(config).not.toHaveProperty("plugins");
  expect(captured.options?.env).not.toHaveProperty("WAYLAND_DISPLAY");
  await host.release();
});
