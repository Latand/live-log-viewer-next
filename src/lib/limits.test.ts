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
const { readCodexLimits } = await import("./limits");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("switching to an account without events never reuses another account's Codex limits", () => {
  const legacySession = path.join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "07", "09", "rollout.jsonl");
  fs.mkdirSync(path.dirname(legacySession), { recursive: true });
  fs.writeFileSync(legacySession, JSON.stringify({ timestamp: "2026-07-09T00:00:00.000Z", payload: { rate_limits: { primary: { used_percent: 37 }, plan_type: "pro" } } }) + "\n");
  expect(readCodexLimits().data?.session?.usedPercent).toBe(37);

  const fresh = createManagedCodexAccount("No events");
  setActiveCodexAccount(fresh.id);
  expect(readCodexLimits()).toEqual({ data: null, reason: "no codex session files" });
});
