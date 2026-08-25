import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-limits-account-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
const OLD_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");
fs.mkdirSync(process.env.LLV_CLAUDE_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.LLV_CLAUDE_HOME, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token", subscriptionType: "max" } }), { mode: 0o600 });

const { createManagedCodexAccount, setActiveCodexAccount } = await import("@/lib/accounts/codex");
const {
  cachedLimitsProvenance,
  fetchClaudeLimits,
  mapAppServerRateLimits,
  providerThrottleRetryAt,
  PROVIDER_THROTTLE_GRACE_MS,
  readBurndown,
  readCodexLimits,
  readCodexTranscriptLimits,
  readLimits,
} = await import("./limits");
const { recordLimitSample } = await import("@/lib/limitsHistoryStore");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  if (OLD_CLAUDE_HOME === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = OLD_CLAUDE_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const codexLiveReader = async () => ({
  primary: { usedPercent: 12, resetsAt: 100, windowDurationMins: 300 },
  secondary: null,
  planType: "pro",
});

function resetLimitsCache(): void {
  delete (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache;
  delete (globalThis as { __llvLimitsInflight?: unknown }).__llvLimitsInflight;
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "limits-cache.json"), { force: true });
}

test("account throttle provenance round-trips from disk and expires after retry grace", () => {
  resetLimitsCache();
  const retryAtMs = Date.parse("2026-08-23T09:12:00.000Z");
  const retryAt = new Date(retryAtMs).toISOString();
  const cacheFile = path.join(process.env.LLV_STATE_DIR!, "limits-cache.json");
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 2,
    engines: {
      claude: {
        "account-a": {
          at: retryAtMs - 60_000,
          data: null,
          provenance: { source: "unavailable", reason: "oauth-rate-limited", staleSince: null, retryAt },
          retryAt: retryAtMs,
        },
      },
      codex: {},
    },
  }));
  delete (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache;

  const provenance = cachedLimitsProvenance("claude", "account-a");
  expect(provenance).toEqual({ source: "unavailable", reason: "oauth-rate-limited", staleSince: null, retryAt });
  expect(providerThrottleRetryAt(provenance, retryAtMs + PROVIDER_THROTTLE_GRACE_MS)).toBe(retryAt);
  expect(providerThrottleRetryAt(provenance, retryAtMs + PROVIDER_THROTTLE_GRACE_MS + 1)).toBeNull();
  resetLimitsCache();
});

test("present healthy memory provenance wins over stale throttled disk provenance", () => {
  resetLimitsCache();
  const retryAt = "2026-08-23T09:12:00.000Z";
  const cacheFile = path.join(process.env.LLV_STATE_DIR!, "limits-cache.json");
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 2,
    engines: {
      claude: {},
      codex: {
        "account-a": {
          at: Date.parse(retryAt) - 60_000,
          data: null,
          provenance: { source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt },
        },
      },
    },
  }));
  (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache = {
    version: 2,
    engines: {
      claude: {},
      codex: {
        "account-a": {
          at: Date.parse(retryAt),
          data: null,
          provenance: { source: "live", reason: null, staleSince: null, retryAt: null },
        },
      },
    },
  };

  expect(cachedLimitsProvenance("codex", "account-a")).toEqual({
    source: "live",
    reason: null,
    staleSince: null,
    retryAt: null,
  });
  resetLimitsCache();
});

function claudeUsage(usedPercent = 20): Response {
  return Response.json({ five_hour: { utilization: usedPercent } });
}

test("Claude usage probes honor a caller-specific timeout", async () => {
  const realFetch = globalThis.fetch;
  let observedAbort = false;
  globalThis.fetch = (async (
    _url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const signal = init?.signal;
    if (!signal) throw new Error("missing timeout signal");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      observedAbort = true;
      resolve();
    }, { once: true }));
    throw new Error("probe aborted");
  }) as unknown as typeof fetch;
  const startedAt = performance.now();
  try {
    const result = await fetchClaudeLimits(
      path.join(process.env.LLV_CLAUDE_HOME!, ".credentials.json"),
      Date.now,
      20,
    );
    expect(result).toMatchObject({ source: "unavailable" });
    expect(result.reason).toContain("probe aborted");
    expect(observedAbort).toBeTrue();
    expect(performance.now() - startedAt).toBeLessThan(500);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("switching to an account without events never reuses another account's Codex limits", async () => {
  const legacySession = path.join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "07", "09", "rollout.jsonl");
  fs.mkdirSync(path.dirname(legacySession), { recursive: true });
  fs.writeFileSync(legacySession, JSON.stringify({ timestamp: "2026-07-09T00:00:00.000Z", payload: { rate_limits: { primary: { used_percent: 37 }, plan_type: "pro" } } }) + "\n");
  expect((await readCodexLimits({ liveReader: async () => { throw new Error("offline"); } })).data?.session?.usedPercent).toBe(37);

  const fresh = createManagedCodexAccount("No events");
  setActiveCodexAccount(fresh.id);
  expect(await readCodexLimits({ liveReader: async () => { throw new Error("offline"); } })).toEqual({ data: null, reason: "app-server-unavailable", source: "unavailable" });
});

test("structured app-server windows map directly to the account-panel limits shape", () => {
  expect(mapAppServerRateLimits({
    primary: { usedPercent: 12, resetsAt: 100, windowDurationMins: 300 },
    secondary: { usedPercent: 55, resetsAt: 200, windowDurationMins: 10_080 },
    planType: "pro",
  }, 77)).toEqual({
    session: { usedPercent: 12, resetsAt: 100, windowMinutes: 300 },
    weekly: { usedPercent: 55, resetsAt: 200, windowMinutes: 10_080 },
    plan: "pro",
    capturedAt: 77,
  });
});

test("a weekly-only app-server snapshot maps to the weekly window, never the 5h one", () => {
  // A Codex plan with no 5-hour limit sends its weekly window in the primary
  // slot and leaves the secondary null (issue #606).
  const capturedAt = 1_784_914_879;
  expect(mapAppServerRateLimits({
    primary: { usedPercent: 15, resetsAt: capturedAt + 437_631, windowDurationMins: 10_080 },
    secondary: null,
    planType: "pro",
  }, capturedAt)).toEqual({
    session: null,
    weekly: { usedPercent: 15, resetsAt: capturedAt + 437_631, windowMinutes: 10_080 },
    plan: "pro",
    capturedAt,
  });
});

