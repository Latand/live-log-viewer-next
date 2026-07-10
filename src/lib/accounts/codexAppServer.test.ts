import { EventEmitter } from "node:events";

import { expect, test } from "bun:test";

import { CodexAppServerClient } from "./codexAppServer";

class FakeChild extends EventEmitter {
  readonly writes: string[] = [];
  readonly stdin = {
    write: (line: string) => {
      this.writes.push(line);
      this.onWrite?.(JSON.parse(line) as Record<string, unknown>);
      return true;
    },
    end: () => undefined,
  };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  killed = 0;
  signals: NodeJS.Signals[] = [];
  onWrite: ((message: Record<string, unknown>) => void) | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed += 1;
    this.signals.push(signal);
    return true;
  }

  output(value: string): void {
    this.emit("stdout", value);
  }

  respond(id: number, result: unknown): void {
    this.output(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  failRequest(id: number, message: string): void {
    this.output(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
  }

  exit(): void {
    this.emit("close", 1, null);
  }
}

class FakeClock {
  private next = 0;
  private readonly timers = new Map<number, () => void>();
  now(): number { return 0; }
  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const id = ++this.next;
    this.timers.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer as unknown as number); }
  runAll(): void { for (const callback of [...this.timers.values()]) callback(); }
}

function requestId(message: Record<string, unknown>): number {
  expect(typeof message.id).toBe("number");
  return message.id as number;
}

function clientWith(handler: (child: FakeChild, message: Record<string, unknown>) => void): { child: FakeChild; start: () => Promise<CodexAppServerClient> } {
  const child = new FakeChild();
  child.onWrite = (message) => handler(child, message);
  return { child, start: () => CodexAppServerClient.start({ home: "/fake/home", spawn: () => child as never }) };
}

test("JSON-RPC initialization frames lines, correlates ids, and sends initialized", async () => {
  const { child, start } = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), { serverInfo: { name: "codex" } });
    if (message.method === "account/read") fake.respond(requestId(message), { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
  });
  const client = await start();
  expect(JSON.parse(child.writes[1]!)).toEqual({ jsonrpc: "2.0", method: "initialized" });
  await expect(client.readAccount()).resolves.toEqual({ account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
  client.close();
  expect(child.killed).toBe(1);
});

test("out-of-order responses stay attached to their request ids", async () => {
  const pending: Record<string, number> = {};
  const { child, start } = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), {});
    if (message.method === "account/read") pending.account = requestId(message);
    if (message.method === "account/rateLimits/read") {
      pending.limits = requestId(message);
      fake.respond(pending.limits, { rateLimits: { primary: { usedPercent: 12, resetsAt: 42 } } });
      fake.respond(pending.account!, { account: null, requiresOpenaiAuth: true });
    }
  });
  const client = await start();
  const account = client.readAccount();
  const limits = client.readRateLimits();
  await expect(account).resolves.toEqual({ account: null, requiresOpenaiAuth: true });
  await expect(limits).resolves.toEqual({ rateLimits: { primary: { usedPercent: 12, resetsAt: 42, windowDurationMins: null }, secondary: null, planType: null } });
  expect(child.writes.map((line) => JSON.parse(line)).find((message) => message.method === "account/rateLimits/read")).toEqual({ jsonrpc: "2.0", id: pending.limits, method: "account/rateLimits/read" });
  client.close();
});

test("device-code login validates official challenge fields and forwards completion notifications safely", async () => {
  const { child, start } = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), {});
    if (message.method === "account/login/start") fake.respond(requestId(message), { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234" });
  });
  const client = await start();
  const seen: string[] = [];
  client.onNotification((notification) => seen.push(notification.method));
  await expect(client.startDeviceLogin()).resolves.toEqual({ loginId: "login-1", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234" });
  child.output('{"jsonrpc":"2.0","method":"account/login/completed","params":{"loginId":"login-1","success":true}}\n');
  expect(seen).toEqual(["account/login/completed"]);
  client.close();
});

