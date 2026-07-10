import { expect, test } from "bun:test";

import { mergeView, OVERVIEW_CONTEXT, OVERVIEW_SLICE, type RenderedViewState } from "./viewPresenceBus";
import {
  buildPresencePayload,
  createPresencePublisher,
  detectBrowser,
  detectDeviceKind,
  newViewSessionId,
  stableDeviceId,
  type PresenceIdentity,
  type PresenceResponse,
  type PresenceScheduler,
} from "./useViewPresence";

const identity: PresenceIdentity = { viewSessionId: "vs-1", deviceId: "dev-1", device: { kind: "desktop", browser: "chrome" } };
const view = (mode: RenderedViewState["mode"] = "scheme"): RenderedViewState =>
  mergeView({ project: "proj", board: { renderedRevision: 3, durableRevision: 3, sync: "current" } }, { ...OVERVIEW_SLICE, mode, visiblePaths: ["a"] }, { width: 800, height: 600, dpr: 1 });

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function fakeScheduler() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: PresenceScheduler = {
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = ++id;
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  };
  return {
    scheduler,
    async advance(ms: number) {
      now += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [handle, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at <= now) {
            timers.delete(handle);
            timer.fn();
            progressed = true;
            break;
          }
        }
        await settle();
      }
    },
  };
}

function recordingFetcher() {
  const calls: Array<{ payload: ReturnType<typeof buildPresencePayload>; init: RequestInit }> = [];
  /* "ok" → 200; "throw" → network error; a number → that HTTP status. */
  let mode: "ok" | "throw" | number = "ok";
  let drained = 0;
  const fetcher = async (_input: string, init: RequestInit): Promise<PresenceResponse> => {
    calls.push({ payload: JSON.parse(String(init.body)), init });
    if (mode === "throw") throw new Error("network down");
    const status = mode === "ok" ? 200 : mode;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => {
        drained += 1;
        return "";
      },
    };
  };
  return {
    calls,
    fetcher,
    drained: () => drained,
    setOk: () => (mode = "ok"),
    setThrow: () => (mode = "throw"),
    setStatus: (status: number) => (mode = status),
    /* Back-compat with the existing failure test. */
    setFail: (value: boolean) => (mode = value ? "throw" : "ok"),
  };
}

test("detectBrowser and detectDeviceKind classify common agents", () => {
  expect(detectBrowser("Mozilla/5.0 Chrome/130 Safari/537")).toBe("chrome");
  expect(detectBrowser("Mozilla/5.0 Firefox/130")).toBe("firefox");
  expect(detectBrowser("Mozilla/5.0 Version/17 Safari/605")).toBe("safari");
  expect(detectBrowser("Mozilla/5.0 Chrome/130 Edg/130")).toBe("other");
  expect(detectDeviceKind("iPhone; Mobile Safari", false, 390)).toBe("mobile");
  expect(detectDeviceKind("iPad; Safari", true, 1024)).toBe("tablet");
  expect(detectDeviceKind("X11; Linux Chrome", false, 1600)).toBe("desktop");
});

test("view session id is fresh per call; device id is stable in storage", () => {
  expect(newViewSessionId()).not.toBe(newViewSessionId());
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  const first = stableDeviceId(storage);
  expect(stableDeviceId(storage)).toBe(first);
});

test("buildPresencePayload stamps identity, counters and visibility onto the view", () => {
  const payload = buildPresencePayload(view(), identity, 7, 4, "hidden");
  expect(payload.schemaVersion).toBe(1);
  expect(payload.viewSessionId).toBe("vs-1");
  expect(payload.sequence).toBe(7);
  expect(payload.inputSequence).toBe(4);
  expect(payload.visibility).toBe("hidden");
  expect(payload.visiblePaths).toEqual(["a"]);
  expect(payload.project).toBe("proj");
});

test("sequence is monotonic and inputSequence only advances after an interaction", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  pub.setView(view());
  pub.start(); // start publishes once immediately
  await clock.advance(0);
  expect(net.calls).toHaveLength(1);
  expect(net.calls[0].payload.sequence).toBe(1);
  expect(net.calls[0].payload.inputSequence).toBe(0);

  pub.markInteraction();
  pub.setView(view("list"));
  await clock.advance(500); // interaction debounce
  expect(net.calls).toHaveLength(2);
  expect(net.calls[1].payload.sequence).toBe(2);
  expect(net.calls[1].payload.inputSequence).toBe(1); // advanced by the interaction

  await clock.advance(10_000); // heartbeat, no interaction
  expect(net.calls[2].payload.sequence).toBe(3);
  expect(net.calls[2].payload.inputSequence).toBe(1); // unchanged
});