test("a weekly-only transcript event feeds the weekly window of the fallback read", async () => {
  const weeklyOnly = createManagedCodexAccount("Weekly only");
  const session = path.join(weeklyOnly.sessionsDir, "2026", "07", "13", "weekly.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, JSON.stringify({
    timestamp: "2026-07-13T21:04:47.943Z",
    payload: { rate_limits: { primary: { used_percent: 15, window_minutes: 10_080, resets_at: 1_784_574_264 }, secondary: null, plan_type: "pro" } },
  }) + "\n");
  const result = await readCodexLimits({ account: weeklyOnly, liveReader: async () => { throw new Error("offline"); } });
  expect(result.data?.session).toBeNull();
  expect(result.data?.weekly).toMatchObject({ usedPercent: 15, resetsAt: 1_784_574_264, windowMinutes: 10_080 });
});

test("a provider-exhausted transcript window overrides a newer app-server probe", async () => {
  const account = createManagedCodexAccount("Exhausted reconciliation");
  const nowS = Math.floor(Date.now() / 1000);
  const resetsAt = nowS + 6 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "15", "exhausted.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, JSON.stringify({
    timestamp: new Date((nowS - 600) * 1000).toISOString(),
    payload: { rate_limits: { limit_id: "codex", primary: { used_percent: 100, window_minutes: 10_080, resets_at: resetsAt }, secondary: null, plan_type: "prolite" } },
  }) + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly?.usedPercent).toBe(100);
  expect(result.data?.weekly?.resetsAt).toBe(resetsAt);
});

test("usage_limit_exceeded makes the matching transcript window authoritative immediately", async () => {
  const account = createManagedCodexAccount("Rejected reconciliation");
  const nowS = Math.floor(Date.now() / 1000);
  const resetsAt = nowS + 6 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "15", "rejected.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date((nowS - 120) * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: resetsAt }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((nowS - 60) * 1000).toISOString(),
      payload: { type: "task_complete", error: { message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" } },
    }),
  ].join("\n") + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt, observedAt: nowS - 60 });
});

test("usage_limit_exceeded clears an already-expired quota reset", async () => {
  const account = createManagedCodexAccount("Expired reset rejection reconciliation");
  const nowS = Math.floor(Date.now() / 1000);
  const expiredReset = nowS - 300;
  const session = path.join(account.sessionsDir, "2026", "08", "15", "expired-reset-rejected.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date((nowS - 120) * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: expiredReset }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((nowS - 60) * 1000).toISOString(),
      payload: { type: "task_complete", error: { message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" } },
    }),
  ].join("\n") + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt: nowS + 6 * 86_400, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt: null, observedAt: nowS - 60 });
});

test("a cleared-reset exhaustion stops governing once its window length has passed", async () => {
  const account = createManagedCodexAccount("Expired reset rejection lifetime");
  const nowS = Math.floor(Date.now() / 1000);
  const expiredReset = nowS - 300;
  const session = path.join(account.sessionsDir, "2026", "08", "15", "expired-reset-lifetime.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date((nowS - 120) * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: expiredReset }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((nowS - 60) * 1000).toISOString(),
      payload: { type: "task_complete", error: { message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" } },
    }),
  ].join("\n") + "\n");

  // Read a whole weekly window later: the rejection cleared the reset, so the
  // exhaustion it established has no stated end and must not outlive the cycle
  // it was observed in.
  const laterS = nowS + 7 * 86_400;
  const resetsAt = laterS + 6 * 86_400;
  const result = await readCodexLimits({
    account,
    now: () => laterS * 1000,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 21, resetsAt });
  expect(result.source).toBe("live");
});

test("a standalone usage_limit_exceeded event exhausts the live governing window", async () => {
  const account = createManagedCodexAccount("Standalone rejection reconciliation");
  const nowS = Math.floor(Date.now() / 1000);
  const resetsAt = nowS + 6 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "15", "standalone-rejection.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, JSON.stringify({
    timestamp: new Date((nowS - 60) * 1000).toISOString(),
    payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
  }) + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt, observedAt: nowS - 60 });
  expect(result.source).toBe("transcript");
});

test("a standalone rejection exhausts a cached window when the live probe fails", async () => {
  resetLimitsCache();
  const account = createManagedCodexAccount("Cached standalone rejection");
  setActiveCodexAccount(account.id);
  const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
  const resetsAt = nowMs / 1000 + 6 * 86_400;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => claudeUsage()) as unknown as typeof fetch;
  try {
    const first = await readLimits({
      now: () => nowMs,
      codexLiveReader: async () => ({
        primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
        secondary: null,
        planType: "prolite",
      }),
    });
    expect(first.codex?.weekly?.usedPercent).toBe(21);

    const session = path.join(account.sessionsDir, "2026", "08", "15", "cached-standalone-rejection.jsonl");
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, JSON.stringify({
      timestamp: "2026-08-15T12:00:30.000Z",
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }) + "\n");
    const rejected = await readLimits({
      now: () => nowMs + 31_000,
      codexLiveReader: async () => { throw new Error("offline"); },
    });

    expect(rejected.codex?.weekly).toMatchObject({ usedPercent: 100, observedAt: nowMs / 1000 + 30, source: "transcript" });
    expect(rejected.provenance.codex.source).toBe("transcript");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a rejection from a previous cycle never exhausts the live window", async () => {
  const account = createManagedCodexAccount("Previous cycle rejection");
  const nowS = Math.floor(Date.now() / 1000);
  // A weekly window resetting in five days opened two days ago; the rejection
  // predates that start, so the quota it exhausted has already reset.
  const resetsAt = nowS + 5 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "12", "previous-cycle-rejection.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, JSON.stringify({
    timestamp: new Date((nowS - 3 * 86_400) * 1000).toISOString(),
    payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
  }) + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 21, resetsAt });
  expect(result.source).toBe("live");
});

