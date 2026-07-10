import { expect, test } from "bun:test";

import { createEngineAccountsStore } from "./useEngineAccounts";

const advance = async () => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
};

type Call = { url: string; method: string; body: unknown };

/** A fetcher that records every request and replies from a per-URL script. */
function scripted(reply: (url: string, body: unknown) => unknown) {
  const calls: Call[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const value = reply(url, body);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  };
  return { calls, fetcher };
}

const claudePayload = (over: Record<string, unknown> = {}) => ({
  claude: {
    active: "main",
    accounts: [
      { id: "main", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, effective: { percent: 12, window: "session", freshness: "fresh" } },
      { id: "work", label: "Work", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null },
    ],
    ...over,
  },
});

test("a claude store reads body.claude, its engine endpoints, and parses migration + autoBalance", async () => {
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") {
      return claudePayload({
        migration: { intentId: "i1", targetId: "work", targetLabel: "Work", state: "draining", origin: "auto", counts: { done: 1, total: 3, waitingTurn: 1, inFlight: 1, failed: 0 } },
        autoBalance: { enabled: true, state: "draining", thresholdPercent: 25 },
      });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  expect(calls[0].url).toBe("/api/accounts");
  expect(store.active).toBe("main");
  expect(store.accounts[0]?.effective).toEqual({ percent: 12, window: "session", freshness: "fresh" });
  expect(store.migration).toMatchObject({ intentId: "i1", origin: "auto", state: "draining", counts: { done: 1, total: 3 } });
  expect(store.autoBalance).toMatchObject({ enabled: true, state: "draining" });
  unsub();
});

test("selectAndMigrate posts a migrate intent to the engine active route and adopts the target", async () => {
  let committed = "main";
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload({ active: committed });
    if (url === "/api/accounts/claude/active" && (body as { mode?: string }).mode === "migrate") committed = "work";
    return new Response(null, { status: 202 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const ok = await store.selectAndMigrate("work", 5);
  expect(ok).toBeTrue();
  expect(store.active).toBe("work");
  const migrateCall = calls.find((call) => call.url === "/api/accounts/claude/active" && (call.body as { mode?: string }).mode === "migrate");
  expect(migrateCall?.body).toMatchObject({ id: "work", migrate: true, previewRevision: 5 });
  expect(typeof (migrateCall?.body as { requestId?: string }).requestId).toBe("string");
});

test("preview posts mode:preview and parses the scope counts without mutating active", async () => {
  const { fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload();
    if ((body as { mode?: string })?.mode === "preview") return { targetId: "work", targetLabel: "Work", counts: { total: 4, idle: 3, busy: 1 }, rootWarning: true, previewRevision: 9 };
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const preview = await store.preview("work");
  expect(preview).toMatchObject({ targetId: "work", counts: { total: 4, idle: 3, busy: 1 }, rootWarning: true, previewRevision: 9 });
  expect(store.active).toBe("main");
});

test("setAutoBalance uses the frozen engine policy route contract", async () => {
  const seen: string[] = [];
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload({ autoBalance: { enabled: true, state: "idle", thresholdPercent: 25 } });
    if (url === "/api/accounts/claude/policy") {
      seen.push(JSON.stringify(body));
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  await store.setAutoBalance(false);
  expect(seen.some((body) => JSON.parse(body).automaticSwitching === false)).toBeTrue();
  expect(calls.some((call) => call.url === "/api/accounts/claude/policy" && call.method === "PATCH")).toBeTrue();
});

test("stopMigration targets the draining intent id", async () => {
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({ migration: { intentId: "intent-7", targetId: "work", state: "draining" } });
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  await store.stopMigration();
  expect(calls.some((call) => call.url === "/api/account-migrations/intent-7" && call.method === "POST" && (call.body as { action?: string }).action === "stop")).toBeTrue();
});
