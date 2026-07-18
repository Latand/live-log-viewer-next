import { beforeEach, describe, expect, test } from "bun:test";

import type { RuntimeSnapshot } from "@/components/runtime/runtimeModel";

import { createRuntimeBus, type EventSourceLike, type FetchLike, type RuntimeBus, type RuntimeBusDeps } from "./runtimeBus";

/* ---------------------------- fakes ---------------------------- */

class FakeEventSource implements EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => void) | null = null;
  onerror: ((this: unknown, ev: unknown) => void) | null = null;
  onmessage: ((this: unknown, ev: { data: string; lastEventId?: string }) => void) | null = null;
  listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
  closed = false;
  constructor(public url: string) {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    (this.listeners[type] ||= []).push(listener);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(null);
  }
  message(env: unknown): void {
    this.onmessage?.({ data: JSON.stringify(env) });
  }
  named(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) });
  }
  error(): void {
    this.onerror?.(null);
  }
}

interface Clock {
  now: () => number;
  setTimeout: RuntimeBusDeps["setTimeout"];
  clearTimeout: RuntimeBusDeps["clearTimeout"];
  setInterval: RuntimeBusDeps["setInterval"];
  clearInterval: RuntimeBusDeps["clearInterval"];
  advance: (ms: number) => void;
}

function makeClock(): Clock {
  let t = 0;
  let id = 0;
  const timeouts = new Map<number, { due: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const i = ++id;
      timeouts.set(i, { due: t + ms, fn });
      return i as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle as unknown as number);
    },
    setInterval: (fn, ms) => {
      const i = ++id;
      intervals.set(i, { every: ms, next: t + ms, fn });
      return i as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (handle) => {
      intervals.delete(handle as unknown as number);
    },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let earliest = Infinity;
        let kind: "t" | "i" | null = null;
        let key = -1;
        for (const [k, v] of timeouts) {
          if (v.due <= target && v.due < earliest) {
            earliest = v.due;
            kind = "t";
            key = k;
          }
        }
        for (const [k, v] of intervals) {
          if (v.next <= target && v.next < earliest) {
            earliest = v.next;
            kind = "i";
            key = k;
          }
        }
        if (kind === null) break;
        t = earliest;
        if (kind === "t") {
          const v = timeouts.get(key)!;
          timeouts.delete(key);
          v.fn();
        } else {
          const v = intervals.get(key)!;
          v.next += v.every;
          v.fn();
        }
      }
      t = target;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function snapshot(seq: number, overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: seq,
    retentionFloorSeq: 0,
    runtime: { hostEpoch: 1, health: "ready" },
    structuredHostsEnabled: true,
    filesRevision: 1,
    sessions: [
      {
        conversationId: "conv_a",
        sessionKey: { engine: "codex", sessionId: "s1" },
        hostKind: "codex-app-server",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        revision: 1,
        attentionIds: [],
        recentReceipts: [],
        accountId: "acct",
        parentConversationId: null,
        flowId: null,
        workflowId: null,
        cwd: "/tmp",
        artifactPath: null,
        capabilities: { steer: true, structuredAttention: true },
        activeTurnId: null,
        drift: null,
      },
    ],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    ...overrides,
  };
}

test("the snapshot carries the runtime structured-host gate into client state", async () => {
  const h = harness();
  h.setSnapshot(snapshot(101, { structuredHostsEnabled: false }));
  h.bus.start();
  await flush();

  expect(h.bus.getState().structuredHostsEnabled).toBeFalse();
  expect(h.bus.getState().store.sessions.conv_a?.hostKind).toBe("codex-app-server");
});

interface Harness {
  bus: RuntimeBus;
  clock: Clock;
  sources: FakeEventSource[];
  setSnapshot: (s: RuntimeSnapshot) => void;
  deferNextFetch: () => { resolveSnapshot: (s: RuntimeSnapshot) => void };
  failFetch: (fail: boolean) => void;
  fetchCalls: () => number;
}