test("a rejection past the transcript window's cycle never exhausts the live probe", async () => {
  const account = createManagedCodexAccount("Rolled-over transcript cycle rejection");
  const nowS = Math.floor(Date.now() / 1000);
  // A 5h window captured four days ago, and a rejection that landed a day after
  // that window's reset — two cycles back — in the same transcript file.
  const capturedAt = nowS - 4 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "11", "rolled-over-cycle.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date(capturedAt * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 40, window_minutes: 300, resets_at: capturedAt + 5 * 3_600 }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((nowS - 3 * 86_400) * 1000).toISOString(),
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }),
  ].join("\n") + "\n");

  const resetsAt = nowS + 3 * 3_600;
  const live = async () => ({
    primary: { usedPercent: 21, resetsAt, windowDurationMins: 300 },
    secondary: null,
    planType: "prolite",
  });
  const result = await readCodexLimits({ account, liveReader: live });

  expect(result.data?.session).toMatchObject({ usedPercent: 21, resetsAt });
  expect(result.source).toBe("live");

  // The same fixture with no probe to reconcile against: the transcript snapshot
  // stands as recorded rather than as an exhaustion synthesized from a rolled
  // cycle.
  const offline = await readCodexLimits({ account, liveReader: async () => { throw new Error("offline"); } });

  expect(offline.data?.session).toMatchObject({ usedPercent: 40, resetsAt: capturedAt + 5 * 3_600 });
});

test("a fresh rejection exhausts the live window when the transcript snapshot is from a rolled cycle", async () => {
  const account = createManagedCodexAccount("Fresh rejection stale transcript");
  const nowS = Math.floor(Date.now() / 1000);
  const capturedAt = nowS - 10 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "05", "stale-snapshot-fresh-rejection.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date(capturedAt * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: capturedAt + 86_400 }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((nowS - 60) * 1000).toISOString(),
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }),
  ].join("\n") + "\n");

  const resetsAt = nowS + 6 * 86_400;
  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt, observedAt: nowS - 60 });
  expect(result.source).toBe("transcript");
});

test("a live cycle that opened after the rejection ends its reset-erased exhaustion", async () => {
  const account = createManagedCodexAccount("Rolled live cycle vs erased reset");
  const nowS = Math.floor(Date.now() / 1000);
  // The transcript's weekly window reset seven days ago and the rejection landed
  // half a day later, so the rejection erases that past reset.
  const snapshotAt = nowS - 8 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "07", "rolled-live-cycle.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date(snapshotAt * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 30, window_minutes: 10_080, resets_at: nowS - 7 * 86_400 }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((nowS - 6.5 * 86_400) * 1000).toISOString(),
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }),
  ].join("\n") + "\n");

  // The live probe's own weekly cycle opened a day ago — proof the cycle the
  // rejection exhausted has rolled, well inside the exhaustion's week-long
  // fallback lifetime.
  const resetsAt = nowS + 6 * 86_400;
  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 21, resetsAt });
  expect(result.source).toBe("live");
});

test("a rejection projected onto cache keeps the failed probe's backoff", async () => {
  resetLimitsCache();
  const account = createManagedCodexAccount("Cached rejection backoff");
  setActiveCodexAccount(account.id);
  const nowMs = Date.parse("2026-08-16T12:00:00.000Z");
  const resetsAt = nowMs / 1000 + 6 * 86_400;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => claudeUsage()) as unknown as typeof fetch;
  try {
    await readLimits({
      now: () => nowMs,
      codexLiveReader: async () => ({
        primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
        secondary: null,
        planType: "prolite",
      }),
    });

    const session = path.join(account.sessionsDir, "2026", "08", "16", "cached-rejection-backoff.jsonl");
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, JSON.stringify({
      timestamp: "2026-08-16T12:00:30.000Z",
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }) + "\n");

    // Serving a projection does not mean the app-server answered: five polls
    // against a hanging initialize must still back off.
    let probes = 0;
    const hanging = async () => {
      probes += 1;
      throw new Error("Codex app-server request timed out: initialize");
    };
    let latest: Awaited<ReturnType<typeof readLimits>> | null = null;
    for (let poll = 1; poll <= 5; poll += 1) {
      latest = await readLimits({ now: () => nowMs + poll * 31_000, codexLiveReader: hanging });
    }

    expect(probes).toBeLessThanOrEqual(2);
    expect(latest?.provenance.codex.retryAt).not.toBeNull();
    expect(latest?.codex?.weekly).toMatchObject({ usedPercent: 100, source: "transcript" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a cached rejection stops being current once the window it exhausted resets", async () => {
  resetLimitsCache();
  const account = createManagedCodexAccount("Cached rejection expiry");
  setActiveCodexAccount(account.id);
  const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  const resetsAt = nowMs / 1000 + 600;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => claudeUsage()) as unknown as typeof fetch;
  try {
    await readLimits({
      now: () => nowMs,
      codexLiveReader: async () => ({
        primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
        secondary: null,
        planType: "prolite",
      }),
    });

    const session = path.join(account.sessionsDir, "2026", "08", "17", "cached-rejection-expiry.jsonl");
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, JSON.stringify({
      timestamp: "2026-08-17T12:05:00.000Z",
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }) + "\n");

    const offline = async () => { throw new Error("offline"); };
    const exhausted = await readLimits({ now: () => nowMs + 6 * 60_000, codexLiveReader: offline });
    expect(exhausted.codex?.weekly).toMatchObject({ usedPercent: 100, resetsAt });
    expect(exhausted.provenance.codex.source).toBe("transcript");

    // Five days on, with the probe still down, that window has long reset: the
    // reading the projection was computed from stands on its own as cache.
    const later = await readLimits({ now: () => nowMs + 5 * 86_400_000, codexLiveReader: offline });

    expect(later.codex?.weekly).toMatchObject({ usedPercent: 21, resetsAt });
    expect(later.provenance.codex.source).toBe("cache");
    expect(later.provenance.codex.staleSince).not.toBeNull();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an elapsed rejection stops governing the offline transcript fallback", async () => {
  const account = createManagedCodexAccount("Elapsed rejection transcript fallback");
  const nowS = Math.floor(Date.now() / 1000);
  // The weekly window reset thirty days ago and the rejection landed an hour
  // after it, so the exhaustion's own week-long lifetime is long over.
  const resetsAt = nowS - 30 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "07", "19", "elapsed-fallback.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date((resetsAt - 3_600) * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: resetsAt }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((resetsAt + 3_600) * 1000).toISOString(),
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }),
  ].join("\n") + "\n");

  const offline = async () => { throw new Error("offline"); };
  const elapsed = await readCodexLimits({ account, liveReader: offline });

  expect(elapsed.data?.weekly).toMatchObject({ usedPercent: 21, resetsAt });
  expect(elapsed.reason).toBe("transcript-fallback");

  // Read while that exhaustion was still running and it governs, as it must.
  const running = await readCodexLimits({ account, now: () => (resetsAt + 7_200) * 1000, liveReader: offline });

  expect(running.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt: null, observedAt: resetsAt + 3_600 });
  expect(running.reason).toBe("transcript-fallback");
});

