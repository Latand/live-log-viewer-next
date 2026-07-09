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
const { mapAppServerRateLimits, readCodexLimits } = await import("./limits");

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
