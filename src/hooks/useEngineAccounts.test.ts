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

test("preview canonicalises the flat coordinator DTO using the known target account", async () => {
  const { fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload();
    // The coordinator returns flat counts + revision with no targetId/label.
    if ((body as { mode?: string })?.mode === "preview") return { total: 4, idle: 3, busy: 1, revision: 9 };
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const preview = await store.preview("work");
  // The client fills the target identity/label from the account it asked about.
  expect(preview).toEqual({ targetId: "work", targetLabel: "Work", counts: { total: 4, idle: 3, busy: 1 }, rootWarning: false, previewRevision: 9 });
  expect(store.active).toBe("main");
});

test("preview returns null on a non-OK response so the panel can surface a recoverable error", async () => {
  const { fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload();
    if ((body as { mode?: string })?.mode === "preview") return new Response(null, { status: 500 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  expect(await store.preview("work")).toBeNull();
  expect(store.active).toBe("main"); // never switched as a side effect
});

test("setAutoBalance PATCHes the frozen policy route with automaticSwitching", async () => {
  const seen: Array<{ method?: string; body: unknown }> = [];
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({ autoBalance: { enabled: true, state: "idle", thresholdPercent: 25 } });
    return new Response(null, { status: 204 });
  });
  // Wrap the scripted fetcher so this test can also see the HTTP method.
  const withMethod = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "/api/accounts/claude/policy") {
      seen.push({ method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response(null, { status: 200 });
    }
    return fetcher(input, init);
  };
  const store = createEngineAccountsStore("claude", { fetcher: withMethod });
  store.subscribe(() => {});
  await advance();
  await store.setAutoBalance(false);
  expect(seen.length).toBe(1);
  expect(seen[0]?.method).toBe("PATCH");
  expect(seen[0]?.body).toMatchObject({ automaticSwitching: false });
  expect(typeof (seen[0]?.body as { requestId?: unknown }).requestId).toBe("string");
  // The old POST …/auto-balance {enabled} route must never be called.
});

test("stopMigration targets the frozen account-migrations route by intent id", async () => {
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({ migration: { intentId: "intent-7", targetId: "work", state: "draining" } });
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  await store.stopMigration();
  expect(calls.some((call) => call.url === "/api/account-migrations/intent-7" && call.method === "POST" && (call.body as { action?: string }).action === "stop")).toBeTrue();
  // The old /api/accounts/migration/{id} route never existed.
  expect(calls.some((call) => call.url.includes("/api/accounts/migration/"))).toBeFalse();
});