function harness(): Harness {
  const clock = makeClock();
  const sources: FakeEventSource[] = [];
  let currentSnapshot = snapshot(100);
  let shouldFail = false;
  let calls = 0;
  let deferredFetch: Promise<Response> | null = null;
  const deps: RuntimeBusDeps = {
    fetch: (() => {
      calls += 1;
      if (shouldFail) return Promise.reject(new Error("network"));
      if (deferredFetch) {
        const pending = deferredFetch;
        deferredFetch = null;
        return pending;
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(currentSnapshot) } as unknown as Response);
    }) as FetchLike,
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
  return {
    bus: createRuntimeBus(deps),
    clock,
    sources,
    setSnapshot: (s) => (currentSnapshot = s),
    deferNextFetch: () => {
      let resolveFetch!: (response: Response) => void;
      deferredFetch = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      return {
        resolveSnapshot: (s) => resolveFetch({ ok: true, status: 200, json: () => Promise.resolve(s) } as unknown as Response),
      };
    },
    failFetch: (fail) => (shouldFail = fail),
    fetchCalls: () => calls,
  };
}

const sessionEvent = (seq: number, revision: number, turn: "running" | "idle", turnId?: string) => ({
  schemaVersion: 1,
  seq,
  eventId: `evt_${seq}`,
  scope: { type: "session", id: "conv_a" },
  revision,
  kind: turn === "running" ? "turn-started" : "turn-ended",
  payload: { conversationId: "conv_a", turnId },
});

/* ---------------------------- tests ---------------------------- */

