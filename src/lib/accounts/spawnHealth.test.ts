import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "bun:test";

import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON } from "@/lib/types";

import type { ClaudeAccount } from "./claude";

const NOW = Date.parse("2026-07-14T09:00:00.000Z");
const STATE_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-health-state-"));
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
const PREVIOUS_HOME = process.env.LLV_CLAUDE_HOME;
const PREVIOUS_FETCH = globalThis.fetch;
let providerReads = 0;
process.env.LLV_STATE_DIR = path.join(STATE_SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(STATE_SANDBOX, "legacy-claude");
globalThis.fetch = (async () => {
  providerReads += 1;
  return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401, headers: { "content-type": "application/json" } });
}) as unknown as typeof globalThis.fetch;
const { claudeValidityFromLimitRead, NoHealthyClaudeAccountError, selectHealthyClaudeAccount } = await import("./spawnHealth");
const { withAccountMutationLockAsync } = await import("./accountMutation");
const homes: string[] = [];
const current = () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null } as const);
const lastKnown = () => ({ kind: "admissible", basis: "last-known", stale: true, retryAt: null } as const);
const unavailable = () => ({ kind: "unavailable", reason: "auth-failed", stale: false, retryAt: null } as const);

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  if (PREVIOUS_HOME === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = PREVIOUS_HOME;
  globalThis.fetch = PREVIOUS_FETCH;
  fs.rmSync(STATE_SANDBOX, { recursive: true, force: true });
});

function account(id: string, expiresAt: number, authPresent = true, refreshable = true): ClaudeAccount {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `llv-spawn-health-${id}-`));
  homes.push(home);
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      ["access" + "Token"]: crypto.randomUUID(),
      ...(refreshable ? { refreshToken: crypto.randomUUID() } : {}),
      expiresAt,
    },
  }), { mode: 0o600 });
  return { id, label: id, kind: "managed", home, projectsDir: path.join(home, "projects"), authPresent, createdAt: 0 };
}

test("spawn selection skips an unrefreshable expired preferred Claude account and probes a healthy fallback", async () => {
  const expired = account("expired", NOW - 1, true, false);
  const healthy = account("healthy", NOW + 60_000);
  const probed: string[] = [];

  const selected = await selectHealthyClaudeAccount([expired, healthy], "expired", {
    now: () => NOW,
    probe: async (candidate) => {
      probed.push(candidate.id);
      return current();
    },
    refresh: async () => unavailable(),
  });

  expect(selected.account.id).toBe("healthy");
  expect(probed).toEqual(["healthy"]);
});

test("spawn selection does not await an expired account when a current account can launch", async () => {
  const expired = account("expired", NOW - 1);
  const healthy = account("healthy", NOW + 60_000);
  let refreshCalls = 0;

  const selected = await selectHealthyClaudeAccount([expired, healthy], "healthy", {
    now: () => NOW,
    probe: async () => current(),
    refresh: async () => {
      refreshCalls += 1;
      await new Promise(() => {});
      return lastKnown();
    },
  });

  expect(selected.account.id).toBe("healthy");
  expect(refreshCalls).toBe(0);
});

test("live usage evidence retains spawn validity classifications", () => {
  expect(claudeValidityFromLimitRead({ source: "live", reason: null, data: null }, NOW)).toMatchObject({ kind: "admissible", basis: "current", stale: false });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: LIMITS_RATE_LIMITED_REASON, data: null, retryAt: NOW + 60_000 }, NOW)).toEqual({
    kind: "admissible",
    basis: "last-known",
    stale: true,
    retryAt: null,
  });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: LIMITS_REAUTH_REQUIRED_REASON, data: null }, NOW)).toMatchObject({ kind: "unavailable", reason: "auth-failed" });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "credentials missing access token", data: null }, NOW)).toMatchObject({ kind: "unavailable", reason: "auth-failed" });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "credentials unreadable: test fixture", data: null }, NOW)).toMatchObject({ kind: "unavailable", reason: "auth-failed" });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "request timed out", data: null }, NOW)).toMatchObject({ kind: "admissible", basis: "last-known", stale: true });
  const retryAt = Math.floor(NOW / 1_000) + 900;
  expect(claudeValidityFromLimitRead({
    source: "live",
    reason: null,
    data: {
      session: { usedPercent: 100, resetsAt: retryAt },
      weekly: { usedPercent: 20, resetsAt: retryAt + 3_600 },
      plan: "pro",
      capturedAt: Math.floor(NOW / 1_000),
    },
  }, NOW)).toEqual({
    kind: "retry-at",
    reason: "hard-limit",
    stale: false,
    retryAt: new Date(retryAt * 1_000).toISOString(),
  });
});