test("a rejection reconciled during a live poll leaves the live reading in the cache", async () => {
  resetLimitsCache();
  const account = createManagedCodexAccount("Reconciled rejection cache base");
  setActiveCodexAccount(account.id);
  const nowMs = Date.parse("2026-08-19T12:00:00.000Z");
  const resetsAt = nowMs / 1000 + 600;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => claudeUsage()) as unknown as typeof fetch;
  try {
    const session = path.join(account.sessionsDir, "2026", "08", "19", "reconciled-rejection.jsonl");
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, JSON.stringify({
      timestamp: "2026-08-19T11:59:30.000Z",
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }) + "\n");

    const exhausted = await readLimits({
      now: () => nowMs,
      codexLiveReader: async () => ({
        primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
        secondary: null,
        planType: "prolite",
      }),
    });
    expect(exhausted.codex?.weekly).toMatchObject({ usedPercent: 100, resetsAt });
    expect(exhausted.provenance.codex.source).toBe("transcript");

    // Past that reset with the probe down: the live 21% the projection overrode
    // is still the account's last real reading.
    const later = await readLimits({
      now: () => nowMs + 20 * 60_000,
      codexLiveReader: async () => { throw new Error("offline"); },
    });

    expect(later.codex?.weekly).toMatchObject({ usedPercent: 21, resetsAt });
    expect(later.provenance.codex.source).toBe("cache");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a rejection on a window declaring no bounds expires at its canonical horizon", async () => {
  const account = createManagedCodexAccount("Boundless window rejection");
  const nowS = Math.floor(Date.now() / 1000);
  // A legacy transcript event: a used percentage with neither a reset nor a
  // length, so the rejection that follows it has nothing of its own to expire
  // against beyond the 5h horizon the window is filed under.
  const capturedAt = nowS - 400 * 86_400;
  const rejectedAt = capturedAt + 60;
  const session = path.join(account.sessionsDir, "2026", "07", "10", "boundless.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({ timestamp: new Date(capturedAt * 1000).toISOString(), payload: { rate_limits: { primary: { used_percent: 22 } } } }),
    JSON.stringify({ timestamp: new Date(rejectedAt * 1000).toISOString(), payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" } }),
  ].join("\n") + "\n");

  const offline = async () => { throw new Error("offline"); };
  const healthy = async () => ({
    primary: { usedPercent: 7, resetsAt: null, windowDurationMins: 300 },
    secondary: null,
    planType: "prolite",
  });
  const inCycle = () => (rejectedAt + 120) * 1000;
  const expired = () => (rejectedAt + 300 * 60) * 1000;

  // Inside the horizon the exhaustion governs on both paths, as it must.
  expect((await readCodexLimits({ account, now: inCycle, liveReader: offline })).data?.session).toMatchObject({ usedPercent: 100 });
  expect((await readCodexLimits({ account, now: inCycle, liveReader: healthy })).data?.session).toMatchObject({ usedPercent: 100 });

  const stale = await readCodexLimits({ account, now: expired, liveReader: offline });
  expect(stale.data?.session).toMatchObject({ usedPercent: 22 });
  expect(stale.reason).toBe("transcript-fallback");

  const live = await readCodexLimits({ account, now: expired, liveReader: healthy });
  expect(live.data?.session).toMatchObject({ usedPercent: 7 });
  expect(live.source).toBe("live");
});

test("a rejection from a previous cycle leaves a cached window as cached evidence", async () => {
  resetLimitsCache();
  const account = createManagedCodexAccount("Cached previous-cycle rejection");
  setActiveCodexAccount(account.id);
  const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
  const resetsAt = nowMs / 1000 + 5 * 86_400;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => claudeUsage()) as unknown as typeof fetch;
  try {
    const first = await readLimits({
      now: () => nowMs,
      codexLiveReader: async () => ({
        primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
        secondary: null,
        planType: "prolite",
      }),
    });
    expect(first.codex?.weekly?.usedPercent).toBe(21);

    const session = path.join(account.sessionsDir, "2026", "08", "12", "cached-previous-cycle-rejection.jsonl");
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, JSON.stringify({
      timestamp: "2026-08-12T12:00:00.000Z",
      payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
    }) + "\n");
    const rejected = await readLimits({
      now: () => nowMs + 31_000,
      codexLiveReader: async () => { throw new Error("offline"); },
    });

    expect(rejected.codex?.weekly).toMatchObject({ usedPercent: 21, resetsAt });
    expect(rejected.provenance.codex.source).toBe("cache");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a root-envelope usage_limit_exceeded event is authoritative in one transcript file", async () => {
  const account = createManagedCodexAccount("Root-envelope rejection reconciliation");
  const nowS = Math.floor(Date.now() / 1000);
  const resetsAt = nowS + 6 * 86_400;
  const session = path.join(account.sessionsDir, "2026", "08", "15", "root-rejected.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({
      timestamp: new Date((nowS - 120) * 1000).toISOString(),
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: resetsAt }, secondary: null, plan_type: "prolite" } },
    }),
    JSON.stringify({
      timestamp: new Date((nowS - 60) * 1000).toISOString(),
      payload: { type: "task_complete", message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" },
    }),
  ].join("\n") + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt, observedAt: nowS - 60 });
});

