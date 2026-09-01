import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* Issue #1373: the reset-credit route against a scripted app-server child.
   Every account here is invented; no credit is ever spent outside the fake. */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reset-credits-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");

const { GET, POST } = await import("./route");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { CodexAppServerClient } = await import("@/lib/accounts/codexAppServer");
const { ManagedCodexRuntime, setManagedCodexRuntimeForTests } = await import("@/lib/accounts/codexRuntime");
const { readResetCreditJournal } = await import("@/lib/accounts/resetCreditJournal");
const { agentRegistry } = await import("@/lib/agent/registry");

const NOW_S = Math.floor(Date.now() / 1000);
const OLD_WINDOW_RESET = NOW_S + 5 * 86_400;
const NEW_WINDOW_RESET = NOW_S + 7 * 86_400;

type Read = { usedPercent: number; resetsAt: number; available: number | null };
type Script = { reads: Read[]; consume: string | { error: string } };

class FakeChild extends EventEmitter {
  readonly methods: Array<{ method: string; params: unknown }> = [];
  private readIndex = 0;
  readonly stdin = { write: (line: string) => { this.onWrite(JSON.parse(line) as Record<string, unknown>); return true; }, end: () => undefined };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  constructor(private readonly script: Script) { super(); }
  kill(): boolean { return true; }
  onWrite(message: Record<string, unknown>): void {
    if (typeof message.method === "string") this.methods.push({ method: message.method, params: message.params });
    const id = message.id as number;
    if (message.method === "initialize") this.respond(id, {});
    if (message.method === "account/read") this.respond(id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    if (message.method === "account/rateLimits/read") {
      const step = this.script.reads[Math.min(this.readIndex, this.script.reads.length - 1)]!;
      this.readIndex += 1;
      this.respond(id, {
        rateLimits: { primary: { usedPercent: step.usedPercent, windowDurationMins: 10_080, resetsAt: step.resetsAt }, secondary: null, planType: "pro" },
        ...(step.available === null ? {} : {
          rateLimitResetCredits: {
            availableCount: step.available,
            credits: step.available > 0
              ? [{ id: "credit-a", resetType: "codexRateLimits", status: "available", grantedAt: NOW_S - 86_400, expiresAt: NOW_S + 20 * 86_400, title: "Full reset", description: null }]
              : [],
          },
        }),
      });
    }
    if (message.method === "account/rateLimitResetCredit/consume") {
      if (typeof this.script.consume === "string") this.respond(id, { outcome: this.script.consume });
      else this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: this.script.consume.error } }) + "\n");
    }
  }
  respond(id: number, result: unknown): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
}

function installRuntime(script: Script): FakeChild[] {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({ startClient: async (home) => {
    const child = new FakeChild(script);
    children.push(child);
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } }));
  return children;
}

function account(label: string) {
  const created = createManagedCodexAccount(label);
  fs.writeFileSync(path.join(created.home, "auth.json"), "{}", { mode: 0o600 });
  return created;
}

function post(body: unknown, headers: HeadersInit = { host: "127.0.0.1", "content-type": "application/json" }): NextRequest {
  return new NextRequest("http://127.0.0.1/api/accounts/codex/reset-credits", { method: "POST", headers, body: JSON.stringify(body) });
}

