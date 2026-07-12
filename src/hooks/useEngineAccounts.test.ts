import { expect, test } from "bun:test";

import { claudeLoginErrKey, createEngineAccountsStore, NONTERMINAL_CLAUDE_LOGIN_PHASES, parseAccountLimits, parseClaudeLogin, type ClaudeLoginPhase } from "./useEngineAccounts";

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

test("parseAccountLimits keeps fresh/stale reads with their windows and drops the rest", () => {
  // Unavailable, absent, and non-object reads carry no window to show.
  expect(parseAccountLimits(null)).toBeNull();
  expect(parseAccountLimits({ state: "unavailable", session: null, weekly: null })).toBeNull();
  expect(parseAccountLimits({ state: "fresh", session: null, weekly: null })).toBeNull();
  // A malformed window is dropped; a valid sibling survives. resetsAt is optional.
  expect(parseAccountLimits({ state: "fresh", session: { usedPercent: "nope" }, weekly: { usedPercent: 40, resetsAt: 1_700_000_000 } }))
    .toEqual({ freshness: "fresh", session: null, weekly: { usedPercent: 40, resetsAt: 1_700_000_000 } });
  expect(parseAccountLimits({ state: "stale", session: { usedPercent: 88, resetsAt: null }, weekly: null }))
    .toEqual({ freshness: "stale", session: { usedPercent: 88, resetsAt: null }, weekly: null });
});

test("a store parses per-account session/weekly limit windows for the panel", async () => {
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") {
      return claudePayload({
        accounts: [
          {
            id: "main", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
            effective: { percent: 12, window: "session", freshness: "fresh" },
            limits: { state: "fresh", session: { usedPercent: 88, resetsAt: 1_700_000_000 }, weekly: { usedPercent: 30, resetsAt: 1_700_500_000 } },
          },
          {
            id: "work", label: "Work", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
            limits: { state: "unavailable", session: null, weekly: null },
          },
        ],
      });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  expect(store.accounts[0]?.limits).toEqual({ freshness: "fresh", session: { usedPercent: 88, resetsAt: 1_700_000_000 }, weekly: { usedPercent: 30, resetsAt: 1_700_500_000 } });
  expect(store.accounts[1]?.limits).toBeNull();
  unsub();
});

test("select posts one route-only account change and adopts the target", async () => {
  let committed = "main";
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return claudePayload({ active: committed });
    if (url === "/api/accounts/claude/active" && (body as { mode?: string }).mode === "select") committed = "work";
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const ok = await store.select("work");
  expect(ok).toBeTrue();
  expect(store.active).toBe("work");
  const selectCall = calls.find((call) => call.url === "/api/accounts/claude/active");
  expect(selectCall?.body).toEqual({ id: "work", mode: "select" });
});

test("selecting the locally active account refreshes stale server state", async () => {
  let committed = "main";
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({ active: committed });
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  committed = "work";

  expect(await store.select("main")).toBeTrue();
  expect(store.active).toBe("work");
  expect(calls.filter((call) => call.url === "/api/accounts")).toHaveLength(2);
  expect(calls.some((call) => call.url === "/api/accounts/claude/active")).toBeFalse();
});

test("select exposes its in-flight state and never calls migration endpoints", async () => {
  let resolveSelection: (() => void) | null = null;
  const calls: Call[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/accounts") return new Response(JSON.stringify(claudePayload()));
    if (url === "/api/accounts/claude/active") {
      return new Promise<Response>((resolve) => {
        resolveSelection = () => resolve(new Response(null, { status: 200 }));
      });
    }
    return new Response(null, { status: 204 });
  };
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  const selection = store.select("work");
  await advance();
  expect(store.mutation).toBe("switch");
  expect(store.active).toBe("work");
  expect(calls.some((call) => call.url.includes("migration"))).toBeFalse();
  resolveSelection!();
  await selection;
  expect(store.mutation).toBeNull();
});