test("usage_limit_exceeded carries from the newest transcript file to an older quota event", async () => {
  const account = createManagedCodexAccount("Cross-file rejection reconciliation");
  const nowS = Math.floor(Date.now() / 1000);
  const resetsAt = nowS + 6 * 86_400;
  const quotaFile = path.join(account.sessionsDir, "2026", "08", "14", "quota.jsonl");
  const rejectionFile = path.join(account.sessionsDir, "2026", "08", "15", "rejection.jsonl");
  fs.mkdirSync(path.dirname(quotaFile), { recursive: true });
  fs.mkdirSync(path.dirname(rejectionFile), { recursive: true });
  fs.writeFileSync(quotaFile, JSON.stringify({
    timestamp: new Date((nowS - 120) * 1000).toISOString(),
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: resetsAt }, secondary: null, plan_type: "prolite" } },
  }) + "\n");
  fs.writeFileSync(rejectionFile, JSON.stringify({
    timestamp: new Date((nowS - 60) * 1000).toISOString(),
    payload: { type: "task_complete", message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" },
  }) + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt, observedAt: nowS - 60 });
});

test("transcript reconciliation selects a newer rejection by event time across session directories", async () => {
  const account = createManagedCodexAccount("Global rejection reconciliation");
  const nowS = Math.floor(Date.now() / 1000);
  const resetsAt = nowS + 6 * 86_400;
  const quotaFile = path.join(account.sessionsDir, "2026", "08", "15", "quota.jsonl");
  const rejectionFile = path.join(account.sessionsDir, "2026", "08", "14", "long-running.jsonl");
  fs.mkdirSync(path.dirname(quotaFile), { recursive: true });
  fs.mkdirSync(path.dirname(rejectionFile), { recursive: true });
  fs.writeFileSync(quotaFile, JSON.stringify({
    timestamp: new Date((nowS - 120) * 1000).toISOString(),
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: resetsAt }, secondary: null, plan_type: "prolite" } },
  }) + "\n");
  fs.writeFileSync(rejectionFile, JSON.stringify({
    timestamp: new Date((nowS - 60) * 1000).toISOString(),
    payload: { type: "task_complete", error: { message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" } },
  }) + "\n");

  const result = await readCodexLimits({
    account,
    liveReader: async () => ({
      primary: { usedPercent: 21, resetsAt, windowDurationMins: 10_080 },
      secondary: null,
      planType: "prolite",
    }),
  });

  expect(result.data?.weekly).toMatchObject({ usedPercent: 100, resetsAt, observedAt: nowS - 60 });
});

test("a newer sub-second quota event supersedes an older cross-file rejection", () => {
  const account = createManagedCodexAccount("Sub-second rejection ordering");
  const rejectionFile = path.join(account.sessionsDir, "2026", "08", "14", "rejection.jsonl");
  const quotaFile = path.join(account.sessionsDir, "2026", "08", "15", "quota.jsonl");
  fs.mkdirSync(path.dirname(rejectionFile), { recursive: true });
  fs.mkdirSync(path.dirname(quotaFile), { recursive: true });
  fs.writeFileSync(rejectionFile, JSON.stringify({
    timestamp: "2026-08-15T12:00:00.100Z",
    payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
  }) + "\n");
  fs.writeFileSync(quotaFile, JSON.stringify({
    timestamp: "2026-08-15T12:00:00.400Z",
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: 1_787_000_000 }, secondary: null, plan_type: "prolite" } },
  }) + "\n");

  expect(readCodexTranscriptLimits(account.sessionsDir).data?.weekly).toMatchObject({
    usedPercent: 21,
    observedAt: Date.parse("2026-08-15T12:00:00.400Z") / 1000,
  });
});

test("cross-file quota events retain sub-second ordering", () => {
  const account = createManagedCodexAccount("Sub-second quota ordering");
  const olderFile = path.join(account.sessionsDir, "2026", "08", "15", "older.jsonl");
  const newerFile = path.join(account.sessionsDir, "2026", "08", "14", "newer-long-running.jsonl");
  fs.mkdirSync(path.dirname(olderFile), { recursive: true });
  fs.mkdirSync(path.dirname(newerFile), { recursive: true });
  fs.writeFileSync(olderFile, JSON.stringify({
    timestamp: "2026-08-15T12:00:00.100Z",
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 37, window_minutes: 10_080, resets_at: 1_787_000_000 }, secondary: null, plan_type: "prolite" } },
  }) + "\n");
  fs.writeFileSync(newerFile, JSON.stringify({
    timestamp: "2026-08-15T12:00:00.400Z",
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: 1_787_000_000 }, secondary: null, plan_type: "prolite" } },
  }) + "\n");

  expect(readCodexTranscriptLimits(account.sessionsDir).data?.weekly).toMatchObject({
    usedPercent: 21,
    observedAt: Date.parse("2026-08-15T12:00:00.400Z") / 1000,
  });
});

test("transcript candidate discovery bounds metadata reads in a large session tree", () => {
  const account = createManagedCodexAccount("Bounded transcript candidates");
  for (let day = 1; day <= 40; day += 1) {
    const dir = path.join(account.sessionsDir, "2026", "07", String(day).padStart(2, "0"));
    fs.mkdirSync(dir, { recursive: true });
    for (let file = 0; file < 20; file += 1) {
      fs.writeFileSync(path.join(dir, `rollout-${String(file).padStart(2, "0")}.jsonl`), "{}\n");
    }
  }
  const current = path.join(account.sessionsDir, "2026", "07", "40", "zz-current.jsonl");
  fs.writeFileSync(current, JSON.stringify({
    timestamp: "2026-08-15T12:00:00.400Z",
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: 1_787_000_000 }, secondary: null, plan_type: "prolite" } },
  }) + "\n");

  const realStatSync = fs.statSync.bind(fs);
  let sessionStats = 0;
  const statSync = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target).startsWith(account.sessionsDir)) sessionStats += 1;
    return realStatSync(target, ...args as []);
  }) as typeof fs.statSync);
  try {
    expect(readCodexTranscriptLimits(account.sessionsDir).data?.weekly?.usedPercent).toBe(21);
    expect(sessionStats).toBeLessThanOrEqual(120);
  } finally {
    statSync.mockRestore();
  }
});

