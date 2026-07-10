import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-limits-account-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");

const { createManagedCodexAccount, setActiveCodexAccount } = await import("@/lib/accounts/codex");
const { mapAppServerRateLimits, readCodexLimits, readLimits } = await import("./limits");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("switching to an account without events never reuses another account's Codex limits", async () => {
  const legacySession = path.join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "07", "09", "rollout.jsonl");
  fs.mkdirSync(path.dirname(legacySession), { recursive: true });
  fs.writeFileSync(legacySession, JSON.stringify({ timestamp: "2026-07-09T00:00:00.000Z", payload: { rate_limits: { primary: { used_percent: 37 }, plan_type: "pro" } } }) + "\n");
  expect((await readCodexLimits()).data?.session?.usedPercent).toBe(37);

  const fresh = createManagedCodexAccount("No events");
  setActiveCodexAccount(fresh.id);
  expect(await readCodexLimits({ liveReader: async () => { throw new Error("offline"); } })).toEqual({ data: null, reason: "app-server unavailable: offline; no codex session files", source: "unavailable" });
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
  expect(result.reason).toContain("transcript fallback");
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
    const emptyPayload = await readLimits();
    expect(emptyPayload.codexAccountId).toBe(empty.id);

    // The legacy account has a rate-limits event, so its payload is remembered:
    // the disk cache must round-trip the account id inside the payload too.
    setActiveCodexAccount("default");
    const payload = await readLimits();
    expect(payload.codexAccountId).toBe("default");
    const cacheFile = path.join(process.env.LLV_STATE_DIR!, "limits-cache.json");
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { accountId: string; data: { codexAccountId: string } };
    expect(cached.accountId).toBe("default");
    expect(cached.data.codexAccountId).toBe("default");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("readLimits stamps a fresh legacy disk cache before returning it", async () => {
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
    throw new Error("fresh cache should return before fetch");
  }) as unknown as typeof fetch;
  try {
    const payload = await readLimits();
    expect(payload.codexAccountId).toBe(account.id);
    expect(fetchCalled).toBeFalse();
  } finally {
    globalThis.fetch = realFetch;
  }
});