test("a failed selection restores the active account and retries the same target", async () => {
  let attempts = 0;
  let committed = "main";
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({ active: committed });
    if (url === "/api/accounts/claude/active") {
      attempts += 1;
      if (attempts === 1) return new Response(null, { status: 500 });
      committed = "work";
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();
  expect(await store.select("work")).toBeFalse();
  expect(store.active).toBe("main");
  expect(store.notice?.action).toEqual({ type: "retry", kind: "switch", accountId: "work" });
  expect(await store.retryNotice()).toBeTrue();
  expect(store.active).toBe("work");
  expect(calls.filter((call) => call.url === "/api/accounts/claude/active")).toHaveLength(2);
});

test("response loss after server commit reconciles the switch as success", async () => {
  let committed = "main";
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({ active: committed });
    if (url === "/api/accounts/claude/active") {
      committed = "work";
      throw new Error("response lost");
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();

  expect(await store.select("work")).toBeTrue();
  expect(store.active).toBe("work");
  expect(store.notice).toBeNull();
  expect(calls.filter((call) => call.url === "/api/accounts/claude/active")).toHaveLength(1);
});

test("signed-out and pending accounts stay unavailable for selection", async () => {
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return claudePayload({
      accounts: [
        { id: "main", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null },
        { id: "signed-out", label: "Signed out", authPresent: false, loginPending: false, loginState: "idle", deviceAuth: null },
        { id: "pending", label: "Pending", authPresent: false, loginPending: true, loginState: "pending", deviceAuth: null },
      ],
    });
    return new Response(null, { status: 200 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  store.subscribe(() => {});
  await advance();

  expect(await store.select("signed-out")).toBeFalse();
  expect(await store.select("pending")).toBeFalse();
  expect(calls.some((call) => call.url === "/api/accounts/claude/active")).toBeFalse();
  expect(store.active).toBe("main");
});

// ── Issue #61 — Claude login slice (Fable contract C12) ──────────────────────

/** Capture setInterval/clearInterval so a test can read the poll cadence and
    fire a tick deterministically (bun 1.3 lacks jest fake timers). */
function withCapturedTimers() {
  const timers: Array<{ id: number; cb: () => void; ms: number }> = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let seq = 1;
  globalThis.setInterval = ((cb: () => void, ms?: number) => {
    const id = seq++;
    timers.push({ id, cb, ms: ms ?? 0 });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    const idx = timers.findIndex((timer) => timer.id === (id as unknown as number));
    if (idx >= 0) timers.splice(idx, 1);
  }) as typeof clearInterval;
  return {
    timers,
    active: () => timers[timers.length - 1],
    restore: () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; },
  };
}

const loginView = (over: Record<string, unknown> = {}) => ({
  operationId: "op1", phase: "awaiting_code", loginUrl: "https://claude.ai/login", acceptsCode: true,
  deadlineAt: "2026-07-10T12:00:00.000Z", result: null, ...over,
});
const claudeAcct = (over: Record<string, unknown> = {}) => ({
  id: "acc", label: "Acc", kind: "managed", authPresent: false, loginPending: false, loginState: "idle", deviceAuth: null, login: null, ...over,
});
const claudeMain = { id: "main", label: "Main", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null };

test("parseClaudeLogin validates fields and rejects unknown phases without throwing", () => {
  expect(parseClaudeLogin(null)).toBeNull();
  expect(parseClaudeLogin("nope")).toBeNull();
  expect(parseClaudeLogin({ operationId: 1, phase: "starting", loginUrl: null, acceptsCode: false, deadlineAt: "t", result: null })).toBeNull();
  expect(parseClaudeLogin({ operationId: "o", phase: "weird", loginUrl: null, acceptsCode: false, deadlineAt: "t", result: null })).toBeNull();
  // A malformed result object is rejected explicitly.
  expect(parseClaudeLogin({ operationId: "o", phase: "failed", loginUrl: null, acceptsCode: false, deadlineAt: "t", result: { status: "failure" } })).toBeNull();
  const ok = parseClaudeLogin(loginView());
  expect(ok).toMatchObject({ operationId: "op1", phase: "awaiting_code", loginUrl: "https://claude.ai/login", acceptsCode: true });
});

test("claudeLoginErrKey maps known codes and falls back generic for the rest (C12h)", () => {
  expect(claudeLoginErrKey("timed_out")).toBe("accounts.claudeLogin.err.timed_out");
  expect(claudeLoginErrKey("interrupted")).toBe("accounts.claudeLogin.err.interrupted");
  expect(claudeLoginErrKey("verification_failed")).toBe("accounts.claudeLogin.err.verification_failed");
  expect(claudeLoginErrKey("input_failed")).toBe("accounts.claudeLogin.err.input_failed");
  expect(claudeLoginErrKey("login_busy")).toBe("accounts.claudeLogin.err.login_busy");
  // Unknown / sanitized-away codes all resolve to the generic actionable line.
  expect(claudeLoginErrKey("persistence_failed")).toBe("accounts.claudeLogin.err.generic");
  expect(claudeLoginErrKey("launch_unfenced")).toBe("accounts.claudeLogin.err.generic");
  expect(claudeLoginErrKey("brand_new_code")).toBe("accounts.claudeLogin.err.generic");
  expect(claudeLoginErrKey(null)).toBe("accounts.claudeLogin.err.generic");
});

test("a claude add accepts a 202 without target, retains the account with its login (C12a)", async () => {
  let created = false;
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") {
      const accounts: unknown[] = [claudeMain];
      if (created) accounts.push(claudeAcct({ id: "new", label: "New", login: loginView() }));
      return { claude: { active: "main", accounts } };
    }
    if (url === "/api/accounts/claude" && (body as { label?: string }).label === "New") {
      created = true;
      // 202 with NO `target` field at all — the upgraded client must accept it.
      return new Response(JSON.stringify({ account: { id: "new", label: "New", authPresent: false }, login: loginView() }), { status: 202 });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  const ok = await store.add("New");
  expect(ok).toBeTrue();
  const addCall = calls.find((call) => call.url === "/api/accounts/claude");
  expect((addCall?.body as { label?: string }).label).toBe("New");
  const account = store.accounts.find((candidate) => candidate.id === "new");
  expect(account?.login?.phase).toBe("awaiting_code");
  expect(account?.loginPending).toBeTrue();
  expect(store.notice).toMatchObject({ kind: "success", messageKey: "accounts.claudeLoginStarted", target: "New" });
  unsub();
});

test("a codex add still requires a string target and rejects a 202 without one (C12b)", async () => {
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") return { codex: { active: "main", accounts: [{ id: "main", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null }] } };
    if (url === "/api/accounts/codex") return new Response(JSON.stringify({ account: { id: "c2", label: "C2", authPresent: false }, login: loginView() }), { status: 202 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("codex", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  const ok = await store.add("C2");
  expect(ok).toBeFalse();
  expect(store.notice?.messageKey).toBe("accounts.addFailed");
  unsub();
});

test("a codex add accepts a 202 with target (device login preserved)", async () => {
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") return { codex: { active: "main", accounts: [{ id: "main", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null }] } };
    if (url === "/api/accounts/codex") return new Response(JSON.stringify({ account: { id: "c2", label: "C2", authPresent: false, loginPending: true }, target: "codex-device" }), { status: 202 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("codex", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  const ok = await store.add("C2");
  expect(ok).toBeTrue();
  expect(store.notice).toMatchObject({ messageKey: "accounts.loginOpened", target: "codex-device" });
  unsub();
});

for (const phase of ["starting", "awaiting_browser", "awaiting_code", "verifying", "canceling"] as ClaudeLoginPhase[]) {
  test(`a claude login in nonterminal phase ${phase} fast-polls at 2500ms (C12c)`, async () => {
    const timers = withCapturedTimers();
    try {
      const { fetcher } = scripted((url) => {
        if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeAcct({ login: loginView({ phase }) })] } };
        return new Response(null, { status: 204 });
      });
      const store = createEngineAccountsStore("claude", { fetcher });
      const unsub = store.subscribe(() => {});
      await advance();
      expect(NONTERMINAL_CLAUDE_LOGIN_PHASES.has(phase)).toBeTrue();
      expect(timers.active()?.ms).toBe(2500);
      unsub();
    } finally { timers.restore(); }
  });
}

for (const phase of ["authenticated", "canceled", "timed_out", "failed", "interrupted"] as ClaudeLoginPhase[]) {
  test(`a claude login in terminal phase ${phase} stops polling (C12c)`, async () => {
    const timers = withCapturedTimers();
    try {
      const result = phase === "authenticated"
        ? { status: "success", code: "authenticated", message: "x" }
        : phase === "canceled"
          ? { status: "canceled", code: "canceled", message: "x" }
          : { status: "failure", code: phase, message: "x" };
      const { fetcher } = scripted((url) => {
        if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeAcct({ authPresent: phase === "authenticated", login: loginView({ phase, acceptsCode: false, result }) })] } };
        return new Response(null, { status: 204 });
      });
      const store = createEngineAccountsStore("claude", { fetcher });
      const unsub = store.subscribe(() => {});
      await advance();
      expect(timers.timers.length).toBe(0);
      unsub();
    } finally { timers.restore(); }
  });
}

test("a nonterminal login schedules a poll whose tick refreshes, and settling stops it (C12c)", async () => {
  const timers = withCapturedTimers();
  try {
    let phase: ClaudeLoginPhase = "awaiting_code";
    const { calls, fetcher } = scripted((url) => {
      if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeAcct({ authPresent: phase === "authenticated", login: loginView({ phase, result: phase === "authenticated" ? { status: "success", code: "authenticated", message: "x" } : null }) })] } };
      return new Response(null, { status: 204 });
    });
    const store = createEngineAccountsStore("claude", { fetcher });
    const unsub = store.subscribe(() => {});
    await advance();
    const before = calls.filter((call) => call.url === "/api/accounts").length;
    timers.active()!.cb();
    await advance();
    expect(calls.filter((call) => call.url === "/api/accounts").length).toBe(before + 1);
    // The login settles; the next tick refreshes, sees a terminal phase, and clears the interval.
    phase = "authenticated";
    timers.active()!.cb();
    await advance();
    expect(timers.timers.length).toBe(0);
    unsub();
  } finally { timers.restore(); }
});

