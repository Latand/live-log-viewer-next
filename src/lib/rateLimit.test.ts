import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { projectRateLimitReadModel, rateLimitFromQuotaObservation } from "./rateLimit";

const NOW = new Date("2026-07-10T16:00:00.000Z").getTime();
const RESET = Math.floor(NOW / 1000) + 7_200;

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
