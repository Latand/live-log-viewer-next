import { afterAll, expect, test } from "bun:test";
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
const { fetchClaudeLimits, mapAppServerRateLimits, readCodexLimits, readLimits } = await import("./limits");

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
    session: { usedPercent: 12, resetsAt: 100 },
    weekly: { usedPercent: 55, resetsAt: 200 },
    plan: "pro",
    capturedAt: 77,
  });
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
