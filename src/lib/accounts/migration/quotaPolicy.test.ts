import { describe, expect, test } from "bun:test";

import { chooseAutoBalance, effectiveRemaining } from "./quotaPolicy";
import type { AutoBalancePolicy, MigrationEngine } from "./contracts";

const now = Date.parse("2026-07-10T12:00:00.000Z");
const policy = (): AutoBalancePolicy => ({ enabled: true, revision: 0, cooldownUntil: null, departed: {}, lastOutcome: null, lastTrigger: null, lastCheckAt: null, sustain: null, restartedAt: new Date(now).toISOString() });
const observation = (accountId: string, session: number, weekly: number, source: "live" | "cache" = "live") => ({ engine: "codex" as MigrationEngine, accountId, authenticated: true, limits: { session: { usedPercent: session, resetsAt: null }, weekly: { usedPercent: weekly, resetsAt: null }, plan: null, capturedAt: Math.floor(now / 1000) }, provenance: { source, reason: null, staleSince: null }, observedAt: now });

describe("quota migration policy", () => {
  test("uses the minimum remaining window and deterministic account id tie break", () => {
    expect(effectiveRemaining(observation("a", 20, 90), now)).toEqual({ percent: 10, window: "weekly" });
    const decision = chooseAutoBalance("codex", "a", [observation("a", 80, 90), observation("b-work", 30, 10), observation("c-work", 30, 10)], policy(), now);
    expect(decision?.targetId).toBe("b-work");
    expect(decision?.evidence.sourcePercent).toBe(10);
  });

  test("requires fresh live ownership and obeys strict threshold and hysteresis", () => {
    expect(chooseAutoBalance("codex", "a", [observation("a", 75, 75), observation("b", 74.999, 74.999)], policy(), now)).toBeNull();
    expect(chooseAutoBalance("codex", "a", [observation("a", 80, 80), observation("b", 10, 10, "cache")], policy(), now)).toBeNull();
    const blocked = policy(); blocked.departed.b = new Date(now - 1_000).toISOString();
    expect(chooseAutoBalance("codex", "a", [observation("a", 80, 80), observation("b", 70, 70)], blocked, now)).toBeNull();
  });
});
