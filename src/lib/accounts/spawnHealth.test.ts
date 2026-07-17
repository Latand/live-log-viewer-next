import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON } from "@/lib/types";

import type { ClaudeAccount } from "./claude";
import { claudeValidityFromLimitRead, NoHealthyClaudeAccountError, selectHealthyClaudeAccount } from "./spawnHealth";

const NOW = Date.parse("2026-07-14T09:00:00.000Z");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function account(id: string, expiresAt: number, authPresent = true, refreshable = true): ClaudeAccount {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `llv-spawn-health-${id}-`));
  homes.push(home);
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: crypto.randomUUID(),
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
      return "valid";
    },
    refresh: async () => "invalid",
  });

  expect(selected.id).toBe("healthy");
  expect(probed).toEqual(["healthy"]);
});

test("live usage evidence retains spawn validity classifications", () => {
  expect(claudeValidityFromLimitRead({ source: "live", reason: null })).toBe("valid");
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: LIMITS_RATE_LIMITED_REASON })).toBe("valid");
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: LIMITS_REAUTH_REQUIRED_REASON })).toBe("invalid");
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "credentials missing access token" })).toBe("invalid");
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "credentials unreadable: test fixture" })).toBe("invalid");
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "request timed out" })).toBe("unknown");
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
      return "valid";
    },
  });

  expect(selected.id).toBe("expired");
  expect(refreshed).toEqual(["expired"]);
});

test("concurrent admissions coalesce refresh validation for one account", async () => {
  const expired = account("concurrent", NOW - 1);
  let refreshCalls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const dependencies = {
    now: () => NOW,
    probe: async () => "invalid" as const,
    refresh: async () => {
      refreshCalls += 1;
      await held;
      return "valid" as const;
    },
  };

  const first = selectHealthyClaudeAccount([expired], expired.id, dependencies);
  const second = selectHealthyClaudeAccount([expired], expired.id, dependencies);
  await Promise.resolve();

  expect(refreshCalls).toBe(1);
  release();
  expect((await first).id).toBe(expired.id);
  expect((await second).id).toBe(expired.id);
});

test("three expired accounts deterministically select the sole refreshable account", async () => {
  const accounts = [account("charlie", NOW - 1), account("alpha", NOW - 1), account("bravo", NOW - 1)];

  const selected = await selectHealthyClaudeAccount(accounts, "charlie", {
    now: () => NOW,
    probe: async () => "invalid",
    refresh: async (candidate) => candidate.id === "bravo" ? "valid" : "invalid",
  });

  expect(selected.id).toBe("bravo");
});

test("requested-account routing breaks ties inside one health tier", async () => {
  const accounts = [account("charlie", NOW + 60_000), account("alpha", NOW + 60_000), account("bravo", NOW + 60_000)];
  const dependencies = {
    now: () => NOW,
    probe: async () => "valid" as const,
    refresh: async () => "invalid" as const,
  };

  expect((await selectHealthyClaudeAccount(accounts, "charlie", dependencies)).id).toBe("charlie");
  expect((await selectHealthyClaudeAccount(accounts, null, dependencies)).id).toBe("alpha");
});

test("missing and non-refreshable credentials stay fenced without validation calls", async () => {
  const missing = account("missing", NOW + 60_000, false);
  const expired = account("no-refresh", NOW - 1, true, false);
  let calls = 0;

  await expect(selectHealthyClaudeAccount([missing, expired], null, {
    now: () => NOW,
    probe: async () => { calls += 1; return "valid"; },
    refresh: async () => { calls += 1; return "valid"; },
  })).rejects.toBeInstanceOf(NoHealthyClaudeAccountError);

  expect(calls).toBe(0);
});

test("spawn selection ranks a live-valid account above a transiently unverifiable preferred account", async () => {
  const preferred = account("preferred", NOW + 60_000);
  const confirmed = account("confirmed", NOW + 60_000);

  const selected = await selectHealthyClaudeAccount([preferred, confirmed], "preferred", {
    now: () => NOW,
    probe: async (candidate) => candidate.id === "confirmed" ? "valid" : "unknown",
    refresh: async () => "invalid",
  });

  expect(selected.id).toBe("confirmed");
});

test("spawn selection reports every dead account when none can launch", async () => {
  const expired = account("expired", NOW - 1);
  const rejected = account("rejected", NOW + 60_000);

  try {
    await selectHealthyClaudeAccount([expired, rejected], "expired", {
      now: () => NOW,
      probe: async () => "invalid",
      refresh: async () => "invalid",
    });
    throw new Error("expected selection to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(NoHealthyClaudeAccountError);
    expect((error as Error).message).toContain("expired");
    expect((error as Error).message).toContain("rejected");
    expect((error as Error).message).toContain("Re-login");
  }
});