test("submitLoginCode optimistically verifies and maps a failed submit to input_failed (C12d)", async () => {
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeAcct({ login: loginView() })] } };
    if (url === "/api/accounts/claude/login/op1/input") return new Response(JSON.stringify({ error: "bad" }), { status: 409 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const phases: Array<string | undefined> = [];
  const unsub = store.subscribe(() => phases.push(store.accounts.find((account) => account.id === "acc")?.login?.phase));
  await advance();
  const ok = await store.submitLoginCode("op1", "  auth#state  ");
  expect(ok).toBeFalse();
  expect(phases).toContain("verifying"); // optimistic transition emitted
  const inputCall = calls.find((call) => call.url === "/api/accounts/claude/login/op1/input");
  expect((inputCall?.body as { code?: string }).code).toBe("auth#state"); // trimmed, raw value
  expect(store.notice?.messageKey).toBe("accounts.claudeLogin.err.input_failed");
  unsub();
});

test("cancelLogin optimistically enters canceling and issues a DELETE (C12e)", async () => {
  const { calls, fetcher } = scripted((url) => {
    if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeAcct({ login: loginView() })] } };
    if (url === "/api/accounts/claude/login/op1") return new Response(null, { status: 200 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const phases: Array<string | undefined> = [];
  const unsub = store.subscribe(() => phases.push(store.accounts.find((account) => account.id === "acc")?.login?.phase));
  await advance();
  await store.cancelLogin("op1");
  expect(phases).toContain("canceling");
  const del = calls.find((call) => call.url === "/api/accounts/claude/login/op1");
  expect(del?.method).toBe("DELETE");
  unsub();
});

test("retryLogin replaces the login on 202 and reports login_busy on 409 (C12f)", async () => {
  let busy = false;
  let currentLogin: unknown = null;
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeAcct({ login: currentLogin })] } };
    if (url === "/api/accounts/claude" && (body as { action?: string }).action === "retry") {
      if (busy) return new Response(JSON.stringify({ error: "busy", code: "login_busy" }), { status: 409 });
      currentLogin = loginView({ operationId: "op9", phase: "awaiting_browser", acceptsCode: false });
      return new Response(JSON.stringify({ account: { id: "acc", label: "Acc", authPresent: false }, login: currentLogin }), { status: 202 });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  const ok = await store.retryLogin("acc");
  expect(ok).toBeTrue();
  const retryCall = calls.find((call) => call.url === "/api/accounts/claude" && (call.body as { action?: string }).action === "retry");
  expect((retryCall?.body as { id?: string }).id).toBe("acc"); // account id from the stored row
  expect(store.accounts.find((account) => account.id === "acc")?.login?.operationId).toBe("op9");
  // A second concurrent sign-in is refused with the busy code; the row survives.
  busy = true;
  const ok2 = await store.retryLogin("acc");
  expect(ok2).toBeFalse();
  expect(store.notice?.messageKey).toBe("accounts.claudeLogin.err.login_busy");
  expect(store.accounts.some((account) => account.id === "acc")).toBeTrue();
  unsub();
});