describe("runtimeBus join", () => {
  let h: Harness;
  beforeEach(() => (h = harness()));

  test("start joins snapshot then goes live on SSE open (no false live before)", async () => {
    h.bus.start();
    expect(h.bus.getState().connection).toBe("reconnecting");
    await flush();
    // snapshot installed, stream opened, still not live until onopen
    expect(h.bus.getState().store.sessions["conv_a"]).toBeDefined();
    expect(h.bus.getState().store.cursor).toBe(100);
    expect(h.sources.length).toBe(1);
    expect(h.sources[0]!.url).toContain("after=100");
    h.sources[0]!.open();
    expect(h.bus.getState().connection).toBe("live");
  });

  test("snapshot/SSE race: an event that lands right after snapshotSeq applies exactly once", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.sources[0]!.message(sessionEvent(101, 2, "running", "t1"));
    // a duplicate redelivery of the same event is dropped
    h.sources[0]!.message(sessionEvent(101, 2, "running", "t1"));
    const s = h.bus.getState().store.sessions["conv_a"];
    expect(s?.turn).toBe("running");
    expect(s?.activeTurnId).toBe("t1");
    expect(h.bus.getState().store.cursor).toBe(101);
  });

  test("a 128-event replay converges synchronously with one subscriber publication", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    await flush();
    h.clock.advance(16);
    await flush();

    let notifications = 0;
    h.bus.subscribe(() => { notifications += 1; });
    for (let index = 0; index < 128; index += 1) {
      h.sources[0]!.message({
        schemaVersion: 1,
        seq: 101 + index,
        eventId: `evt_${101 + index}`,
        scope: { type: "session", id: "conv_a" },
        revision: 2 + index,
        kind: "item",
        payload: { phase: "delta", text: `token-${index}` },
      });
      await Promise.resolve();
    }

    expect(h.bus.getState().store.cursor).toBe(228);
    expect(h.bus.getState().store.scopeHeads["session:conv_a"]).toBe(129);
    expect(notifications).toBe(0);
    h.clock.advance(16);
    await flush();
    expect(notifications).toBe(1);
  });

  test("Codex and Claude bursts keep one warm SSE join with bounded publications", async () => {
    const initial = snapshot(100);
    const codex = initial.sessions[0]!;
    const claude = {
      ...codex,
      conversationId: "conv_b",
      sessionKey: { engine: "claude" as const, sessionId: "s2" },
      hostKind: "claude-broker" as const,
    };
    h.setSnapshot({ ...initial, sessions: [codex, claude] });

    const warmStartedAt = performance.now();
    h.bus.start();
    await flush();
    expect(performance.now() - warmStartedAt).toBeLessThan(250);
    expect(h.bus.getState().store.sessions.conv_a?.sessionKey.engine).toBe("codex");
    expect(h.bus.getState().store.sessions.conv_b?.sessionKey.engine).toBe("claude");
    h.sources[0]!.open();
    await flush();
    h.clock.advance(16);
    await flush();

    let notifications = 0;
    let filesNotifications = 0;
    h.bus.subscribe(() => { notifications += 1; });
    h.bus.subscribeFilesRevision(() => { filesNotifications += 1; });
    let seq = 100;
    for (const conversationId of ["conv_a", "conv_b"]) {
      for (let index = 0; index < 64; index += 1) {
        seq += 1;
        h.sources[0]!.message({
          schemaVersion: 1,
          seq,
          eventId: `evt_${seq}`,
          scope: { type: "session", id: conversationId },
          revision: 2 + index,
          kind: "item",
          payload: { phase: "delta", text: `token-${conversationId}-${index}` },
        });
        await Promise.resolve();
      }
    }
    for (const conversationId of ["conv_a", "conv_b"]) {
      seq += 1;
      h.sources[0]!.message({
        ...sessionEvent(seq, 66, "running", `turn-${conversationId}`),
        scope: { type: "session", id: conversationId },
        payload: { conversationId, turnId: `turn-${conversationId}` },
      });
    }
    seq += 1;
    h.sources[0]!.message({
      schemaVersion: 1,
      seq,
      eventId: `evt_${seq}`,
      scope: { type: "system", id: "files" },
      kind: "files.revision",
      payload: { filesRevision: 7 },
    });
    const finalEnvelope = {
      schemaVersion: 1,
      seq: ++seq,
      eventId: `evt_${seq}`,
      scope: { type: "operation", id: "op-one" },
      revision: 1,
      kind: "receipt",
      payload: {
        operationId: "op-one",
        idempotencyKey: "key-one",
        conversationId: "conv_a",
        kind: "send",
        status: "delivered",
        at: "2026-07-15T00:00:00.000Z",
        revision: 1,
      },
    };
    h.sources[0]!.message(finalEnvelope);
    h.sources[0]!.message(finalEnvelope);

    expect(h.bus.getState().store).toMatchObject({
      cursor: seq,
      filesRevision: 7,
      sessions: {
        conv_a: { turn: "running", revision: 66 },
        conv_b: { turn: "running", revision: 66 },
      },
      operations: { "op-one": { status: "delivered" } },
    });
    expect(h.fetchCalls()).toBe(1);
    expect(h.sources).toHaveLength(1);
    expect(filesNotifications).toBe(1);
    expect(notifications).toBe(0);
    h.clock.advance(16);
    await flush();
    expect(notifications).toBe(1);
  });
});

