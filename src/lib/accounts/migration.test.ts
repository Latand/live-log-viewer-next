import { describe, expect, test } from "bun:test";

import type { ConversationMigration } from "@/lib/types";

import {
  autoBalanceLine,
  bannerModel,
  cardMigrationState,
  migrationFreezesControls,
  migrationHoldsSends,
  parseAutoBalance,
  parseEffective,
  parseEngineMigration,
  parseMigrationPreview,
  postSessionMigration,
  type AutoBalance,
  type EngineMigration,
} from "./migration";

const migration = (phase: string): ConversationMigration => ({
  intentId: "i1",
  trigger: "manual",
  phase,
  targetAccountId: "work",
  failure: null,
});

describe("cardMigrationState", () => {
  test("collapses raw phases to the four visible states", () => {
    expect(cardMigrationState(migration("waiting-turn"))).toBe("pending");
    expect(cardMigrationState(migration("requested"))).toBe("switching");
    expect(cardMigrationState(migration("preparing"))).toBe("switching");
    expect(cardMigrationState(migration("successor-starting"))).toBe("switching");
    expect(cardMigrationState(migration("verifying"))).toBe("switching");
    expect(cardMigrationState(migration("committed"))).toBe("done");
    expect(cardMigrationState(migration("failed-recoverable"))).toBe("failed");
    expect(cardMigrationState(migration("rolled-back"))).toBe("rolled-back");
  });

  test("returns null for no annotation or an unknown phase", () => {
    expect(cardMigrationState(null)).toBeNull();
    expect(cardMigrationState(undefined)).toBeNull();
    expect(cardMigrationState(migration("some-future-phase"))).toBeNull();
  });

  test("only switching freezes controls and holds sends", () => {
    expect(migrationFreezesControls("switching")).toBeTrue();
    expect(migrationFreezesControls("pending")).toBeFalse();
    expect(migrationHoldsSends("switching")).toBeTrue();
    expect(migrationHoldsSends("failed")).toBeFalse();
    expect(migrationHoldsSends(null)).toBeFalse();
  });
});

describe("bannerModel", () => {
  const engine = (over: Partial<EngineMigration> = {}): EngineMigration => ({
    intentId: "i1",
    targetId: "work",
    targetLabel: "Work",
    revision: 3,
    origin: "manual",
    reason: null,
    state: "draining",
    counts: { done: 2, waitingTurn: 1, inFlight: 1, failed: 0, total: 4 },
    startedAt: "2026-07-10T04:00:00.000Z",
    ...over,
  });

  test("null migration yields no banner", () => {
    expect(bannerModel(null)).toBeNull();
  });

  test("projects counts, auto tag, and completion", () => {
    expect(bannerModel(engine())).toMatchObject({ targetLabel: "Work", done: 2, total: 4, waitingTurn: 1, failed: 0, auto: false, complete: false });
    expect(bannerModel(engine({ origin: "auto", reason: { window: "session", fromPercent: 12, toPercent: 64 } }))?.auto).toBeTrue();
    expect(bannerModel(engine({ state: "complete" }))?.complete).toBeTrue();
  });
});