test("a stale device hydrates the active login after login_busy and starts fast polling", async () => {
  const timers = withCapturedTimers();
  try {
    const activeElsewhere = loginView({ operationId: "op-other-device", phase: "awaiting_browser", acceptsCode: false });
    let currentLogin: unknown = null;
    const { calls, fetcher } = scripted((url, body) => {
      if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeAcct({ login: currentLogin })] } };
      if (url === "/api/accounts/claude" && (body as { action?: string }).action === "retry") {
        currentLogin = activeElsewhere;
        return new Response(JSON.stringify({ error: "busy", code: "login_busy" }), { status: 409 });
      }
      return new Response(null, { status: 204 });
    });
    const store = createEngineAccountsStore("claude", { fetcher });
    const unsub = store.subscribe(() => {});
    await advance();
    expect(store.accounts.find((account) => account.id === "acc")?.login).toBeNull();
    const ok = await store.retryLogin("acc");

    expect(ok).toBeFalse();
    expect(calls.filter((call) => call.url === "/api/accounts").length).toBe(2);
    expect(store.accounts.find((account) => account.id === "acc")?.login).toEqual(expect.objectContaining({ operationId: "op-other-device", phase: "awaiting_browser" }));
    expect(timers.active()?.ms).toBe(2_500);
    expect(store.notice?.messageKey).toBe("accounts.claudeLogin.err.login_busy");
    unsub();
  } finally { timers.restore(); }
});

