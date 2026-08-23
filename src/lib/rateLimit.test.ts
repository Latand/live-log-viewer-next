import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow } from "@/lib/flows/types";
import { identityAlive, livenessProbe } from "@/lib/agent/accountLiveness";
import type { AgentRegistryEntry } from "@/lib/agent/registry";
import type { EngineLimits, FileEntry, LimitsProvenance } from "@/lib/types";

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

type TestLimitsCacheEntry = { provenance: LimitsProvenance };

function withLimitsCaches<T>(
  diskCodex: Record<string, TestLimitsCacheEntry>,
  warmCodex: Record<string, TestLimitsCacheEntry> | null,
  read: () => T,
): T {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rate-limit-cache-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  const runtime = globalThis as typeof globalThis & { __llvLimitsCache?: unknown };
  const previousCache = runtime.__llvLimitsCache;
  process.env.LLV_STATE_DIR = stateDir;
  fs.writeFileSync(path.join(stateDir, "limits-cache.json"), JSON.stringify({
    version: 2,
    engines: { claude: {}, codex: diskCodex },
  }));
  if (warmCodex) {
    runtime.__llvLimitsCache = { version: 2, engines: { claude: {}, codex: warmCodex } };
  } else {
    delete runtime.__llvLimitsCache;
  }

  try {
    return read();
  } finally {
    if (previousCache === undefined) delete runtime.__llvLimitsCache;
    else runtime.__llvLimitsCache = previousCache;
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
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

test("the files read model projects injected cold-cache provenance without quota side effects", () => {
  const accountId = "account-a";
  const retryAt = new Date(NOW + 5 * 60_000).toISOString();
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

  const projected = projectRateLimitReadModel([
      entry({
        activity: "live",
        authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
      }),
    ], [flow()], snapshot, NOW, () => ({
      source: "cache",
      reason: "oauth-rate-limited",
      staleSince: null,
      retryAt,
    }));

  expect(projected.files[0]).toMatchObject({
    activity: "live",
    providerThrottle: { reason: "provider_throttled", retryAt },
  });
  expect(projected.files[0]?.rateLimit).toBeNull();
  expect(projected.flows[0]?.block).toBeUndefined();
});

test("the pure files projection never reads provider provenance implicitly", () => {
  const accountId = "account-a";
  const retryAt = new Date(NOW + 5 * 60_000).toISOString();
  const snapshot = {
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: [{ path: "/sessions/implementer.jsonl", accountId }],
      },
    },
    quotaObservations: { claude: {}, codex: { [accountId]: { ...observation(40), accountId } } },
  };

  const projected = withLimitsCaches({
    [accountId]: {
      provenance: { source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt },
    },
  }, null, () => projectRateLimitReadModel([
      entry({ authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null } }),
    ], [], snapshot, NOW));

  expect(projected.files[0]).not.toHaveProperty("providerThrottle");
});