describe("runtimeBus reconnect", () => {
  let h: Harness;
  beforeEach(() => (h = harness()));

  test("a persistent runtime-host fault preserves backoff and reaches degraded fallback", async () => {
    h.bus.start();
    await flush();

    let faultedSources = 0;
    for (let elapsed = 0; elapsed < 20_000; elapsed += 100) {
      const current = h.sources[faultedSources];
      if (current) {
        current.open();
        current.named("fault", { code: "runtime-host-unavailable" });
        current.error();
        faultedSources += 1;
      }
      h.clock.advance(100);
      await flush();
    }

    expect(h.fetchCalls()).toBe(7);
    expect(h.sources).toHaveLength(6);
    expect(h.bus.getState().connection).toBe("degraded");
    expect(h.sources.filter((source) => !source.closed)).toHaveLength(0);
  });

  test("a named fault followed by EventSource error schedules one reconnect", async () => {
    h.bus.start();
    await flush();
    const first = h.sources[0]!;
    first.open();
    first.named("fault", { code: "runtime-host-unavailable" });
    expect(h.bus.getState().connection).toBe("reconnecting");
    expect(first.closed).toBeTrue();
    first.error();

    h.clock.advance(500);
    await flush();

    expect(h.fetchCalls()).toBe(2);
    expect(h.sources).toHaveLength(2);
    expect(h.sources.filter((source) => !source.closed)).toHaveLength(1);
  });

  test("opening a replacement stream leaves its accumulated failure budget intact", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.sources[0]!.error();
    h.clock.advance(500);
    await flush();

    h.sources[1]!.open();
    expect(h.bus.getState().connection).toBe("reconnecting");
    h.sources[1]!.error();
    h.clock.advance(500);
    await flush();
    expect(h.sources).toHaveLength(2);

    h.clock.advance(500);
    await flush();
    expect(h.sources).toHaveLength(3);
  });

  test("a heartbeat on a replacement stream restores the initial retry budget", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.sources[0]!.error();
    h.clock.advance(500);
    await flush();

    h.sources[1]!.open();
    h.sources[1]!.named("heartbeat", { publishedSeq: 100 });
    h.sources[1]!.error();
    h.clock.advance(500);
    await flush();

    expect(h.sources).toHaveLength(3);
    expect(h.bus.getState().connection).toBe("reconnecting");
  });

  test("a valid runtime envelope restores health and resumes from its cursor", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.sources[0]!.error();
    h.clock.advance(500);
    await flush();

    h.sources[1]!.open();
    h.sources[1]!.message(sessionEvent(101, 2, "running", "t1"));
    h.sources[1]!.error();
    h.clock.advance(500);
    await flush();

    expect(h.sources).toHaveLength(3);
    expect(h.sources[2]!.url).toContain("after=101");
  });

  test("transport blip refreshes deployment state and resumes from the cursor", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.sources[0]!.message(sessionEvent(101, 2, "running", "t1"));
    const fetchesBefore = h.fetchCalls();

    h.sources[0]!.error();
    expect(h.bus.getState().connection).toBe("reconnecting");
    h.clock.advance(600); // past the first backoff
    await flush();
    expect(h.fetchCalls()).toBe(fetchesBefore + 1);
    expect(h.sources.length).toBe(2);
    expect(h.sources[1]!.url).toContain("after=101");
    h.sources[1]!.open();
    expect(h.bus.getState().connection).toBe("reconnecting");
    h.sources[1]!.named("heartbeat", { publishedSeq: 101 });
    expect(h.bus.getState().connection).toBe("live");
  });

  test("a tab refreshes the structured-host gate after a server restart", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    expect(h.bus.getState().structuredHostsEnabled).toBeTrue();

    h.setSnapshot(snapshot(100, { structuredHostsEnabled: false }));
    h.sources[0]!.error();
    h.clock.advance(600);
    await flush();

    expect(h.bus.getState().structuredHostsEnabled).toBeFalse();
    expect(h.sources[1]!.url).toContain("after=100");
  });

  test("heartbeat timeout is treated as a lost transport", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    expect(h.bus.getState().connection).toBe("live");
    h.clock.advance(20_001); // exceed HEARTBEAT_TIMEOUT_MS with no traffic
    expect(h.bus.getState().connection).toBe("reconnecting");
    expect(h.sources[0]!.closed).toBe(true);
  });

  test("a named heartbeat keeps the connection live and resets the timer", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.clock.advance(14_000);
    h.sources[0]!.named("heartbeat", { seq: 100 });
    h.clock.advance(14_000); // would have fired without the heartbeat reset
    expect(h.bus.getState().connection).toBe("live");
  });
});