describe("autoBalanceLine", () => {
  const now = Date.parse("2026-07-10T14:32:00.000Z");
  const base = (over: Partial<AutoBalance> = {}): AutoBalance => ({
    enabled: true,
    thresholdPercent: 25,
    state: "idle",
    cooldownUntil: null,
    lastCheckAt: null,
    lastOutcome: null,
    ...over,
  });

  test("hidden when disabled or not enabled", () => {
    expect(autoBalanceLine(null, now, "en").kind).toBe("hidden");
    expect(autoBalanceLine(base({ enabled: false, state: "disabled" }), now, "en").kind).toBe("hidden");
  });

  test("draining and waiting-fresh states", () => {
    expect(autoBalanceLine(base({ state: "draining" }), now, "en").kind).toBe("draining");
    expect(autoBalanceLine(base({ state: "waiting-fresh" }), now, "en").kind).toBe("waitingFresh");
  });

  test("cooldown rounds up remaining minutes", () => {
    const line = autoBalanceLine(base({ state: "cooldown", cooldownUntil: new Date(now + 5.2 * 60_000).toISOString() }), now, "en");
    expect(line.kind).toBe("cooldown");
    expect(line.params.n).toBe(6);
  });

  test("a recorded switch outcome explains the last migration", () => {
    const line = autoBalanceLine(
      base({ state: "idle", lastOutcome: { at: "2026-07-10T14:32:00.000Z", kind: "switched", fromId: "main", fromPercent: 12.4, toId: "work", toPercent: 64, window: "session", detail: null } }),
      now,
      "en",
    );
    expect(line.kind).toBe("switched");
    expect(line.params).toMatchObject({ to: "work", from: "main", pct: 12, window: "session" });
  });

  test("idle with a last check", () => {
    const line = autoBalanceLine(base({ state: "idle", lastCheckAt: "2026-07-10T14:32:00.000Z" }), now, "en");
    expect(line.kind).toBe("idle");
    expect(typeof line.params.time).toBe("string");
  });
});

describe("tolerant parsers", () => {
  test("parseEngineMigration requires intent + target, defaults the rest", () => {
    expect(parseEngineMigration(null)).toBeNull();
    expect(parseEngineMigration({ intentId: "i1" })).toBeNull();
    expect(parseEngineMigration({ intentId: "i1", targetId: "work" })).toMatchObject({
      targetLabel: "work",
      origin: "manual",
      state: "draining",
      counts: { done: 0, total: 0 },
    });
    expect(parseEngineMigration({ intentId: "i1", targetId: "work", origin: "auto", state: "complete", counts: { done: 3, total: 3 }, reason: { window: "weekly", fromPercent: 8, toPercent: 40 } })).toMatchObject({
      origin: "auto",
      state: "complete",
      reason: { window: "weekly", fromPercent: 8, toPercent: 40 },
    });
  });

  test("parseAutoBalance needs a boolean enabled and coerces state", () => {
    expect(parseAutoBalance({})).toBeNull();
    expect(parseAutoBalance({ enabled: false })).toMatchObject({ enabled: false, state: "disabled", thresholdPercent: 25 });
    expect(parseAutoBalance({ enabled: true, state: "cooldown", cooldownUntil: "2026-07-10T15:00:00.000Z" })).toMatchObject({ enabled: true, state: "cooldown" });
    expect(parseAutoBalance({ enabled: true, state: "bogus" })?.state).toBe("idle");
  });

  test("parseEffective validates the percent and window", () => {
    expect(parseEffective({ window: "session" })).toBeNull();
    expect(parseEffective({ percent: 42, window: "weekly", freshness: "fresh" })).toEqual({ percent: 42, window: "weekly", freshness: "fresh" });
    expect(parseEffective({ percent: 42, window: "nonsense", freshness: "nonsense" })).toEqual({ percent: 42, window: "session", freshness: "unavailable" });
  });

  test("parseMigrationPreview reads targetId from top level or nested intent", () => {
    expect(parseMigrationPreview({ targetId: "work", counts: { total: 3, idle: 2 }, rootWarning: true, previewRevision: 7 })).toMatchObject({ targetId: "work", rootWarning: true, previewRevision: 7 });
    expect(parseMigrationPreview({ intent: { targetId: "work" }, revision: 2 })).toMatchObject({ targetId: "work", previewRevision: 2 });
    expect(parseMigrationPreview({})).toBeNull();
  });
});

test("session recovery consumer uses the frozen conversation migration route", async () => {
  const original = globalThis.fetch;
  let request: { url: string; method: string; body: unknown } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    expect(await postSessionMigration("conversation_abc", "retry", 7)).toBeTrue();
    expect(request as unknown).toEqual({
      url: "/api/conversations/conversation_abc/migration",
      method: "POST",
      body: { action: "retry", expectedRevision: 7 },
    });
  } finally {
    globalThis.fetch = original;
  }
});