test("malformed output and protocol errors reject safely with redacted details", async () => {
  const malformed = clientWith((fake, message) => {
    if (message.method === "initialize") fake.output("not json\n");
  });
  await expect(malformed.start()).rejects.toThrow("protocol error");
  expect(malformed.child.killed).toBe(1);

  const serverFailure = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), {});
    if (message.method === "account/read") fake.failRequest(requestId(message), "access_token=secret-value");
  });
  const client = await serverFailure.start();
  await expect(client.readAccount()).rejects.not.toThrow("secret-value");
  client.close();
});

test("a child exit rejects an in-flight request and reaps the child", async () => {
  const { child, start } = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), {});
  });
  const client = await start();
  const pending = client.readAccount();
  child.exit();
  await expect(pending).rejects.toThrow("exited");
  expect(child.killed).toBe(1);
});

test("fragmented and coalesced JSONL messages preserve request and notification ordering", async () => {
  const { start } = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), {});
    if (message.method === "account/read") {
      const line = JSON.stringify({ jsonrpc: "2.0", id: requestId(message), result: { account: null, requiresOpenaiAuth: true } }) + "\n";
      fake.output(line.slice(0, 17));
      fake.output(line.slice(17) + JSON.stringify({ jsonrpc: "2.0", method: "account/login/completed", params: { loginId: "one", success: true } }) + "\n");
    }
  });
  const client = await start();
  const seen: string[] = [];
  client.onNotification((notification) => seen.push(notification.method));
  await expect(client.readAccount()).resolves.toEqual({ account: null, requiresOpenaiAuth: true });
  expect(seen).toEqual(["account/login/completed"]);
  client.close();
});

test("an ambiguous request timeout closes the transport and ignores later bytes", async () => {
  const clock = new FakeClock();
  const child = new FakeChild();
  child.onWrite = (message) => {
    if (message.method === "initialize") child.respond(requestId(message), {});
  };
  const client = await CodexAppServerClient.start({ home: "/fake/home", spawn: () => child as never, clock, requestTimeoutMs: 1, shutdownGraceMs: 1 });
  const seen: string[] = [];
  client.onNotification((notification) => seen.push(notification.method));
  const pending = client.readAccount();
  clock.runAll();
  await expect(pending).rejects.toThrow("timed out");
  expect(child.signals).toContain("SIGTERM");
  child.respond(2, { account: { type: "chatgpt" }, requiresOpenaiAuth: false });
  child.output('{"jsonrpc":"2.0","method":"account/login/completed","params":{"loginId":"late","success":true}}\n');
  expect(seen).toEqual([]);
});

test("oversized unterminated JSONL fails with a bounded buffer", async () => {
  const { child, start } = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), {});
  });
  const client = await start();
  const pending = client.readAccount();
  child.output("x".repeat(1024 * 1024 + 1));
  await expect(pending).rejects.toThrow("oversized unterminated JSONL line");
  expect(child.signals).toContain("SIGTERM");
});

test("SIGTERM acknowledgement and escalation both end in a reaped child", async () => {
  const acknowledged = clientWith((fake, message) => {
    if (message.method === "initialize") fake.respond(requestId(message), {});
  });
  const client = await acknowledged.start();
  const acknowledgedReaped: string[] = [];
  client.onLifecycle((event) => { if (event.type === "reaped") acknowledgedReaped.push(event.type); });
  client.close();
  expect(acknowledged.child.signals).toEqual(["SIGTERM"]);
  acknowledged.child.emit("close", 0, "SIGTERM");
  expect(acknowledgedReaped).toEqual(["reaped"]);

  const clock = new FakeClock();
  const unacknowledged = new FakeChild();
  unacknowledged.onWrite = (message) => { if (message.method === "initialize") unacknowledged.respond(requestId(message), {}); };
  const reaped: string[] = [];
  const escalating = await CodexAppServerClient.start({ home: "/fake/home", spawn: () => unacknowledged as never, clock, shutdownGraceMs: 1 });
  escalating.onLifecycle((event) => { if (event.type === "reaped") reaped.push(event.type); });
  escalating.close();
  clock.runAll();
  expect(unacknowledged.signals).toEqual(["SIGTERM", "SIGKILL"]);
  unacknowledged.emit("close", null, "SIGKILL");
  expect(reaped).toEqual(["reaped"]);
});