test("recent history indexes a long-running rejection beyond the day-bucket bound", async () => {
  const account = createManagedCodexAccount("Indexed long-running rejection");
  const startedAt = Date.parse("2026-06-01T12:00:00.000Z");
  const prefix = startedAt.toString(16).padStart(12, "0");
  const sessionId = `${prefix.slice(0, 8)}-${prefix.slice(8)}-7000-8000-000000000001`;
  const started = new Date(startedAt);
  const oldDir = path.join(
    account.sessionsDir,
    String(started.getFullYear()),
    String(started.getMonth() + 1).padStart(2, "0"),
    String(started.getDate()).padStart(2, "0"),
  );
  const oldFile = path.join(oldDir, `rollout-2026-06-01T12-00-00-${sessionId}.jsonl`);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify({
    timestamp: "2026-08-15T12:00:01.000Z",
    payload: { type: "task_complete", codex_error_info: "usage_limit_exceeded" },
  }) + "\n");
  fs.writeFileSync(path.join(account.home, "history.jsonl"), JSON.stringify({
    session_id: sessionId,
    ts: Date.parse("2026-08-15T12:00:00.900Z") / 1000,
    text: "continue",
  }) + "\n");
  for (let day = 1; day <= 10; day += 1) {
    const dir = path.join(account.sessionsDir, "2026", "08", String(day).padStart(2, "0"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "quota.jsonl"), JSON.stringify({
      timestamp: "2026-08-15T12:00:00.400Z",
      payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 21, window_minutes: 10_080, resets_at: 1_787_000_000 }, secondary: null, plan_type: "prolite" } },
    }) + "\n");
  }

  // The indexed rejection travels on the read, and the consumer that projects
  // it turns the newest quota event into the exhaustion it reports.
  const transcript = readCodexTranscriptLimits(account.sessionsDir);
  expect(transcript.rejectedAt).toBe(Date.parse("2026-08-15T12:00:01.000Z") / 1000);
  expect(transcript.data?.weekly).toMatchObject({ usedPercent: 21 });

  // Read a minute after the rejection, inside the window it exhausted, so the
  // fixture's fixed timestamps decide the outcome rather than the wall clock.
  const result = await readCodexLimits({
    account,
    now: () => Date.parse("2026-08-15T12:01:00.000Z"),
    liveReader: async () => { throw new Error("offline"); },
  });
  expect(result.data?.weekly).toMatchObject({
    usedPercent: 100,
    observedAt: Date.parse("2026-08-15T12:00:01.000Z") / 1000,
  });
});

test("a newer windowless rate-limits event does not mask the account's real windows", async () => {
  // Codex emits `rate_limits` events for other limit families with both windows
  // null; taking the newest line regardless left the account looking windowless.
  const masked = createManagedCodexAccount("Windowless newest");
  const session = path.join(masked.sessionsDir, "2026", "07", "24", "masked.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    JSON.stringify({ timestamp: "2026-07-24T06:00:00.000Z", payload: { rate_limits: { limit_id: "codex", primary: { used_percent: 15, window_minutes: 10_080, resets_at: 1_785_000_000 }, secondary: null, plan_type: "pro" } } }),
    JSON.stringify({ timestamp: "2026-07-24T13:05:43.423Z", payload: { rate_limits: { limit_id: "premium", primary: null, secondary: null, plan_type: null } } }),
  ].join("\n") + "\n");
  const result = await readCodexLimits({ account: masked, liveReader: async () => { throw new Error("offline"); } });
  expect(result.data?.weekly).toMatchObject({ usedPercent: 15, resetsAt: 1_785_000_000, windowMinutes: 10_080 });
  expect(result.data?.plan).toBe("pro");
});