function get(query = ""): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/accounts/codex/reset-credits${query}`, { method: "GET", headers: { host: "127.0.0.1" } });
}

afterAll(() => {
  setManagedCodexRuntimeForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("redeeming a reset credit consumes exactly one, re-reads the limits, records the reading and journals the attempt", async () => {
  const created = account("Account A");
  const children = installRuntime({
    reads: [
      { usedPercent: 100, resetsAt: OLD_WINDOW_RESET, available: 1 },
      { usedPercent: 0, resetsAt: NEW_WINDOW_RESET, available: 0 },
    ],
    consume: "reset",
  });
  const startedAt = Date.now();
  const response = await POST(post({ id: created.id, idempotencyKey: "attempt-one" }));
  expect(response.status).toBe(200);
  const body = await response.json() as {
    outcome: string; redeemed: boolean; recorded: boolean;
    account: { id: string; limits: { state: string; weekly: { usedPercent: number; resetsAt: number }; checkedAt: string }; resetCredits: { availableCount: number; expiresAt: number | null } };
  };
  expect(body.outcome).toBe("reset");
  expect(body.redeemed).toBeTrue();
  expect(body.recorded).toBeTrue();
  // The card gets the new window immediately: the later reset, zero used.
  expect(body.account.id).toBe(created.id);
  expect(body.account.limits.state).toBe("fresh");
  expect(body.account.limits.weekly).toMatchObject({ usedPercent: 0, resetsAt: NEW_WINDOW_RESET });
  expect(Date.parse(body.account.limits.checkedAt)).toBeGreaterThanOrEqual(startedAt);
  expect(body.account.resetCredits).toEqual({ availableCount: 0, expiresAt: null });
  expect(JSON.stringify(body)).not.toContain("credit-a");

  // Exactly one consume, with the caller's key, between the two reads.
  expect(children).toHaveLength(1);
  const methods = children[0]!.methods.map((call) => call.method);
  expect(methods.filter((method) => method === "account/rateLimitResetCredit/consume")).toHaveLength(1);
  expect(methods.indexOf("account/rateLimits/read")).toBeLessThan(methods.indexOf("account/rateLimitResetCredit/consume"));
  expect(methods.lastIndexOf("account/rateLimits/read")).toBeGreaterThan(methods.indexOf("account/rateLimitResetCredit/consume"));
  expect(children[0]!.methods.find((call) => call.method === "account/rateLimitResetCredit/consume")?.params).toEqual({ idempotencyKey: "attempt-one" });

  // Durable: the registry observation every spawn gate reads carries the new window.
  const observation = agentRegistry().readOnlySnapshot().quotaObservations.codex[created.id]!;
  expect(observation.limits?.weekly).toMatchObject({ usedPercent: 0, resetsAt: NEW_WINDOW_RESET });
  expect(observation.provenance.source).toBe("live");
  expect(observation.resetCredits).toEqual({ availableCount: 0, expiresAt: null });

  // Attributed: who, when, which account, what the backend answered.
  const entry = readResetCreditJournal().find((item) => item.accountId === created.id)!;
  expect(entry).toMatchObject({
    engine: "codex",
    actor: { kind: "operator" },
    idempotencyKey: "attempt-one",
    outcome: "reset",
    refusedLocally: false,
    before: { availableCount: 1, window: { usedPercent: 100, resetsAt: OLD_WINDOW_RESET } },
    after: { availableCount: 0, window: { usedPercent: 0, resetsAt: NEW_WINDOW_RESET } },
    detail: null,
  });
  expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(startedAt);
});

test("an account known to hold no credit is refused locally: nothing is sent, and the refusal is journaled", async () => {
  const created = account("Account B");
  const children = installRuntime({ reads: [{ usedPercent: 100, resetsAt: OLD_WINDOW_RESET, available: 0 }], consume: "reset" });
  const response = await POST(post({ id: created.id }));
  expect(response.status).toBe(409);
  const body = await response.json() as { code: string; outcome: string; refusedLocally: boolean; account: { resetCredits: { availableCount: number; expiresAt: number | null } } };
  expect(body.code).toBe("no_resets_available");
  expect(body.outcome).toBe("noCredit");
  expect(body.refusedLocally).toBeTrue();
  expect(body.account.resetCredits).toEqual({ availableCount: 0, expiresAt: null });
  expect(children[0]!.methods.map((call) => call.method)).not.toContain("account/rateLimitResetCredit/consume");
  const entry = readResetCreditJournal().find((item) => item.accountId === created.id)!;
  expect(entry).toMatchObject({ outcome: "noCredit", refusedLocally: true, before: { availableCount: 0 } });
  expect(typeof entry.idempotencyKey).toBe("string");
});

test("when the count is unknown the backend decides, and its noCredit or nothingToReset answer is a 409 that still returns the reading", async () => {
  const noCredit = account("Account C");
  installRuntime({ reads: [{ usedPercent: 100, resetsAt: OLD_WINDOW_RESET, available: null }], consume: "noCredit" });
  const refused = await POST(post({ id: noCredit.id, idempotencyKey: "attempt-c" }));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "no_resets_available", outcome: "noCredit", refusedLocally: false, account: { id: noCredit.id, resetCredits: null } });

  const nothing = account("Account D");
  installRuntime({ reads: [{ usedPercent: 20, resetsAt: OLD_WINDOW_RESET, available: 1 }], consume: "nothingToReset" });
  const idle = await POST(post({ id: nothing.id, idempotencyKey: "attempt-d" }));
  expect(idle.status).toBe(409);
  expect(await idle.json()).toMatchObject({ code: "nothing_to_reset", outcome: "nothingToReset", account: { id: nothing.id, limits: { weekly: { usedPercent: 20 } } } });
  expect(readResetCreditJournal().find((item) => item.accountId === nothing.id)).toMatchObject({ outcome: "nothingToReset", before: { availableCount: 1 } });
});

test("an app-server failure is a 502 with redacted detail, journaled as consume_failed", async () => {
  const created = account("Account E");
  installRuntime({ reads: [{ usedPercent: 100, resetsAt: OLD_WINDOW_RESET, available: 1 }], consume: { error: "backend refused bearer not-a-real-token-value" } });
  const response = await POST(post({ id: created.id, idempotencyKey: "attempt-e" }));
  expect(response.status).toBe(502);
  const body = await response.json() as { code: string; detail: string; recorded: boolean };
  expect(body.code).toBe("consume_failed");
  expect(body.detail).toContain("backend refused");
  expect(body.detail).not.toContain("not-a-real-token-value");
  expect(body.recorded).toBeTrue();
  expect(readResetCreditJournal().find((item) => item.accountId === created.id)).toMatchObject({ outcome: "consume_failed", idempotencyKey: "attempt-e", after: null });
});

test("the route rejects cross-origin callers, unknown accounts and malformed keys before touching any account", async () => {
  const children = installRuntime({ reads: [{ usedPercent: 100, resetsAt: OLD_WINDOW_RESET, available: 1 }], consume: "reset" });
  expect((await POST(post({ id: "default" }, { host: "127.0.0.1", origin: "https://evil.example", "content-type": "application/json" }))).status).toBe(403);
  expect((await POST(post({ id: "nobody-here" }))).status).toBe(404);
  expect((await POST(post({ id: "default", idempotencyKey: "has spaces" }))).status).toBe(400);
  expect((await POST(post({}))).status).toBe(400);
  expect(children).toHaveLength(0);
});

test("GET lists each account's reset-credit availability from the durable observation plus the redemption record", async () => {
  const response = await GET(get());
  expect(response.status).toBe(200);
  const body = await response.json() as { accounts: { id: string; resetCredits: unknown; checkedAt: string | null }[]; redemptions: { accountId: string; outcome: string }[] };
  const ids = body.accounts.map((row) => row.id);
  expect(ids).toContain("default");
  const redeemed = body.accounts.find((row) => row.id === "account-a")!;
  expect(redeemed.resetCredits).toEqual({ availableCount: 0, expiresAt: null });
  expect(redeemed.checkedAt).not.toBeNull();
  expect(body.accounts.find((row) => row.id === "default")?.resetCredits).toBeNull();
  expect(body.redemptions.some((entry) => entry.accountId === "account-a" && entry.outcome === "reset")).toBeTrue();
  const one = await (await GET(get("?id=account-b"))).json() as { accounts: { id: string }[]; redemptions: { accountId: string }[] };
  expect(one.accounts.map((row) => row.id)).toEqual(["account-b"]);
  expect(one.redemptions.every((entry) => entry.accountId === "account-b")).toBeTrue();
  expect((await GET(get("?id=nobody-here"))).status).toBe(404);
});