test("a non-202 claude add keeps the add retry action with the draft label (C12g)", async () => {
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeMain] } };
    if (url === "/api/accounts/claude") return new Response(JSON.stringify({ error: "no", code: "start_failed" }), { status: 503 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  const ok = await store.add("Fresh");
  expect(ok).toBeFalse();
  // The retry keeps kind:"add" with the label so the draft survives; start_failed → generic copy.
  expect(store.notice?.action).toMatchObject({ type: "retry", kind: "add", label: "Fresh" });
  expect(store.notice?.messageKey).toBe("accounts.claudeLogin.err.generic");
  unsub();
});

test("managed account removal retries with force only after the API reports a safety blocker", async () => {
  let removed = false;
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") {
      return {
        claude: {
          active: "main",
          accounts: [
            claudeMain,
            ...(removed ? [] : [claudeAcct({ id: "work", label: "Work", login: null })]),
          ],
        },
      };
    }
    if (url === "/api/accounts/claude" && (body as { id?: string }).id === "work") {
      if ((body as { force?: boolean }).force !== true) {
        return new Response(JSON.stringify({ code: "account_removal_blocked", blockers: ["live_sessions"] }), { status: 409 });
      }
      removed = true;
      return new Response(JSON.stringify({ removed: { id: "work" } }));
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();

  expect(await store.remove("work")).toBeFalse();
  expect(store.notice?.action).toMatchObject({ type: "retry", kind: "forceRemove", accountId: "work" });
  expect(await store.retryNotice()).toBeTrue();
  expect(store.notice).toBeNull();
  expect(calls.filter((call) => call.url === "/api/accounts/claude").map((call) => call.body)).toEqual([
    { id: "work", force: false },
    { id: "work", force: true },
  ]);
  expect(store.accounts.some((account) => account.id === "work")).toBeFalse();
  expect(store.notice).toBeNull();
  unsub();
});