describe("runtimeBus cursor reset / resync", () => {
  let h: Harness;
  beforeEach(() => (h = harness()));

  test("a revision gap forces a full snapshot reload and shows the resynced note", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.setSnapshot(snapshot(200)); // the resnapshot returns a newer seq
    h.sources[0]!.message(sessionEvent(150, 9, "running", "t9")); // revision 9 skips ahead → gap
    await flush();
    expect(h.bus.getState().store.cursor).toBe(200);
    expect(h.bus.getState().resyncedAt).not.toBeNull();
    // the resynced note clears after its window
    h.clock.advance(6_001);
    expect(h.bus.getState().resyncedAt).toBeNull();
  });

  test("a server reset frame reloads the snapshot", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    const fetchesBefore = h.fetchCalls();
    h.setSnapshot(snapshot(300));
    h.sources[0]!.named("reset", {});
    await flush();
    expect(h.fetchCalls()).toBe(fetchesBefore + 1);
    expect(h.bus.getState().store.cursor).toBe(300);
    expect(h.bus.getState().resyncedAt).not.toBeNull();
  });
});

describe("runtimeBus degraded fallback", () => {
  let h: Harness;
  beforeEach(() => (h = harness()));

  test("sustained SSE failure drops to a bounded snapshot poll, then restores SSE", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();

    // SSE keeps erroring; each reconnect attempt fails to open. After the
    // degrade window the bus switches to the poll fallback.
    h.failFetch(false);
    h.sources[0]!.error();
    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(9_000);
      await flush();
      const last = h.sources[h.sources.length - 1]!;
      if (!last.closed) last.error();
    }
    expect(h.bus.getState().connection).toBe("degraded");

    // The fallback poll refreshes the snapshot every 10s.
    const fetchesBefore = h.fetchCalls();
    h.setSnapshot(snapshot(120, { structuredHostsEnabled: false }));
    h.clock.advance(10_000);
    await flush();
    expect(h.fetchCalls()).toBeGreaterThan(fetchesBefore);
    expect(h.bus.getState().store.cursor).toBe(120);
    expect(h.bus.getState().structuredHostsEnabled).toBeFalse();

    // After the SSE retry window, a live stream is attempted again. Open any
    // freshly-created stream promptly (a real EventSource opens on its own),
    // and the bus climbs back to live.
    let live = false;
    for (let i = 0; i < 30 && !live; i += 1) {
      h.clock.advance(5_000);
      await flush();
      const last = h.sources[h.sources.length - 1]!;
      if (!last.closed) last.open();
      live = h.bus.getState().connection === "live";
    }
    expect(live).toBe(true);
  });

  test("old fallback responses cannot overwrite newer rollback snapshots", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();

    h.sources[0]!.error();
    h.clock.advance(9_000);
    await flush();
    h.sources[h.sources.length - 1]!.error();
    h.clock.advance(9_000);
    await flush();

    const oldPoll = h.deferNextFetch();
    h.sources[h.sources.length - 1]!.error();
    expect(h.bus.getState().connection).toBe("degraded");

    h.setSnapshot(snapshot(200, { structuredHostsEnabled: false }));
    h.clock.advance(10_000);
    await flush();

    oldPoll.resolveSnapshot(snapshot(200, { structuredHostsEnabled: true }));
    await flush();
    expect(h.bus.getState()).toMatchObject({
      connection: "degraded",
      structuredHostsEnabled: false,
      store: { cursor: 200 },
    });

    const teardownPoll = h.deferNextFetch();
    h.clock.advance(10_000);
    await flush();
    h.clock.advance(40_000);
    await flush();
    h.sources[h.sources.length - 1]!.open();
    expect(h.bus.getState()).toMatchObject({
      connection: "live",
      structuredHostsEnabled: false,
      store: { cursor: 200 },
    });

    teardownPoll.resolveSnapshot(snapshot(150, { structuredHostsEnabled: true }));
    await flush();

    expect(h.bus.getState()).toMatchObject({
      connection: "live",
      structuredHostsEnabled: false,
      store: { cursor: 200 },
    });
  });

  test("files.revision applied on the stream notifies files subscribers", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    let notified = 0;
    let seenRev = 0;
    h.bus.subscribeFilesRevision((rev) => {
      notified += 1;
      seenRev = rev;
    });
    h.sources[0]!.message({
      schemaVersion: 1,
      seq: 101,
      eventId: "evt_101",
      scope: { type: "system", id: "files" },
      kind: "files.revision",
      payload: { filesRevision: 7 },
    });
    expect(notified).toBe(1);
    expect(seenRev).toBe(7);
    expect(h.bus.getState().store.filesRevision).toBe(7);
  });
});