test("rate limit: two publishes never land within 500ms of each other", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  pub.start();
  await clock.advance(0);
  expect(net.calls).toHaveLength(1);
  /* A visibility flip asks for an immediate publish, but the floor holds it. */
  pub.setVisibility("hidden");
  await clock.advance(200);
  expect(net.calls).toHaveLength(1);
  await clock.advance(300); // now 500ms since the first send
  expect(net.calls).toHaveLength(2);
  expect(net.calls[1].payload.visibility).toBe("hidden");
});

test("routine publishes carry no keepalive and always drain the response body", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  pub.start();
  await clock.advance(0);
  expect(net.calls).toHaveLength(1);
  /* keepalive:true exhausts Chrome's 64 KB quota under a 10 s heartbeat. */
  expect("keepalive" in net.calls[0].init).toBe(false);
  /* The body is consumed so a non-keepalive socket is freed. */
  expect(net.drained()).toBe(1);
});

test("a 4xx rejects the payload terminally — no retry loop, a later change still publishes", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  net.setStatus(400);
  pub.start();
  await clock.advance(0);
  expect(net.calls).toHaveLength(1); // attempted, deterministically rejected
  /* No 2/sec retry storm on the identical body: nothing before the 10 s heartbeat. */
  await clock.advance(9000);
  expect(net.calls).toHaveLength(1);
  /* A genuinely new view publishes a fresh (different) payload. */
  net.setOk();
  pub.markInteraction();
  pub.setView(view("list"));
  await clock.advance(500);
  expect(net.calls).toHaveLength(2);
  expect(net.calls[1].payload.mode).toBe("list");
});

test("network failures back off exponentially, then recover on success", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  net.setThrow();
  pub.start();
  await clock.advance(0);
  expect(net.calls).toHaveLength(1); // t=0 attempt threw
  /* Step 1 ≈ 1 s: nothing just before, a retry at the boundary. */
  await clock.advance(999);
  expect(net.calls).toHaveLength(1);
  await clock.advance(1); // t=1000
  expect(net.calls).toHaveLength(2);
  /* Step 2 doubles to ≈ 2 s. */
  await clock.advance(1999);
  expect(net.calls).toHaveLength(2);
  await clock.advance(1); // t=3000
  expect(net.calls).toHaveLength(3);
  /* Recovery: the next retry (≈ 4 s later) succeeds and clears the backoff. */
  net.setOk();
  await clock.advance(4000); // t=7000
  const healthy = net.calls.length;
  expect(healthy).toBeGreaterThanOrEqual(4);
  /* No lingering error loop after success — nothing until the 10 s heartbeat. */
  await clock.advance(500);
  expect(net.calls.length).toBe(healthy);
});

test("a hidden tab keeps heartbeating its last-known slice as visibility:hidden", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  pub.setView(view());
  pub.start();
  await clock.advance(0);
  pub.setVisibility("hidden");
  await clock.advance(500); // the honest hidden publish, held by the 500 ms floor
  const hiddenAt = net.calls.length;
  expect(net.calls.at(-1)!.payload.visibility).toBe("hidden");
  /* The heartbeat is not gated on visibility: a backgrounded tab keeps the
     session retainable on the server (Terra owns the freshness window). */
  await clock.advance(10_000);
  expect(net.calls.length).toBeGreaterThan(hiddenAt);
  expect(net.calls.at(-1)!.payload.visibility).toBe("hidden");
});

test("a failed POST is retried on the next tick without losing a sequence", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  net.setFail(true);
  pub.start();
  await clock.advance(0);
  expect(net.calls).toHaveLength(1); // attempted, threw
  net.setFail(false);
  await clock.advance(10_000); // heartbeat retries
  const sequences = net.calls.map((call) => call.payload.sequence);
  /* Strictly increasing across the failed attempt and the retry. */
  for (let i = 1; i < sequences.length; i += 1) expect(sequences[i]).toBeGreaterThan(sequences[i - 1]!);
  expect(net.calls.at(-1)!.payload.sequence).toBeGreaterThanOrEqual(2);
});

test("sendBeacon publishes a final hidden snapshot", () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const beacons: string[] = [];
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler, beacon: (_url, body) => (beacons.push(body), true) });
  pub.setView(view());
  pub.sendBeacon();
  expect(beacons).toHaveLength(1);
  expect(JSON.parse(beacons[0]!).visibility).toBe("hidden");
});

test("identical views do not trigger a redundant publish", async () => {
  const clock = fakeScheduler();
  const net = recordingFetcher();
  const pub = createPresencePublisher({ identity, fetcher: net.fetcher, scheduler: clock.scheduler });
  pub.start();
  await clock.advance(0);
  const before = net.calls.length;
  pub.setView(mergeView(OVERVIEW_CONTEXT, OVERVIEW_SLICE, { width: 1, height: 1, dpr: 1 })); // same as the publisher's initial default
  await clock.advance(1000);
  expect(net.calls.length).toBe(before);
});