test("managed account removal surfaces pending local cleanup with a recovery action", async () => {
  let removed = false;
  const { calls, fetcher } = scripted((url, body) => {
    if (url === "/api/accounts") {
      return { claude: { active: "main", accounts: [claudeMain, ...(removed ? [] : [claudeAcct({ id: "work", label: "Work", login: null })])] } };
    }
    if (url === "/api/accounts/claude" && (body as { cleanupOrphans?: boolean }).cleanupOrphans === true) {
      return new Response(JSON.stringify({ removed: ["work"] }));
    }
    if (url === "/api/accounts/claude") {
      removed = true;
      return new Response(JSON.stringify({ removed: { id: "work" }, cleanupPending: true }));
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();

  expect(await store.remove("work")).toBeTrue();
  expect(store.notice).toMatchObject({
    messageKey: "accounts.cleanupPending",
    target: "Work",
    action: { type: "retry", kind: "cleanupOrphans" },
  });
  expect(await store.retryNotice()).toBeTrue();
  expect(calls.filter((call) => call.url === "/api/accounts/claude").map((call) => call.body)).toEqual([
    { id: "work", force: false },
    { cleanupOrphans: true },
  ]);
  unsub();
});

test("orphan cleanup keeps manual guidance when unsafe local data remains", async () => {
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeMain] } };
    if (url === "/api/accounts/claude") {
      return new Response(JSON.stringify({ removed: [], unresolved: ["unsafe-orphan"] }));
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();

  expect(await store.cleanupOrphans()).toBeTrue();
  expect(store.notice).toMatchObject({ messageKey: "accounts.cleanupManual", action: null });
  unsub();
});

test("current conversation blockers provide migration guidance without a force loop", async () => {
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") return { claude: { active: "main", accounts: [claudeMain, claudeAcct({ id: "work", label: "Work", login: null })] } };
    if (url === "/api/accounts/claude") return new Response(JSON.stringify({ code: "account_removal_blocked", blockers: ["current_conversations"] }), { status: 409 });
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();
  expect(await store.remove("work")).toBeFalse();
  expect(store.notice).toMatchObject({ messageKey: "accounts.removeHistoryBlocked", action: null });
  unsub();
});

test("a blocked removal's force-remove notice survives the follow-up refresh failing", async () => {
  let accountsCalls = 0;
  const { fetcher } = scripted((url) => {
    if (url === "/api/accounts") {
      accountsCalls += 1;
      // First read succeeds so the store hydrates; the refresh triggered by
      // the blocked removal below fails transiently.
      if (accountsCalls > 1) return new Response(null, { status: 500 });
      return { claude: { active: "main", accounts: [claudeMain, claudeAcct({ id: "work", label: "Work", login: null })] } };
    }
    if (url === "/api/accounts/claude") {
      return new Response(JSON.stringify({ code: "account_removal_blocked", blockers: ["live_sessions"] }), { status: 409 });
    }
    return new Response(null, { status: 204 });
  });
  const store = createEngineAccountsStore("claude", { fetcher });
  const unsub = store.subscribe(() => {});
  await advance();

  expect(await store.remove("work")).toBeFalse();
  expect(store.notice?.action).toMatchObject({ type: "retry", kind: "forceRemove", accountId: "work" });
  unsub();
});