test("managed transcript fallback reports per-engine provenance without account cross-contamination", async () => {
  const fallback = createManagedCodexAccount("Transcript fallback");
  const session = path.join(fallback.sessionsDir, "2026", "07", "10", "fallback.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, JSON.stringify({ timestamp: "2026-07-10T00:00:00.000Z", payload: { rate_limits: { primary: { used_percent: 22 } } } }) + "\n");
  const result = await readCodexLimits({ account: fallback, liveReader: async () => { throw new Error("offline access_token=secret"); } });
  expect(result.data?.session?.usedPercent).toBe(22);
  expect(result.source).toBe("transcript");
  expect(result.reason).toBe("transcript-fallback");
  expect(result.reason).not.toContain("secret");
});

test("readLimits stamps the active account id into the payload and disk cache", async () => {
  // Force Claude offline so the payload is driven purely by Codex transcripts and
  // no real network call is made.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  try {
    // A fresh account with no transcripts: the id must still be stamped even
    // though there is no Codex data and nothing is written to the cache.
    const empty = createManagedCodexAccount("Stamp empty");
    setActiveCodexAccount(empty.id);
    const emptyPayload = await readLimits({ codexLiveReader: async () => { throw new Error("offline"); } });
    expect(emptyPayload.codexAccountId).toBe(empty.id);

    // The legacy account has a rate-limits event, so its payload is remembered:
    // the disk cache must round-trip the account id inside the payload too.
    setActiveCodexAccount("default");
    const payload = await readLimits({ codexLiveReader: async () => { throw new Error("offline"); } });
    expect(payload.codexAccountId).toBe("default");
    const cacheFile = path.join(process.env.LLV_STATE_DIR!, "limits-cache.json");
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { accountId: string; data: { codexAccountId: string } };
    expect(cached.accountId).toBe("default");
    expect(cached.data.codexAccountId).toBe("default");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("readLimits stamps a fresh legacy Codex cache while refreshing Claude", async () => {
  const account = createManagedCodexAccount("Legacy cache");
  setActiveCodexAccount(account.id);
  const cacheFile = path.join(process.env.LLV_STATE_DIR!, "limits-cache.json");
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    at: Date.now(),
    accountId: account.id,
    data: {
      claude: null,
      codex: { session: { usedPercent: 37, resetsAt: null }, weekly: null, plan: "pro", capturedAt: null },
      staleSince: null,
    },
  }));
  delete (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache;

  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("Claude refresh unavailable");
  }) as unknown as typeof fetch;
  try {
    const payload = await readLimits({ codexLiveReader: async () => { throw new Error("offline"); } });
    expect(payload.codexAccountId).toBe(account.id);
    expect(payload.codex?.session?.usedPercent).toBe(37);
    expect(fetchCalled).toBeTrue();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a fresh Claude cache still refreshes missing Codex limits", async () => {
  setActiveCodexAccount("default");
  const legacySession = path.join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "07", "09", "refresh.jsonl");
  fs.mkdirSync(path.dirname(legacySession), { recursive: true });
  fs.writeFileSync(legacySession, JSON.stringify({ timestamp: "2026-07-09T00:00:00.000Z", payload: { rate_limits: { primary: { used_percent: 37 }, plan_type: "pro" } } }) + "\n");
  const cacheFile = path.join(process.env.LLV_STATE_DIR!, "limits-cache.json");
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 2,
    engines: {
      claude: {
        default: {
          at: Date.now(),
          data: { session: { usedPercent: 11, resetsAt: null }, weekly: null, plan: "max", capturedAt: null },
          provenance: { source: "live", reason: null, staleSince: null },
        },
      },
      codex: {},
    },
  }));
  delete (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fresh Claude cache should skip the OAuth request");
  }) as unknown as typeof fetch;
  try {
    const payload = await readLimits({ codexLiveReader: async () => { throw new Error("offline"); } });
    expect(payload.claude?.session?.usedPercent).toBe(11);
    expect(payload.codex?.session?.usedPercent).toBe(37);
    expect(payload.codexAccountId).toBe("default");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("consecutive Claude 429s back off and suppress a third fetch inside the cooldown", async () => {
  resetLimitsCache();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(null, { status: 429 });
  }) as unknown as typeof fetch;
  try {
    const first = await readLimits({ codexLiveReader, now: () => 1_000_000 });
    expect(first.provenance.claude).toMatchObject({ source: "unavailable", reason: "oauth-rate-limited", retryAt: new Date(1_060_000).toISOString() });
    const second = await readLimits({ codexLiveReader, now: () => 1_060_001 });
    expect(second.provenance.claude.retryAt).toBe(new Date(1_180_001).toISOString());
    const third = await readLimits({ codexLiveReader, now: () => 1_120_000 });
    expect(third.provenance.claude).toEqual(second.provenance.claude);
    expect(fetches).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("consecutive Codex initialize timeouts back off exponentially", async () => {
  resetLimitsCache();
  const account = createManagedCodexAccount("Initialize timeout backoff");
  setActiveCodexAccount(account.id);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => claudeUsage()) as unknown as typeof fetch;
  let probes = 0;
  const timedOutProbe = async () => {
    probes += 1;
    throw new Error("Codex app-server request timed out: initialize");
  };
  try {
    const first = await readLimits({ codexLiveReader: timedOutProbe, now: () => 6_000_000 });
    expect(first.provenance.codex).toMatchObject({
      source: "unavailable",
      reason: "app-server-initialize-timeout",
      retryAt: new Date(6_060_000).toISOString(),
    });
    const second = await readLimits({ codexLiveReader: timedOutProbe, now: () => 6_060_001 });
    expect(second.provenance.codex.retryAt).toBe(new Date(6_180_001).toISOString());
    const suppressed = await readLimits({ codexLiveReader: timedOutProbe, now: () => 6_120_000 });
    expect(suppressed.provenance.codex).toEqual(second.provenance.codex);
    expect(probes).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Claude 429 honors Retry-After when it exceeds the exponential delay", async () => {
  resetLimitsCache();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return fetches === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "600" } })
      : claudeUsage();
  }) as unknown as typeof fetch;
  try {
    const limited = await readLimits({ codexLiveReader, now: () => 2_000_000 });
    expect(limited.provenance.claude.retryAt).toBe(new Date(2_600_000).toISOString());
    await readLimits({ codexLiveReader, now: () => 2_300_000 });
    expect(fetches).toBe(1);
    const recovered = await readLimits({ codexLiveReader, now: () => 2_600_001 });
    expect(recovered.provenance.claude).toMatchObject({ source: "live", reason: null, retryAt: null });
    expect(fetches).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Claude 429 preserves an HTTP-date Retry-After deadline across response latency", async () => {
  resetLimitsCache();
  const realFetch = globalThis.fetch;
  let now = 10_000_000;
  let fetches = 0;
  const retryHeader = new Date(10_121_000).toUTCString();
  const retryAt = Date.parse(retryHeader);
  globalThis.fetch = (async () => {
    fetches += 1;
    if (fetches === 1) {
      now = 10_001_500;
      return new Response(null, { status: 429, headers: { "retry-after": retryHeader } });
    }
    return claudeUsage();
  }) as unknown as typeof fetch;
  try {
    const limited = await readLimits({ codexLiveReader, now: () => now });
    expect(limited.provenance.claude.retryAt).toBe(new Date(retryAt).toISOString());
    now = retryAt - 1;
    await readLimits({ codexLiveReader, now: () => now });
    expect(fetches).toBe(1);
    now = retryAt + 1;
    const recovered = await readLimits({ codexLiveReader, now: () => now });
    expect(recovered.provenance.claude.source).toBe("live");
    expect(fetches).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Claude 401 records re-authentication provenance", async () => {
  resetLimitsCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
  try {
    const result = await readLimits({ codexLiveReader, now: () => 3_000_000 });
    expect(result.provenance.claude).toMatchObject({
      source: "unavailable",
      reason: "oauth-reauthentication-required",
      retryAt: new Date(3_060_000).toISOString(),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Claude success resets 429 backoff and preserves the fresh-cache fast path", async () => {
  resetLimitsCache();
  const realFetch = globalThis.fetch;
  const replies = [
    new Response(null, { status: 429 }),
    claudeUsage(21),
    new Response(null, { status: 429 }),
  ];
  let fetches = 0;
  globalThis.fetch = (async () => replies[fetches++]) as unknown as typeof fetch;
  try {
    await readLimits({ codexLiveReader, now: () => 4_000_000 });
    const recovered = await readLimits({ codexLiveReader, now: () => 4_060_001 });
    expect(recovered.claude?.session?.usedPercent).toBe(21);
    await readLimits({ codexLiveReader, now: () => 4_080_000 });
    expect(fetches).toBe(2);
    const limitedAgain = await readLimits({ codexLiveReader, now: () => 4_090_002 });
    expect(limitedAgain.provenance.claude.retryAt).toBe(new Date(4_150_002).toISOString());
    expect(fetches).toBe(3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("concurrent Claude refreshes share one provider request at each retry boundary", async () => {
  resetLimitsCache();
  const realFetch = globalThis.fetch;
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };
  let response = deferred<Response>();
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return response.promise;
  }) as unknown as typeof fetch;
  try {
    const firstWave = Array.from({ length: 6 }, () => readLimits({ codexLiveReader, now: () => 5_000_000 }));
    expect(fetches).toBe(1);
    response.resolve(new Response(null, { status: 429 }));
    const firstResults = await Promise.all(firstWave);
    expect(firstResults.every((result) => result.provenance.claude.retryAt === new Date(5_060_000).toISOString())).toBeTrue();

    response = deferred<Response>();
    const secondWave = Array.from({ length: 6 }, () => readLimits({ codexLiveReader, now: () => 5_060_001 }));
    expect(fetches).toBe(2);
    response.resolve(new Response(null, { status: 429 }));
    const secondResults = await Promise.all(secondWave);
    expect(secondResults.every((result) => result.provenance.claude.retryAt === new Date(5_180_001).toISOString())).toBeTrue();

    await readLimits({ codexLiveReader, now: () => 5_120_000 });
    expect(fetches).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a weekly-only Codex account charts its weekly window and names the missing 5h one", async () => {
  // The production shape behind issue #606: the provider reports a single
  // 10080-minute window in the primary slot. The weekly chart must draw from
  // the transcript backfill plus the live value, and the 5h tab must say the
  // plan reports no such window instead of "no history yet".
  resetLimitsCache();
  const account = createManagedCodexAccount("Weekly burndown");
  setActiveCodexAccount(account.id);
  const nowS = Math.round(Date.now() / 1000);
  const resetsAt = nowS + 2 * 86_400;
  const event = (agoS: number, usedPercent: number) => JSON.stringify({
    timestamp: new Date((nowS - agoS) * 1000).toISOString(),
    payload: { rate_limits: { primary: { used_percent: usedPercent, window_minutes: 10_080, resets_at: resetsAt }, secondary: null, plan_type: "pro" } },
  });
  const transcript = path.join(account.sessionsDir, "2026", "07", "20", "weekly-burndown.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [event(7_200, 30), event(3_600, 45)].join("\n") + "\n");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  try {
    const burndown = await readBurndown({
      codexLiveReader: async () => ({
        primary: { usedPercent: 52, resetsAt, windowDurationMins: 10_080 },
        secondary: null,
        planType: "pro",
      }),
    });
    expect(burndown.codexAccountId).toBe(account.id);
    const weekly = burndown.codex!.weekly;
    expect(weekly.samples.map((sample) => sample.remaining)).toEqual([70, 55, 48]);
    expect(weekly.windowSeconds).toBe(10_080 * 60);
    expect(weekly.resetsAt).toBe(resetsAt);
    expect(weekly.windowUnreported).toBeFalsy();

    const session = burndown.codex!.session;
    expect(session.samples).toEqual([]);
    expect(session.windowUnreported).toBeTrue();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a snapshot with no windows at all charts the forward history and claims nothing about horizons", async () => {
  // Codex answers with a windowless snapshot for limit families that carry no
  // quota window (both slots null). That is not evidence that a horizon is
  // unreported: the recorded poll history must still chart, and neither tab may
  // claim the plan has no such window.
  resetLimitsCache();
  const account = createManagedCodexAccount("Windowless snapshot");
  setActiveCodexAccount(account.id);
  const nowS = Math.round(Date.now() / 1000);
  const weekly = (usedPercent: number) => ({ session: null, weekly: { usedPercent, resetsAt: nowS + 2 * 86_400, windowMinutes: 10_080 }, plan: "pro", capturedAt: nowS });
  recordLimitSample("codex", account.id, weekly(30), (nowS - 7_200) * 1000);
  recordLimitSample("codex", account.id, weekly(45), (nowS - 3_600) * 1000);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  try {
    const burndown = await readBurndown({
      codexLiveReader: async () => ({ primary: null, secondary: null, planType: "pro" }),
    });
    expect(burndown.codex!.weekly.samples.map((sample) => sample.remaining)).toEqual([70, 55]);
    expect(burndown.codex!.weekly.windowUnreported).toBeFalsy();
    expect(burndown.codex!.session.windowUnreported).toBeFalsy();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a transcript left with only windowless events reports no snapshot rather than an empty one", async () => {
  const account = createManagedCodexAccount("Windowless transcript");
  const nowS = Math.round(Date.now() / 1000);
  const transcript = path.join(account.sessionsDir, "2026", "07", "24", "windowless.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({ timestamp: new Date((nowS - 1_800) * 1000).toISOString(), payload: { rate_limits: { limit_id: "premium", primary: null, secondary: null, plan_type: null } } }),
    JSON.stringify({ timestamp: new Date((nowS - 600) * 1000).toISOString(), payload: { rate_limits: { limit_id: "premium", primary: null, secondary: null, plan_type: null } } }),
  ].join("\n") + "\n");
  const result = await readCodexLimits({ account, liveReader: async () => { throw new Error("offline"); } });
  expect(result.data).toBeNull();
  expect(result.source).toBe("unavailable");
});