test("an exhausted explicit account exposes its retry deadline while routing finds a healthy fallback", async () => {
  const pinned = account("account-a", NOW + 60_000);
  const fallback = account("account-b", NOW + 60_000);
  const retryAt = Math.floor(NOW / 1_000) + 900;
  const selected = await selectHealthyClaudeAccount([pinned, fallback], pinned.id, {
    now: () => NOW,
    probe: async (candidate) => candidate.id === pinned.id
      ? claudeValidityFromLimitRead({
          source: "live",
          reason: null,
          data: {
            session: { usedPercent: 100, resetsAt: retryAt },
            weekly: null,
            plan: "pro",
            capturedAt: Math.floor(NOW / 1_000),
          },
        }, NOW)
      : current(),
    refresh: async () => unavailable(),
  });

  expect(selected.account.id).toBe(fallback.id);
  expect(selected.requestedAdmission).toMatchObject({
    kind: "retry-at",
    retryAt: new Date(retryAt * 1_000).toISOString(),
  });
});

test("an unavailable explicit pin falls back to the healthy active account before account-id ordering", async () => {
  const requested = account("account-z", NOW + 60_000);
  const lexicalFirst = account("account-a", NOW + 60_000);
  const active = account("account-b", NOW + 60_000);

  const selected = await selectHealthyClaudeAccount([
    requested,
    lexicalFirst,
    active,
  ], requested.id, {
    now: () => NOW,
    probe: async (candidate) => candidate.id === requested.id ? unavailable() : current(),
    refresh: async () => unavailable(),
  }, true, active.id);

  expect(selected.account.id).toBe(active.id);
  expect(selected.requestedAdmission).toEqual(unavailable());
});

test("a self-throttled prober launches the preferred account from last-known stale state", async () => {
  const accounts = [account("account-a", NOW + 60_000), account("account-b", NOW + 60_000)];
  const retryAt = NOW + 5 * 60_000;

  const selected = await selectHealthyClaudeAccount(accounts, "account-b", {
    now: () => NOW,
    probe: async () => claudeValidityFromLimitRead({
      source: "unavailable",
      reason: LIMITS_RATE_LIMITED_REASON,
      data: null,
      retryAt,
    }, NOW),
    refresh: async () => { throw new Error("refresh should not run"); },
  });

  expect(selected.account.id).toBe("account-b");
  expect(selected.admission).toEqual({
    kind: "admissible",
    basis: "last-known",
    stale: true,
    retryAt: null,
  });
});

test("spawn selection refreshes an expired preferred Claude account before admission", async () => {
  const expired = account("expired", NOW - 1);
  const refreshed: string[] = [];

  const selected = await selectHealthyClaudeAccount([expired], "expired", {
    now: () => NOW,
    probe: async () => {
      throw new Error("current-access probe should not run");
    },
    refresh: async (candidate) => {
      refreshed.push(candidate.id);
      return current();
    },
  });

  expect(selected.account.id).toBe("expired");
  expect(refreshed).toEqual(["expired"]);
});

test("Claude provider checks waiting behind deletion re-resolve retired accounts before activity", async () => {
  const stateFile = path.join(process.env.LLV_STATE_DIR!, "claude-accounts.json");
  const managedAccount = (id: string, expiresAt: number): ClaudeAccount => {
    const home = path.join(STATE_SANDBOX, "accounts", "claude", id);
    fs.mkdirSync(path.join(home, "projects"), { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        ["access" + "Token"]: crypto.randomUUID(),
        ["refresh" + "Token"]: crypto.randomUUID(),
        expiresAt,
      },
    }), { mode: 0o600 });
    return { id, label: id, kind: "managed", home, projectsDir: path.join(home, "projects"), authPresent: true, createdAt: 1 };
  };
  const observedNow = Date.now();
  const expired = managedAccount("refresh-stale", observedNow - 1);
  const currentAccount = managedAccount("probe-stale", observedNow + 60_000);
  const activeRegistry = {
    version: 1,
    active: "default",
    accounts: [expired, currentAccount].map(({ id, label, kind, createdAt }) => ({ id, label, kind, createdAt })),
    retired: [],
  };
  const retiredRegistry = {
    version: 1,
    active: "default",
    accounts: [],
    retired: [expired, currentAccount].map(({ id, label }) => ({ id, label, retiredAt: 2 })),
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify(activeRegistry), { mode: 0o600 });
  providerReads = 0;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withAccountMutationLockAsync(async () => {
    entered();
    await held;
    fs.writeFileSync(stateFile, JSON.stringify(retiredRegistry), { mode: 0o600 });
  });
  await acquired;

  const refreshResult = selectHealthyClaudeAccount([expired], expired.id).then(() => null, (error: unknown) => error);
  const probeResult = selectHealthyClaudeAccount([currentAccount], currentAccount.id).then(() => null, (error: unknown) => error);
  await Bun.sleep(10);
  expect(providerReads).toBe(0);
  release();
  await holder;

  expect(await refreshResult).toBeInstanceOf(Error);
  expect(await probeResult).toBeInstanceOf(Error);
  expect(providerReads).toBe(0);
});

