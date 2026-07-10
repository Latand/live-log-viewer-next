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

interface Harness {
  bus: RuntimeBus;
  clock: Clock;
  sources: FakeEventSource[];
  setSnapshot: (s: RuntimeSnapshot) => void;
  failFetch: (fail: boolean) => void;
  fetchCalls: () => number;
}

function harness(): Harness {
  const clock = makeClock();
  const sources: FakeEventSource[] = [];
  let currentSnapshot = snapshot(100);
  let shouldFail = false;
  let calls = 0;
  const deps: RuntimeBusDeps = {
    fetch: (() => {
      calls += 1;
      if (shouldFail) return Promise.reject(new Error("network"));
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
});

describe("runtimeBus reconnect", () => {
  let h: Harness;
  beforeEach(() => (h = harness()));

  test("transport blip reconnects and resumes from the cursor, no new snapshot fetch", async () => {
    h.bus.start();
    await flush();
    h.sources[0]!.open();
    h.sources[0]!.message(sessionEvent(101, 2, "running", "t1"));
    const fetchesBefore = h.fetchCalls();

    h.sources[0]!.error();
    expect(h.bus.getState().connection).toBe("reconnecting");
    h.clock.advance(600); // past the first backoff
    await flush();
    // resumed by reopening the stream from the cursor, not by re-snapshotting
    expect(h.fetchCalls()).toBe(fetchesBefore);
    expect(h.sources.length).toBe(2);
    expect(h.sources[1]!.url).toContain("after=101");
    h.sources[1]!.open();
    expect(h.bus.getState().connection).toBe("live");
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
    h.setSnapshot(snapshot(120));
    h.clock.advance(10_000);
    await flush();
    expect(h.fetchCalls()).toBeGreaterThan(fetchesBefore);
    expect(h.bus.getState().store.cursor).toBe(120);

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
    h.bus.stop();
    expect(h.bus.getState().enabled).toBe(false);
    expect(h.bus.getState().connection).toBe("offline");
    expect(h.sources[0]!.closed).toBe(true);
  });
});
