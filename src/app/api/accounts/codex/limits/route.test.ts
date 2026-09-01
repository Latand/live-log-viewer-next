import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* Issue #1418: the per-account live re-read, for Codex end to end against a
   scripted app-server child and for Claude through the shared handler with a
   fake probe (the real one shells out to the Claude CLI). */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-limits-refresh-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
const OLD_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const { POST } = await import("./route");
const { handleLimitsRefresh } = await import("../../limitsRefresh");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { createManagedClaudeAccount, listClaudeAccounts } = await import("@/lib/accounts/claude");
const { CodexAppServerClient } = await import("@/lib/accounts/codexAppServer");
const { ManagedCodexRuntime, setManagedCodexRuntimeForTests } = await import("@/lib/accounts/codexRuntime");
const { agentRegistry } = await import("@/lib/agent/registry");
type QuotaProbePort = import("@/lib/accounts/migration/quotaController").QuotaProbePort;

const NOW_S = Math.floor(Date.now() / 1000);

class FakeChild extends EventEmitter {
  readonly methods: string[] = [];
  usedPercent = 37;
  fail = false;
  readonly stdin = { write: (line: string) => { this.onWrite(JSON.parse(line) as Record<string, unknown>); return true; }, end: () => undefined };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  kill(): boolean { return true; }
  onWrite(message: Record<string, unknown>): void {
    if (typeof message.method === "string") this.methods.push(message.method);
    const id = message.id as number;
    if (message.method === "initialize") this.respond(id, {});
    if (message.method === "account/read") {
      if (this.fail) this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "offline" } }) + "\n");
      else this.respond(id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    }
    if (message.method === "account/rateLimits/read") {
      this.respond(id, {
        rateLimits: { primary: { usedPercent: this.usedPercent, windowDurationMins: 10_080, resetsAt: NOW_S + 6 * 86_400 }, secondary: null, planType: "pro" },
        rateLimitResetCredits: { availableCount: 1, credits: null },
      });
    }
  }
  respond(id: number, result: unknown): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
}

function installRuntime(configure: (child: FakeChild) => void = () => {}): FakeChild[] {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({ startClient: async (home) => {
    const child = new FakeChild();
    configure(child);
    children.push(child);
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } }));
  return children;
}

function request(engine: "codex" | "claude", body: unknown, headers: HeadersInit = { host: "127.0.0.1", "content-type": "application/json" }): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/accounts/${engine}/limits`, { method: "POST", headers, body: JSON.stringify(body) });
}

afterAll(() => {
  setManagedCodexRuntimeForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  if (OLD_CLAUDE_HOME === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = OLD_CLAUDE_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a Codex re-read replaces a stale observation with the live one: the timestamp advances and the provider's changed value shows", async () => {
  const created = createManagedCodexAccount("Account A");
  fs.writeFileSync(path.join(created.home, "auth.json"), "{}", { mode: 0o600 });
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  agentRegistry().recordQuotaEvaluation({
    engine: "codex",
    observations: [{
      engine: "codex", accountId: created.id, authenticated: true, authCheckedAt: staleAt,
      limits: { session: null, weekly: { usedPercent: 100, resetsAt: NOW_S + 86_400, windowMinutes: 10_080 }, plan: "pro", capturedAt: NOW_S - 600 },
      provenance: { source: "live", reason: null, staleSince: null }, observedAt: staleAt, bootId: "route-test",
    }],
    signature: null, bootId: "route-test", now: staleAt, minimumGapMs: 60_000,
  });
  const children = installRuntime();
  const startedAt = Date.now();
  const response = await POST(request("codex", { id: created.id }));
  expect(response.status).toBe(200);
  const body = await response.json() as { account: { id: string; auth: { state: string; plan: string }; limits: { state: string; weekly: { usedPercent: number }; checkedAt: string }; resetCredits: { availableCount: number; expiresAt: number | null } } };
  expect(body.account.id).toBe(created.id);
  expect(body.account.auth).toMatchObject({ state: "authenticated", plan: "pro" });
  expect(body.account.limits.state).toBe("fresh");
  expect(body.account.limits.weekly.usedPercent).toBe(37);
  expect(Date.parse(body.account.limits.checkedAt)).toBeGreaterThanOrEqual(startedAt);
  expect(body.account.resetCredits).toEqual({ availableCount: 1, expiresAt: null });
  // Read-only against the account: no login and no consume travelled.
  expect(children[0]!.methods).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  const observation = agentRegistry().readOnlySnapshot().quotaObservations.codex[created.id]!;
  expect(observation.limits?.weekly).toMatchObject({ usedPercent: 37 });
  expect(Date.parse(observation.observedAt)).toBeGreaterThanOrEqual(startedAt);
  expect(observation.resetCredits).toEqual({ availableCount: 1, expiresAt: null });
});

test("a failed live read is a 502 and leaves the last observation untouched", async () => {
  const created = createManagedCodexAccount("Account B");
  fs.writeFileSync(path.join(created.home, "auth.json"), "{}", { mode: 0o600 });
  installRuntime((child) => { child.fail = true; });
  const response = await POST(request("codex", { id: created.id }));
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ code: "probe_failed" });
  expect(agentRegistry().readOnlySnapshot().quotaObservations.codex[created.id]).toBeUndefined();
});

test("a Claude re-read goes through the same probe port and records the flagship weekly with the rest", async () => {
  const created = createManagedClaudeAccount("Account C");
  fs.writeFileSync(path.join(created.home, ".credentials.json"), "{}", { mode: 0o600 });
  const now = Date.now();
  const probe: QuotaProbePort = {
    list: (engine) => (engine === "claude" ? listClaudeAccounts() : []),
    active: () => created.id,
    async probe(engine, account, at) {
      return {
        engine, accountId: account.id, authenticated: true, authCheckedAt: at,
        limits: {
          session: { usedPercent: 12, resetsAt: NOW_S + 3_600, windowMinutes: 300 },
          weekly: { usedPercent: 40, resetsAt: NOW_S + 4 * 86_400, windowMinutes: 10_080 },
          flagship: { usedPercent: 63, resetsAt: NOW_S + 4 * 86_400, windowMinutes: 10_080, tier: "opus" },
          plan: "max", capturedAt: null,
        },
        provenance: { source: "live", reason: null, staleSince: null }, observedAt: at,
      };
    },
  };
  const response = await handleLimitsRefresh("claude", request("claude", { id: created.id }), { probe, now });
  expect(response.status).toBe(200);
  const body = await response.json() as { account: { limits: { checkedAt: string; flagship: { tier: string; usedPercent: number } }; effective: { window: string; percent: number } } };
  expect(body.account.limits.checkedAt).toBe(new Date(now).toISOString());
  expect(body.account.limits.flagship).toMatchObject({ tier: "opus", usedPercent: 63 });
  expect(body.account.effective).toMatchObject({ window: "flagship", percent: 37 });
  expect(agentRegistry().readOnlySnapshot().quotaObservations.claude[created.id]?.limits?.flagship).toMatchObject({ tier: "opus" });
});

test("the refresh route rejects cross-origin callers, unknown accounts and bodies without an id", async () => {
  const children = installRuntime();
  expect((await POST(request("codex", { id: "default" }, { host: "127.0.0.1", origin: "https://evil.example", "content-type": "application/json" }))).status).toBe(403);
  expect((await POST(request("codex", { id: "nobody-here" }))).status).toBe(404);
  expect((await POST(request("codex", {}))).status).toBe(400);
  expect(children).toHaveLength(0);
});
