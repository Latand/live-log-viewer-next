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
    if ((body as { mode?: string })?.mode === "preview") return { targetId: "work", targetLabel: "Work", counts: { total: 4, idle: 3, busy: 1 }, previewRevision: 9 };
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const preview = await store.preview("work");
  expect(preview).toMatchObject({ targetId: "work", counts: { total: 4, idle: 3, busy: 1 }, previewRevision: 9 });
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
  expect(preview).toEqual({ targetId: "work", targetLabel: "Work", counts: { total: 4, idle: 3, busy: 1 }, previewRevision: 9 });
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

test("the store exposes no bare select, and every write to /active carries a mode", async () => {
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload();
    if ((body as { mode?: string })?.mode === "preview") return { total: 2, idle: 2, busy: 0, revision: 4 };
    return new Response(null, { status: 202 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  // The bare instant-switch method is gone — the only account-switch path is
  // preview → migrate (issue #40).
  expect((store as unknown as { select?: unknown }).select).toBeUndefined();
  await store.preview("work");
  await store.selectAndMigrate("work", 4);
  const activeWrites = calls.filter((call) => call.url === "/api/accounts/claude/active");
  expect(activeWrites.length).toBeGreaterThan(0);
  // Not one mode-less write exists: an unscoped switch with no durable intent is
  // exactly the hazard the unified UX removes.
  for (const write of activeWrites) expect((write.body as { mode?: string }).mode).toBeDefined();
});

test("retryNotice re-fences a failed migrate against a fresh preview revision before migrating", async () => {
  let previewRevision = 4;
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload();
    const mode = (body as { mode?: string })?.mode;
    if (mode === "preview") return { total: 1, idle: 1, busy: 0, revision: previewRevision };
    if (mode === "migrate") {
      // The first migrate (stale revision 1) fails; that seeds the retryable notice.
      if ((body as { previewRevision?: number }).previewRevision === 1) return new Response(null, { status: 409 });
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const failed = await store.selectAndMigrate("work", 1);
  expect(failed).toBeFalse();
  // A switch failure retains the account target id and retries through the
  // preview → migrate path.
  expect(store.notice?.action).toMatchObject({ type: "retry", kind: "migrate", accountId: "work" });
  // The retry must fetch a fresh revision first, then migrate with it — never
  // replay the stale one.
  previewRevision = 9;
  calls.length = 0;
  const recovered = await store.retryNotice();
  expect(recovered).toBeTrue();
  const previewIdx = calls.findIndex((call) => (call.body as { mode?: string })?.mode === "preview");
  const migrateCall = calls.find((call) => (call.body as { mode?: string })?.mode === "migrate");
  expect(previewIdx).toBeGreaterThanOrEqual(0);
  expect(calls.indexOf(migrateCall!)).toBeGreaterThan(previewIdx); // preview precedes migrate
  expect(migrateCall?.body).toMatchObject({ previewRevision: 9 });
  expect(store.notice).toBeNull(); // the recovered retry clears the stale failure
});

test("retryNotice fails closed when a migrate retry can't obtain a fresh preview", async () => {
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload();
    const mode = (body as { mode?: string })?.mode;
    if (mode === "preview") return new Response(null, { status: 500 }); // preview unreachable
    if (mode === "migrate") return new Response(null, { status: 409 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  await store.selectAndMigrate("work", 1);
  calls.length = 0;
  const recovered = await store.retryNotice();
  expect(recovered).toBeFalse();
  // No migrate is attempted with a stale revision when the fresh preview fails.
  expect(calls.some((call) => (call.body as { mode?: string })?.mode === "migrate")).toBeFalse();
});

test("retryFailedMigration posts action:retry-failed fenced by the intent revision", async () => {
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({ migration: { intentId: "intent-9", targetId: "work", state: "draining", revision: 3, counts: { done: 1, total: 4, waitingTurn: 0, inFlight: 1, failed: 2 } } });
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  await store.retryFailedMigration();
  const retry = calls.find((call) => call.url === "/api/account-migrations/intent-9" && call.method === "POST");
  expect(retry?.body).toMatchObject({ action: "retry-failed", expectedRevision: 3 });
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

test("a failed stop retries against the intent stop endpoint with the current revision and stays off the account route", async () => {
  let failNextStop = true;
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload({ migration: { intentId: "intent-42", targetId: "work", state: "draining", revision: 5, counts: { done: 1, total: 4, waitingTurn: 0, inFlight: 1, failed: 2 } } });
    if (url === "/api/account-migrations/intent-42" && (body as { action?: string }).action === "stop") {
      if (failNextStop) { failNextStop = false; return new Response(null, { status: 500 }); }
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const failed = await store.stopMigration();
  expect(failed).toBeFalse();
  // The retry retains the intent id and routes to the intent endpoint.
  expect(store.notice?.action).toMatchObject({ type: "retry", kind: "stop", intentId: "intent-42" });
  calls.length = 0;
  const recovered = await store.retryNotice();
  expect(recovered).toBeTrue();
  const stopRetry = calls.find((call) => call.url === "/api/account-migrations/intent-42" && (call.body as { action?: string }).action === "stop");
  expect(stopRetry?.body).toMatchObject({ action: "stop", expectedRevision: 5 });
  // No account preview/active route is ever touched by a stop retry.
  expect(calls.some((call) => call.url === "/api/accounts/claude/active")).toBeFalse();
});

test("a failed retry-failed retries against the intent retry-failed endpoint with the current revision", async () => {
  let failNext = true;
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload({ migration: { intentId: "intent-99", targetId: "work", state: "draining", revision: 8, counts: { done: 1, total: 4, waitingTurn: 0, inFlight: 1, failed: 2 } } });
    if (url === "/api/account-migrations/intent-99" && (body as { action?: string }).action === "retry-failed") {
      if (failNext) { failNext = false; return new Response(null, { status: 500 }); }
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const failed = await store.retryFailedMigration();
  expect(failed).toBeFalse();
  expect(store.notice?.action).toMatchObject({ type: "retry", kind: "retryFailed", intentId: "intent-99" });
  calls.length = 0;
  const recovered = await store.retryNotice();
  expect(recovered).toBeTrue();
  const retry = calls.find((call) => call.url === "/api/account-migrations/intent-99" && (call.body as { action?: string }).action === "retry-failed");
  expect(retry?.body).toMatchObject({ action: "retry-failed", expectedRevision: 8 });
  expect(calls.some((call) => call.url === "/api/accounts/claude/active")).toBeFalse();
});
