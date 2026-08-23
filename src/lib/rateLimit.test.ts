import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { EngineLimits, FileEntry } from "@/lib/types";

import { projectRateLimitReadModel, quotaAsEngineLimits, quotaReadingFromAccountLimits, quotaReadingFromEngineLimits, rateLimitFromQuotaObservation, reconcileQuotaReadings } from "./rateLimit";

const NOW = new Date("2026-07-10T16:00:00.000Z").getTime();
const RESET = Math.floor(NOW / 1000) + 7_200;

function quota(usedPercent: number, capturedAt: number): EngineLimits {
  return {
    session: null,
    weekly: { usedPercent, resetsAt: RESET + 86_400, windowMinutes: 10_080 },
    plan: "pro-lite",
    capturedAt,
  };
}

test("same-account quota conflicts resolve each window to the fresher source", () => {
  const reconciled = reconcileQuotaReadings(
    { limits: quota(21, 1_000), observedAt: 1_000, stale: false, source: "transcript" },
    { limits: quota(64, 2_000), observedAt: 2_000, stale: false, source: "account" },
    2_100,
  );

  expect(reconciled.weekly).toMatchObject({
    value: { usedPercent: 64 },
    observedAt: 2_000,
    source: "account",
  });
  expect(quotaAsEngineLimits(reconciled)?.weekly).toMatchObject({ observedAt: 2_000 });
});

test("mixed window provenance survives the EngineLimits serialization seam", () => {
  const reconciled = reconcileQuotaReadings(
    {
      limits: {
        session: { usedPercent: 10, resetsAt: RESET, windowMinutes: 300 },
        weekly: null,
        plan: "pro-lite",
        capturedAt: 2_000,
      },
      observedAt: 2_000,
      stale: false,
      source: "live",
    },
    {
      limits: {
        session: null,
        weekly: { usedPercent: 100, resetsAt: RESET + 86_400, windowMinutes: 10_080 },
        plan: "pro-lite",
        capturedAt: 1_000,
      },
      observedAt: 1_000,
      stale: false,
      source: "transcript",
    },
    2_100,
  );
  const serialized = quotaAsEngineLimits(reconciled);

  expect(serialized?.session).toMatchObject({ source: "live" });
  expect(serialized?.weekly).toMatchObject({ source: "transcript" });
  const roundTrip = reconcileQuotaReadings(
    quotaReadingFromEngineLimits(serialized, { source: "transcript", reason: "mixed", staleSince: null }, 2_100),
    null,
    2_100,
  );
  expect(roundTrip.session?.source).toBe("live");
  expect(roundTrip.weekly?.source).toBe("transcript");
});

test("an account window uses its own observation time ahead of snapshot checkedAt", () => {
  const account = quotaReadingFromAccountLimits({
    freshness: "fresh",
    session: null,
    weekly: { usedPercent: 64, resetsAt: RESET + 86_400, windowMinutes: 10_080, observedAt: 1_000 },
    checkedAt: "1970-01-01T00:33:20.000Z",
  });
  const reconciled = reconcileQuotaReadings(
    { limits: quota(21, 1_500), observedAt: 1_500, stale: false, source: "transcript" },
    account,
    2_100,
  );

  expect(reconciled.weekly).toMatchObject({ value: { usedPercent: 21 }, observedAt: 1_500, source: "transcript" });
});

test("an active provider exhaustion overrides a newer non-exhausted probe", () => {
  const reconciled = reconcileQuotaReadings(
    { limits: quota(100, 1_000), observedAt: 1_000, stale: false, source: "transcript" },
    { limits: quota(21, 2_000), observedAt: 2_000, stale: false, source: "account" },
    2_100,
  );

  expect(reconciled.weekly).toMatchObject({
    value: { usedPercent: 100 },
    observedAt: 1_000,
    source: "transcript",
  });
});

test("an exhausted observation stops governing after its reset", () => {
  const expired = quota(100, 1_000);
  expired.weekly = { ...expired.weekly!, resetsAt: 2_000 };
  const reconciled = reconcileQuotaReadings(
    { limits: expired, observedAt: 1_000, stale: false, source: "transcript" },
    { limits: quota(21, 2_100), observedAt: 2_100, stale: false, source: "account" },
    2_100,
  );

  expect(reconciled.weekly?.value.usedPercent).toBe(21);
});

test("a cached payload keeps its original stale-since observation time", () => {
  const limits = quota(40, 0);
  limits.capturedAt = null;
  const reading = quotaReadingFromEngineLimits(limits, {
    source: "cache",
    reason: "provider unavailable",
    staleSince: "1970-01-01T00:16:40.000Z",
  }, 3_000);
  const reconciled = reconcileQuotaReadings(reading, null, 3_000);

  expect(reconciled.weekly).toMatchObject({ observedAt: 1_000, stale: true });
});

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/sessions/implementer.jsonl",
    root: "codex-sessions",
    name: "implementer.jsonl",
    project: "demo",
    title: "Implementer",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: NOW / 1000 - 60,
    size: 10,
    activity: "live",
    proc: "running",
    pid: 42,
    model: "gpt-5.6",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function flow(): Flow {
  const role = { engine: "codex" as const, model: null, effort: null };
  return {
    id: "flow-1",
    template: "implement-review-loop",
    project: "demo",
    cwd: "/repo",
    implementerPath: "/sessions/implementer.jsonl",
    implementerConversationId: "conversation_impl",
    roles: { implementer: role, reviewer: role },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "waiting_ready",
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-10T15:00:00.000Z",
    closedAt: null,
  };
}