test("concurrent admissions coalesce refresh validation for one account", async () => {
  const expired = account("concurrent", NOW - 1);
  let refreshCalls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const dependencies = {
    now: () => NOW,
    probe: async () => unavailable(),
    refresh: async () => {
      refreshCalls += 1;
      await held;
      return current();
    },
  };

  const first = selectHealthyClaudeAccount([expired], expired.id, dependencies);
  const second = selectHealthyClaudeAccount([expired], expired.id, dependencies);
  await Promise.resolve();
  await Promise.resolve();

  expect(refreshCalls).toBe(1);
  release();
  expect((await first).account.id).toBe(expired.id);
  expect((await second).account.id).toBe(expired.id);
});

test("three expired accounts deterministically select the sole refreshable account", async () => {
  const accounts = [account("charlie", NOW - 1), account("alpha", NOW - 1), account("bravo", NOW - 1)];

  const selected = await selectHealthyClaudeAccount(accounts, "charlie", {
    now: () => NOW,
    probe: async () => unavailable(),
    refresh: async (candidate) => candidate.id === "bravo" ? current() : unavailable(),
  });

  expect(selected.account.id).toBe("bravo");
});

test("requested-account routing breaks ties inside one health tier", async () => {
  const accounts = [account("charlie", NOW + 60_000), account("alpha", NOW + 60_000), account("bravo", NOW + 60_000)];
  const dependencies = {
    now: () => NOW,
    probe: async () => current(),
    refresh: async () => unavailable(),
  };

  expect((await selectHealthyClaudeAccount(accounts, "charlie", dependencies)).account.id).toBe("charlie");
  expect((await selectHealthyClaudeAccount(accounts, null, dependencies)).account.id).toBe("alpha");
});

test("missing and non-refreshable credentials stay fenced without validation calls", async () => {
  const missing = account("missing", NOW + 60_000, false);
  const expired = account("no-refresh", NOW - 1, true, false);
  let calls = 0;

  await expect(selectHealthyClaudeAccount([missing, expired], null, {
    now: () => NOW,
    probe: async () => { calls += 1; return current(); },
    refresh: async () => { calls += 1; return current(); },
  })).rejects.toBeInstanceOf(NoHealthyClaudeAccountError);

  expect(calls).toBe(0);
});

test("an unpinned routed account yields to current evidence when its last-known state is stale", async () => {
  const stale = account("stale", NOW + 60_000);
  const confirmed = account("confirmed", NOW + 60_000);

  const selected = await selectHealthyClaudeAccount([stale, confirmed], "stale", {
    now: () => NOW,
    probe: async (candidate) => candidate.id === "confirmed" ? current() : lastKnown(),
    refresh: async () => unavailable(),
  }, false);

  expect(selected.account.id).toBe("confirmed");
  expect(selected.requestedAdmission).toBeUndefined();
});

test("spawn selection reports every dead account when none can launch", async () => {
  const expired = account("expired", NOW - 1);
  const rejected = account("rejected", NOW + 60_000);

  try {
    await selectHealthyClaudeAccount([expired, rejected], "expired", {
      now: () => NOW,
      probe: async () => unavailable(),
      refresh: async () => unavailable(),
    });
    throw new Error("expected selection to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(NoHealthyClaudeAccountError);
    expect((error as Error).message).toContain("expired");
    expect((error as Error).message).toContain("rejected");
    expect((error as Error).message).toContain("Re-login");
  }
});
