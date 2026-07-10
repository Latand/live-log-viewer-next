import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-app-server-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");

const { POST } = await import("./route");
const { CodexAppServerClient } = await import("@/lib/accounts/codexAppServer");
const { ManagedCodexRuntime, setManagedCodexRuntimeForTests } = await import("@/lib/accounts/codexRuntime");

class FakeChild extends EventEmitter {
  readonly stdin = { write: (line: string) => { this.onWrite(JSON.parse(line) as Record<string, unknown>); return true; }, end: () => undefined };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  kills = 0;
  kill(): boolean { this.kills += 1; return true; }
  onWrite(message: Record<string, unknown>): void {
    const id = message.id as number;
    if (message.method === "initialize") this.respond(id, {});
    if (message.method === "account/login/start") this.respond(id, { type: "chatgptDeviceCode", loginId: "test-login", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234" });
    if (message.method === "account/login/cancel") this.respond(id, { status: "canceled" });
  }
  respond(id: number, result: unknown): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
}

afterAll(() => {
  setManagedCodexRuntimeForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("existing managed accounts expose retry and cancel without tmux", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild(); children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ label: "Retry me" }),
  }));
  const { account } = await created.json() as { account: { id: string } };
  const retried = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "retry", id: account.id }),
  }));
  expect(retried.status).toBe(200);
  const cancelled = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", id: account.id }),
  }));
  await expect(cancelled.json()).resolves.toEqual({ account: { id: account.id }, cancelled: true });
  expect(children.every((child) => child.kills > 0)).toBe(true);
});

test("managed account creation returns an app-server challenge without the tmux compatibility adapter", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild();
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const response = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Work" }),
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({
    account: expect.objectContaining({ id: "work", loginPending: true }),
    deviceAuth: { url: "https://auth.openai.com/device", code: "ABCD-1234" },
    target: "https://auth.openai.com/device",
  }));
  expect(children).toHaveLength(1);
  const source = fs.readFileSync(path.join(import.meta.dir, "route.ts"), "utf8");
  expect(source).not.toContain("@/lib/tmux");
  expect(source).not.toContain("spawnCommandWindow");
});