describe("runtimeBus stop", () => {
  test("stop tears down and resets to an inert offline state", async () => {
    const h = harness();
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.sources[0]!.named("fault", { code: "runtime-host-unavailable" });
    h.bus.stop();
    h.clock.advance(20_000);
    await flush();
    expect(h.bus.getState().enabled).toBe(false);
    expect(h.bus.getState().connection).toBe("offline");
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.sources).toHaveLength(1);
  });
});

describe("runtimeBus refresh (dead-host Re-check, §5)", () => {
  let h: Harness;
  beforeEach(() => (h = harness()));

  test("installs a fresh snapshot into the store and resolves true", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    // The host recovered: a later snapshot flips the axis from dead to hosted.
    h.setSnapshot(snapshot(200, { sessions: [{ ...snapshot(200).sessions[0]!, host: "hosted", revision: 5 }] }));
    const ok = await h.bus.refresh();
    expect(ok).toBe(true);
    expect(h.bus.getState().store.sessions["conv_a"]?.host).toBe("hosted");
  });

  test("refreshes the structured-host gate alongside the store (issue #241 finding 1)", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    expect(h.bus.getState().structuredHostsEnabled).toBeTrue();
    // A manual Re-check after a rollback flip must carry the new gate, not just
    // the store — otherwise the tab keeps offering structured controls.
    h.setSnapshot(snapshot(200, { structuredHostsEnabled: false }));
    const ok = await h.bus.refresh();
    expect(ok).toBe(true);
    expect(h.bus.getState().structuredHostsEnabled).toBeFalse();
  });

  test("resolves false on a failed fetch and leaves the store untouched", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    const before = h.bus.getState().store.sessions["conv_a"];
    h.failFetch(true);
    const ok = await h.bus.refresh();
    expect(ok).toBe(false);
    // the failure is reported to the caller, not swallowed into a stale banner
    expect(h.bus.getState().store.sessions["conv_a"]).toBe(before);
  });

  test("a slow refresh response never regresses the store below the live cursor (#257)", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();

    // refresh's snapshot fetch is in flight while newer events land on the stream
    const slow = h.deferNextFetch();
    const pending = h.bus.refresh();
    h.sources[0]!.message(sessionEvent(101, 2, "running", "t1"));
    expect(h.bus.getState().store.cursor).toBe(101);

    // the stale response (snapshotSeq 100 < cursor 101) finally arrives: it must
    // NOT be installed — pollFallback semantics — yet the refresh still reports
    // success, because fresher state than the response is already live.
    slow.resolveSnapshot(snapshot(100));
    expect(await pending).toBe(true);
    expect(h.bus.getState().store.cursor).toBe(101);
    expect(h.bus.getState().store.sessions["conv_a"]?.turn).toBe("running");
    expect(h.bus.getState().store.sessions["conv_a"]?.activeTurnId).toBe("t1");

    // an equal-or-newer snapshot still installs (the dead-host Re-check works)
    h.setSnapshot(snapshot(200, { sessions: [{ ...snapshot(200).sessions[0]!, host: "dead", revision: 5 }] }));
    expect(await h.bus.refresh()).toBe(true);
    expect(h.bus.getState().store.cursor).toBe(200);
    expect(h.bus.getState().store.sessions["conv_a"]?.host).toBe("dead");
  });
});