test("a stale live registry status cannot hide a stalled host behind provider throttle", () => {
  const accountId = "account-a";
  const retryAt = new Date(NOW + 5 * 60_000).toISOString();
  const snapshot = {
    entries: {
      "codex:stale-host": {
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

  const projected = projectRateLimitReadModel(
    [entry({
      activity: "stalled",
      proc: null,
      pid: null,
      authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
    })],
    [],
    snapshot,
    NOW,
    () => ({ source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt }),
  );

  expect(projected.files[0]).not.toHaveProperty("providerThrottle");
  expect(projected.files[0]?.activity).toBe("stalled");
});

test("only an identity-confirmed structured host receives provider throttle projection", () => {
  const accountId = "account-a";
  const retryAt = new Date(NOW + 5 * 60_000).toISOString();
  const structuredEntry = (pathName: string, pid: number, startIdentity: string): AgentRegistryEntry => ({
    key: { engine: "codex", sessionId: `session-${pid}` },
    artifactPath: pathName,
    cwd: "/workspace",
    accountId,
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:owned",
      process: { pid, startIdentity },
      eventCursor: 1,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: "turn-1",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
    updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
  });
  const paths = {
    live: "/sessions/live.jsonl",
    dead: "/sessions/dead.jsonl",
    reused: "/sessions/reused.jsonl",
  };
  const snapshot = {
    entries: {
      live: structuredEntry(paths.live, 501, "start-live"),
      dead: structuredEntry(paths.dead, 502, "start-dead"),
      reused: structuredEntry(paths.reused, 503, "start-original"),
    },
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: Object.values(paths).map((pathName) => ({ path: pathName, accountId })),
      },
    },
    quotaObservations: { claude: {}, codex: { [accountId]: { ...observation(40), accountId } } },
  };
  const probe = livenessProbe({
    now: () => NOW,
    pidAlive: (pid) => pid === 501 || pid === 503,
    processIdentity: (pid) => pid === 501 ? "start-live" : pid === 503 ? "start-replacement" : null,
  });

  const projected = projectRateLimitReadModel(
    Object.values(paths).map((pathName) => entry({
      path: pathName,
      activity: "stalled",
      proc: null,
      pid: null,
      authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
    })),
    [],
    snapshot,
    NOW,
    () => ({ source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt }),
    (registryEntry) => {
      const fullEntry = registryEntry as AgentRegistryEntry;
      return identityAlive(fullEntry.host?.agent, probe)
        || identityAlive(fullEntry.host?.panePid, probe)
        || identityAlive(fullEntry.structuredHost?.process, probe);
    },
  );

  expect(projected.files[0]?.providerThrottle).toEqual({ reason: "provider_throttled", retryAt });
  expect(projected.files[1]).not.toHaveProperty("providerThrottle");
  expect(projected.files[2]).not.toHaveProperty("providerThrottle");
  expect(projected.files.slice(1).every((file) => file.activity === "stalled")).toBeTrue();
});

test("injected throttle provenance remains account-scoped and ignores an expired retry", () => {
  const throttledAccountId = "account-a";
  const healthyAccountId = "account-b";
  const expiredAccountId = "account-expired";
  const retryAt = new Date(NOW + 5 * 60_000).toISOString();
  const expiredRetryAt = new Date(NOW - 60_001).toISOString();
  const paths = {
    throttled: "/sessions/throttled.jsonl",
    healthy: "/sessions/healthy.jsonl",
    expired: "/sessions/expired.jsonl",
  };
  const snapshot = {
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: [
          { path: paths.throttled, accountId: throttledAccountId },
          { path: paths.healthy, accountId: healthyAccountId },
          { path: paths.expired, accountId: expiredAccountId },
        ],
      },
    },
    quotaObservations: {
      claude: {},
      codex: {
        [throttledAccountId]: { ...observation(40), accountId: throttledAccountId },
        [healthyAccountId]: { ...observation(40), accountId: healthyAccountId },
        [expiredAccountId]: { ...observation(40), accountId: expiredAccountId },
      },
    },
  };
  const provenanceByAccount: Record<string, LimitsProvenance | undefined> = {
    [throttledAccountId]: { source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt },
    [healthyAccountId]: { source: "live", reason: null, staleSince: null, retryAt: null },
    [expiredAccountId]: { source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt: expiredRetryAt },
  };
  const projected = projectRateLimitReadModel([
      entry({ path: paths.throttled, authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null } }),
      entry({ path: paths.healthy, authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null } }),
      entry({ path: paths.expired, authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null } }),
    ], [], snapshot, NOW, (_engine, accountId) => provenanceByAccount[accountId] ?? null);

  expect(projected.files[0]?.providerThrottle).toEqual({ reason: "provider_throttled", retryAt });
  expect(projected.files[1]).not.toHaveProperty("providerThrottle");
  expect(projected.files[2]).not.toHaveProperty("providerThrottle");
});

test("the files read model resolves provider provenance once per active account", () => {
  const accountId = "account-a";
  const retryAt = new Date(NOW + 5 * 60_000).toISOString();
  const paths = Array.from({ length: 50 }, (_, index) => `/sessions/worker-${index}.jsonl`);
  const snapshot = {
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: paths.map((sessionPath) => ({ path: sessionPath, accountId })),
      },
    },
    quotaObservations: { claude: {}, codex: { [accountId]: { ...observation(40), accountId } } },
  };
  let lookups = 0;
  const projected = projectRateLimitReadModel(
    paths.map((sessionPath) => entry({
      path: sessionPath,
      authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
    })),
    [],
    snapshot,
    NOW,
    () => {
      lookups += 1;
      return { source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt };
    },
  );

  expect(lookups).toBe(1);
  expect(projected.files).toHaveLength(50);
  expect(projected.files.every((file) => file.providerThrottle?.retryAt === retryAt)).toBeTrue();
});

test("the files read model leaves a settled conversation unchanged under account throttle", () => {
  const accountId = "account-a";
  const retryAt = new Date(NOW + 5 * 60_000).toISOString();
  const snapshot = {
    entries: {
      "codex:provider-throttled": {
        artifactPath: "/sessions/implementer.jsonl",
        accountId,
        status: "idle",
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
  const projected = projectRateLimitReadModel(
    [entry({
      activity: "idle",
      authoritativeTurn: { state: "idle", source: "empty", terminalAt: null },
      proc: null,
      pid: null,
    })],
    [flow()],
    snapshot,
    NOW,
    () => ({ source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt }),
  );

  expect(projected.files[0]).not.toHaveProperty("providerThrottle");
  expect(projected.files[0]?.rateLimit).toBeNull();
  expect(projected.flows[0]?.block).toBeUndefined();
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
