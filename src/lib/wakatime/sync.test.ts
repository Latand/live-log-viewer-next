import { describe, expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";
import { createWakatimeSync, startWakatimeSync, type WakatimeStateV1, type WakatimeSyncDependencies } from "./sync";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const TURN_START = NOW + 1_000;
const TURN_END = NOW + 31_000;
const PATH = "/sessions/current.jsonl";
const TEST_CREDENTIAL = ["fixture", "wakatime", "value"].join("-");

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: PATH,
    root: "codex-sessions",
    name: "current.jsonl",
    project: "fallback-project",
    title: "private title",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: NOW / 1_000,
    size: 123,
    activity: "recent",
    derivationComplete: true,
    proc: "done",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function registrySnapshot(pathname = PATH): RegistryFile {
  return {
    conversations: {
      conversation_test: {
        id: "conversation_test",
        engine: "codex",
        generations: [{
          id: "native",
          path: pathname,
          accountId: null,
          launchProfile: {
            cwd: "/repo",
            model: null,
            effort: null,
            fast: null,
            permissionMode: null,
            readOnly: null,
            allowSubagents: false,
            title: null,
            project: "profile-project",
            parentConversationId: null,
            role: "root",
            goal: null,
            plan: null,
          },
          historyHash: null,
          host: null,
          createdAt: new Date(NOW).toISOString(),
          archivedAt: null,
        }],
        continuityPaths: [],
        abandonedContinuityPaths: [],
        projectOwnership: null,
        migration: null,
        migrationOptOut: null,
        supersededBy: null,
        agentRole: null,
        delegationDepth: null,
        turn: { state: "terminal", source: "lifecycle", terminalAt: new Date(TURN_END).toISOString(), observedAt: new Date(NOW).toISOString() },
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
    },
  } as unknown as RegistryFile;
}

function harness(overrides: Partial<WakatimeSyncDependencies> = {}) {
  let stored: WakatimeStateV1 | null = null;
  const writes: WakatimeStateV1[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean | null>> }> = [];
  const deps: WakatimeSyncDependencies = {
    scan: async () => ({ files: [entry()], complete: true }),
    registrySnapshot,
    recentTurnWindows: () => ({
      windows: [{ startedAt: TURN_START, endedAt: TURN_END }],
      prefixTruncated: false,
      complete: true,
    }),
    readCredential: async () => null,
    readState: async () => stored,
    writeState: async (state) => {
      stored = structuredClone(state);
      writes.push(structuredClone(state));
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { status: 201, headers: new Headers() };
    },
    now: () => NOW,
    random: () => 0.5,
    scheduleInterval: () => ({ unref() {} }),
    scheduleTimeout: () => ({ unref() {} }),
    clearTimer: () => undefined,
    logger: (event, fields) => { logs.push({ event, fields }); },
    ...overrides,
  };
  return { sync: createWakatimeSync(deps), deps, writes, requests, logs, state: () => stored };
}

describe("WakaTime activity sync", () => {
  test("missing credentials keep newly observed work in the durable outbox", async () => {
    const { sync, writes, requests, state } = harness();

    await sync.tick();

    expect(requests).toHaveLength(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(state()?.pending).toHaveLength(2);
    expect(state()?.pending.map((event) => event.heartbeat.time)).toEqual([
      TURN_START / 1_000,
      TURN_END / 1_000,
    ]);
    sync.stop();
  });

  test("maps registry-owned work to opaque heartbeat fields and keeps the credential header-only", async () => {
    const fixtureValue = TEST_CREDENTIAL;
    const { sync, requests, writes, logs } = harness({
      readCredential: async () => ({ value: fixtureValue, sourceStamp: "fixture" }),
    });

    await sync.tick();

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const body = JSON.parse(String(request.init.body)) as Array<Record<string, unknown>>;
    expect(request.url).toBe("https://api.wakatime.com/api/v1/users/current/heartbeats.bulk");
    expect(request.init.redirect).toBe("manual");
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      entity: expect.stringMatching(/^agent-log-viewer\/codex\/[a-f0-9]{16}$/),
      type: "app",
      project: "-repo",
      category: "ai coding",
      time: TURN_START / 1_000,
      ai_session: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(body[1]?.time).toBe(TURN_END / 1_000);
    const headers = new Headers(request.init.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(fixtureValue).toString("base64")}`);
    const publicEvidence = JSON.stringify({ writes, logs, url: request.url, body });
    expect(publicEvidence).not.toContain(fixtureValue);
    expect(publicEvidence).not.toContain(PATH);
    expect(publicEvidence).not.toContain("private title");
    expect(publicEvidence).not.toContain("language");
    expect(publicEvidence).not.toContain("branch");
    sync.stop();
  });

  test("open work accrues deterministic samples without duplicates across ticks or restart", async () => {
    let clock = NOW;
    const first = harness({
      now: () => clock,
      recentTurnWindows: () => ({
        windows: [{ startedAt: NOW, endedAt: null }],
        prefixTruncated: false,
        complete: true,
      }),
    });
    await first.sync.tick();
    clock += 5 * 60_000;
    await first.sync.tick();
    await first.sync.tick();

    expect(first.state()?.pending.map((event) => event.heartbeat.time)).toEqual([
      NOW / 1_000,
      (NOW + 120_000) / 1_000,
      (NOW + 240_000) / 1_000,
    ]);

    const persisted = structuredClone(first.state());
    first.sync.stop();
    const restarted = harness({
      now: () => clock,
      readState: async () => persisted,
      recentTurnWindows: () => ({
        windows: [{ startedAt: NOW, endedAt: null }],
        prefixTruncated: false,
        complete: true,
      }),
    });
    await restarted.sync.tick();
    expect(restarted.state()?.pending).toHaveLength(3);
    restarted.sync.stop();
  });

  test("first enable is forward-only and preserves separate idle gaps between visible turns", async () => {
    const { sync, state } = harness({
      recentTurnWindows: () => ({
        windows: [
          { startedAt: NOW - 120_000, endedAt: NOW - 60_000 },
          { startedAt: NOW - 30_000, endedAt: NOW + 30_000 },
          { startedAt: NOW + 90_000, endedAt: NOW + 120_000 },
        ],
        prefixTruncated: false,
        complete: true,
      }),
    });

    await sync.tick();

    expect(state()?.pending.map((event) => event.heartbeat.time)).toEqual([
      NOW / 1_000,
      (NOW + 30_000) / 1_000,
      (NOW + 90_000) / 1_000,
      (NOW + 120_000) / 1_000,
    ]);
    expect(new Set(state()?.pending.map((event) => event.heartbeat.entity)).size).toBe(2);
    sync.stop();
  });

  test("an archived generation cannot create a second heartbeat stream", async () => {
    const currentPath = "/sessions/rotated.jsonl";
    const snapshot = registrySnapshot(currentPath);
    const conversation = snapshot.conversations.conversation_test!;
    conversation.generations.unshift({ ...conversation.generations[0]!, id: "archived", path: PATH, archivedAt: new Date(NOW).toISOString() });
    const { sync, state } = harness({
      scan: async () => ({ files: [entry(), entry({ path: currentPath, name: "rotated.jsonl" })], complete: true }),
      registrySnapshot: () => snapshot,
    });

    await sync.tick();

    expect(state()?.pending).toHaveLength(2);
    expect(new Set(state()?.pending.map((event) => event.heartbeat.ai_session)).size).toBe(1);
    sync.stop();
  });

  test("a failed durable write prevents an untracked outbound request", async () => {
    const requests: string[] = [];
    const { sync } = harness({
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
      writeState: async () => { throw new Error("disk unavailable"); },
      fetch: async (url) => {
        requests.push(url);
        return { status: 201, headers: new Headers() };
      },
    });

    await sync.tick();

    expect(requests).toHaveLength(0);
    sync.stop();
  });

  for (const scenario of [
    { name: "network failures", status: null, reason: "network" },
    { name: "redirect rate limits", status: 302, reason: "rate_limit" },
    { name: "explicit rate limits", status: 429, reason: "rate_limit" },
    { name: "server failures", status: 503, reason: "server" },
    { name: "unauthorized credentials", status: 401, reason: "auth" },
    { name: "forbidden credentials", status: 403, reason: "auth" },
  ] as const) {
    test(`${scenario.name} retain the batch under durable backoff`, async () => {
      const { sync, state } = harness({
        readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
        fetch: async () => {
          if (scenario.status === null) throw new Error("offline");
          return {
            status: scenario.status,
            headers: new Headers(scenario.status === 429 ? { "Retry-After": "120" } : {}),
          };
        },
      });

      await sync.tick();

      expect(state()?.pending).toHaveLength(2);
      expect(state()?.retry.reason).toBe(scenario.reason);
      expect(state()?.retry.retryAtMs).toBeGreaterThan(NOW);
      if (scenario.status === 429) expect(state()?.retry.retryAtMs).toBeGreaterThanOrEqual(NOW + 120_000);
      sync.stop();
    });
  }

  test("a request timeout retains the batch and records timeout backoff", async () => {
    const { sync, state } = harness({
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
      scheduleTimeout: (callback, delayMs) => {
        if (delayMs === 5_000) callback();
        return { unref() {} };
      },
      fetch: async (_url, init) => {
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
        throw new Error("expected abort");
      },
    });

    await sync.tick();

    expect(state()?.pending).toHaveLength(2);
    expect(state()?.retry.reason).toBe("timeout");
    sync.stop();
  });

  test("durable retry state prevents a restart request loop", async () => {
    const first = harness({
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
      fetch: async () => { throw new Error("offline"); },
    });
    await first.sync.tick();
    const persisted = structuredClone(first.state());
    first.sync.stop();

    const restarted = harness({
      readState: async () => persisted,
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
    });
    await restarted.sync.tick();
    expect(restarted.requests).toHaveLength(0);
    expect(restarted.state()?.retry.reason).toBe("network");
    restarted.sync.stop();
  });

  test("exponential retry jitter stays inside the 15-minute ceiling", async () => {
    let clock = NOW;
    const { sync, state } = harness({
      now: () => clock,
      random: () => 1,
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
      fetch: async () => { throw new Error("offline"); },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sync.tick();
      const retryAt = state()!.retry.retryAtMs;
      expect(retryAt - clock).toBeLessThanOrEqual(15 * 60_000);
      clock = retryAt;
    }
    sync.stop();
  });

  test("a permanent client rejection drops only the attempted batch", async () => {
    const windows = Array.from({ length: 20 }, (_, index) => ({
      startedAt: NOW + index * 60_000,
      endedAt: NOW + index * 60_000 + 10_000,
    }));
    const { sync, state } = harness({
      recentTurnWindows: () => ({ windows, prefixTruncated: false, complete: true }),
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
      fetch: async () => ({ status: 400, headers: new Headers() }),
    });

    await sync.tick();

    expect(state()?.counters.permanentlyRejected).toBe(25);
    expect(state()?.pending).toHaveLength(15);
    sync.stop();
  });

  test("one successful tick acknowledges only its oldest 25-event batch", async () => {
    const windows = Array.from({ length: 20 }, (_, index) => ({
      startedAt: NOW + index * 60_000,
      endedAt: NOW + index * 60_000 + 10_000,
    }));
    const { sync, state, requests } = harness({
      recentTurnWindows: () => ({ windows, prefixTruncated: false, complete: true }),
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
    });

    await sync.tick();

    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]!.init.body))).toHaveLength(25);
    expect(state()?.counters.accepted).toBe(25);
    expect(state()?.pending).toHaveLength(15);
    sync.stop();
  });

  test("replacing a rejected credential closes the auth circuit immediately", async () => {
    let stamp = "first";
    let deliveries = 0;
    const { sync, state } = harness({
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: stamp }),
      fetch: async () => {
        deliveries += 1;
        return { status: deliveries === 1 ? 401 : 201, headers: new Headers() };
      },
    });
    await sync.tick();
    expect(state()?.retry.reason).toBe("auth");

    stamp = "replacement";
    await sync.tick();

    expect(deliveries).toBe(2);
    expect(state()?.retry.reason).toBeNull();
    expect(state()?.pending).toHaveLength(0);
    sync.stop();
  });

  test("corrupt state recovers at the current privacy boundary without leaking input", async () => {
    const { sync, state, writes, logs } = harness({
      readState: async () => ({ version: 99, credential: "should-stay-private" }),
    });

    await sync.tick();

    expect(state()?.enabledAtMs).toBe(NOW);
    expect(logs.map((item) => item.event)).toContain("corrupt_state_recovered");
    expect(JSON.stringify({ writes, logs })).not.toContain("should-stay-private");
    sync.stop();
  });

  test("cross-field outbox corruption is rejected before delivery", async () => {
    const seeded = harness();
    await seeded.sync.tick();
    const tampered = structuredClone(seeded.state())!;
    tampered.pending[0]!.heartbeat.project = "tampered-project";
    seeded.sync.stop();

    const restarted = harness({
      scan: async () => ({ files: [], complete: true }),
      readState: async () => tampered,
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
    });
    await restarted.sync.tick();
    expect(restarted.requests).toHaveLength(0);
    expect(restarted.state()?.pending).toHaveLength(0);
    expect(restarted.logs.map((item) => item.event)).toContain("corrupt_state_recovered");
    restarted.sync.stop();
  });

  test("overflow compaction stays bounded while retaining stream endpoints", async () => {
    let clock = NOW;
    const { sync, state } = harness({
      now: () => clock,
      limits: { maxPending: 20 },
      recentTurnWindows: () => ({
        windows: [{ startedAt: NOW, endedAt: null }],
        prefixTruncated: false,
        complete: true,
      }),
    });
    await sync.tick();
    clock += 2 * 60 * 60_000;
    await sync.tick();

    const times = state()!.pending.map((event) => event.heartbeat.time * 1_000);
    expect(times.length).toBeLessThanOrEqual(20);
    expect(times[0]).toBe(NOW);
    expect(times.at(-1)).toBe(clock);
    expect(times.slice(1).every((time, index) => time - times[index]! <= 10 * 60_000)).toBe(true);
    expect(state()?.counters.compacted).toBeGreaterThan(0);
    sync.stop();
  });

  test("stream retention evicts whole oldest streams at the configured bound", async () => {
    const windows = [0, 60_000, 120_000].map((offset) => ({
      startedAt: NOW + offset,
      endedAt: NOW + offset + 10_000,
    }));
    const { sync, state } = harness({
      limits: { maxStreams: 2 },
      recentTurnWindows: () => ({ windows, prefixTruncated: false, complete: true }),
    });

    await sync.tick();

    expect(Object.keys(state()!.streams)).toHaveLength(2);
    expect(state()?.pending).toHaveLength(4);
    expect(state()?.counters.dropped).toBe(2);
    sync.stop();
  });

  test("a pruned delivered stream cannot be rediscovered from an old transcript tail", async () => {
    let clock = NOW;
    const fixture = harness({
      now: () => clock,
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
    });
    await fixture.sync.tick();
    expect(fixture.requests).toHaveLength(1);

    clock += 31 * 24 * 60 * 60_000;
    await fixture.sync.tick();
    await fixture.sync.tick();

    expect(fixture.requests).toHaveLength(1);
    expect(fixture.state()?.pending).toHaveLength(0);
    expect(Object.keys(fixture.state()!.streams)).toHaveLength(0);
    fixture.sync.stop();
  });

  test("overlapping ticks coalesce to one running cycle and one trailing cycle", async () => {
    let scanCalls = 0;
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    let markSecondEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const secondEntered = new Promise<void>((resolve) => { markSecondEntered = resolve; });
    const { sync } = harness({
      scan: async () => {
        scanCalls += 1;
        if (scanCalls === 1) {
          markFirstEntered();
          await firstGate;
        } else if (scanCalls === 2) markSecondEntered();
        return { files: [entry()], complete: true };
      },
    });

    const first = sync.tick();
    await firstEntered;
    const second = sync.tick();
    void sync.tick();
    releaseFirst();
    await Promise.all([first, second]);
    await secondEntered;
    expect(scanCalls).toBe(2);
    sync.stop();
  });

  test("shutdown clears timers and aborts an in-flight delivery", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let aborted = false;
    const { sync } = harness({
      readCredential: async () => ({ value: TEST_CREDENTIAL, sourceStamp: "fixture" }),
      fetch: async (_url, init) => {
        markStarted();
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    });

    const ticking = sync.tick();
    await started;
    sync.stop();
    await ticking;
    expect(aborted).toBe(true);
  });

  test("singleton startup schedules one unrefed initial tick and interval", () => {
    let unrefs = 0;
    const fixture = harness({
      scheduleInterval: () => ({ unref() { unrefs += 1; } }),
      scheduleTimeout: () => ({ unref() { unrefs += 1; } }),
    });
    fixture.sync.stop();
    unrefs = 0;
    const globalSync = globalThis as typeof globalThis & { __llvWakatimeSync?: { stop(): void } };
    const currentGlobalSync = () => globalSync.__llvWakatimeSync;
    currentGlobalSync()?.stop();
    delete globalSync.__llvWakatimeSync;
    try {
      startWakatimeSync(fixture.deps);
      startWakatimeSync(fixture.deps);
      expect(unrefs).toBe(2);
    } finally {
      currentGlobalSync()?.stop();
      delete globalSync.__llvWakatimeSync;
    }
  });
});