function observation(usedPercent: number, observedAt = NOW) {
  const iso = new Date(observedAt).toISOString();
  return {
    engine: "codex" as const,
    accountId: "main",
    authenticated: true,
    authCheckedAt: iso,
    limits: {
      session: { usedPercent, resetsAt: RESET },
      weekly: { usedPercent: 35, resetsAt: RESET + 86_400 },
      plan: "pro",
      capturedAt: Math.floor(observedAt / 1000),
    },
    provenance: { source: "live" as const, reason: null, staleSince: null },
    observedAt: iso,
    bootId: "boot-1",
  };
}

test("fresh exhausted account limits become a structured rate-limit signal", () => {
  expect(rateLimitFromQuotaObservation(observation(100), NOW)).toEqual({
    source: "account",
    accountId: "main",
    window: "session",
    resetAt: RESET,
  });
  expect(rateLimitFromQuotaObservation(observation(99), NOW)).toBeNull();
  expect(rateLimitFromQuotaObservation(observation(100, NOW - 10 * 60_000), NOW)).toBeNull();
  expect(rateLimitFromQuotaObservation({
    ...observation(100),
    limits: {
      ...observation(100).limits,
      session: { usedPercent: 100, resetsAt: Math.floor(NOW / 1000) - 1 },
    },
  }, NOW)).toBeNull();
});

test("an unknown exhausted-window reset suppresses a misleading badge time", () => {
  const limited = observation(100);
  expect(rateLimitFromQuotaObservation({
    ...limited,
    limits: {
      ...limited.limits,
      weekly: { usedPercent: 100, resetsAt: null },
    },
  }, NOW)).toMatchObject({
    source: "account",
    accountId: "main",
    window: "weekly",
    resetAt: null,
  });
});

test("reviewer-side flow work keeps its own state while the implementer account is exhausted", () => {
  const reviewing = { ...flow(), state: "reviewing" as const };
  const snapshot = {
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: [{ path: "/sessions/implementer.jsonl", accountId: "main" }],
      },
    },
    quotaObservations: { claude: {}, codex: { main: observation(100) } },
  };

  expect(projectRateLimitReadModel([entry()], [reviewing], snapshot, NOW).flows[0]?.block).toBeUndefined();
});

test("the files read model joins account exhaustion to a live conversation and its flow", () => {
  const snapshot = {
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: [{ path: "/sessions/implementer.jsonl", accountId: "main" }],
      },
    },
    quotaObservations: { claude: {}, codex: { main: observation(100) } },
  };

  const projected = projectRateLimitReadModel([entry()], [flow()], snapshot, NOW);

  expect(projected.files[0]?.rateLimit).toEqual({
    source: "account",
    accountId: "main",
    window: "session",
    resetAt: RESET,
  });
  expect(projected.flows[0]?.block).toEqual({
    reason: "rate_limited",
    conversationId: "conversation_impl",
    accountId: "main",
    resetAt: RESET,
  });
});

test("the files read model projects request throttling as an account scheduled wait", () => {
  const accountId = "account-a";
  const retryAtMs = NOW + 5 * 60_000;
  const snapshot = {
    entries: {
      "codex:provider-throttled": {
        artifactPath: "/sessions/implementer.jsonl",
        accountId,
        status: "live",
      },
    },
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: [{ path: "/sessions/implementer.jsonl", accountId }],
      },
    },
    quotaObservations: { claude: {}, codex: { [accountId]: { ...observation(40), accountId } } },
  };

  const runtime = globalThis as typeof globalThis & { __llvLimitsCache?: unknown };
  const previous = runtime.__llvLimitsCache;
  const projected = (() => {
    runtime.__llvLimitsCache = {
      version: 2,
      engines: {
        claude: {},
        codex: {
          [accountId]: {
            provenance: {
              source: "cache",
              reason: "oauth-rate-limited",
              staleSince: null,
              retryAt: new Date(retryAtMs).toISOString(),
            },
          },
        },
      },
    };
    try {
      return projectRateLimitReadModel([entry({ activity: "stalled" })], [], snapshot, NOW);
    } finally {
      if (previous === undefined) delete runtime.__llvLimitsCache;
      else runtime.__llvLimitsCache = previous;
    }
  })();

  expect(projected.files[0]?.rateLimit).toEqual({
    source: "account",
    accountId,
    window: null,
    resetAt: retryAtMs / 1000,
  });
});

test("a pane signal wins and receives the structured reset time", () => {
  const file = entry({
    rateLimit: { source: "pane", accountId: null, window: null, resetAt: null },
  });
  const snapshot = {
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: [{ path: file.path, accountId: "main" }],
      },
    },
    quotaObservations: { claude: {}, codex: { main: observation(100) } },
  };

  const projected = projectRateLimitReadModel([file], [flow()], snapshot, NOW);

  expect(projected.files[0]?.rateLimit).toEqual({
    source: "pane",
    accountId: "main",
    window: "session",
    resetAt: RESET,
  });
});
