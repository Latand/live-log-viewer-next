/**
 * Stream reconnect pacing on the shared log bus (#1432): a subscriber that
 * arrives on a settled stream — the operator switching conversations — must
 * not wait the churn-coalescing window before its pane goes live.
 */
import { afterEach, beforeEach, expect, jest, test } from "bun:test";

class FakeEventSource {
  static connects: Array<{ at: number; subs: Array<{ path: string; offset: number }> }> = [];
  private closed = false;
  constructor(url: string) {
    const subs = JSON.parse(new URL(url, "http://localhost").searchParams.get("subs") ?? "[]") as Array<{ path: string; offset: number }>;
    FakeEventSource.connects.push({ at: Date.now(), subs });
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.closed = true; }
  onerror: (() => void) | null = null;
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const { subscribeLog } = await import("./logBus");

const subscriber = (path: string, offset = 0) => ({ path, getOffset: () => offset, onChunk: () => {} });
let unsubscribes: Array<() => void> = [];
const subscribe = (path: string, offset = 0) => {
  const off = subscribeLog(subscriber(path, offset));
  unsubscribes.push(off);
  return off;
};
const connectsAtOrBefore = (ms: number) => FakeEventSource.connects.filter((entry) => entry.at <= ms).length;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  FakeEventSource.connects = [];
});

afterEach(() => {
  /* Dropping the last subscriber stops every transport, so the module's
     state is idle for the next test. */
  for (const off of unsubscribes.splice(0)) off();
  jest.useRealTimers();
});

test("the first subscriber on a settled stream connects on the short window", () => {
  subscribe("/sessions/a.jsonl");
  jest.advanceTimersByTime(39);
  expect(FakeEventSource.connects.length).toBe(0);
  jest.advanceTimersByTime(1);
  expect(FakeEventSource.connects.length).toBe(1);
  expect(FakeEventSource.connects[0]!.subs.map((sub) => sub.path)).toEqual(["/sessions/a.jsonl"]);
});

test("a burst of subscribers in one tick shares one prompt connection", () => {
  subscribe("/sessions/a.jsonl");
  subscribe("/sessions/b.jsonl", 128);
  subscribe("/sessions/c.jsonl");
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(1);
  expect(FakeEventSource.connects[0]!.subs.length).toBe(3);
});

test("a subscriber arriving while the stream is fresh waits the long window; one arriving after it is prompt again", () => {
  subscribe("/sessions/a.jsonl");
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(1);
  /* 100 ms after the connect: churn territory — coalesce on the long window. */
  jest.advanceTimersByTime(100);
  subscribe("/sessions/b.jsonl");
  jest.advanceTimersByTime(200);
  expect(connectsAtOrBefore(340)).toBe(1);
  jest.advanceTimersByTime(100);
  expect(FakeEventSource.connects.length).toBe(2);
  expect(FakeEventSource.connects[1]!.at).toBe(440);
  /* Well after that reconnect: a switch, served promptly. */
  jest.advanceTimersByTime(1000);
  subscribe("/sessions/c.jsonl", 512);
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(3);
  expect(FakeEventSource.connects[2]!.at).toBe(1480);
});

test("an unsubscribe alone never triggers a prompt reconnect", () => {
  subscribe("/sessions/a.jsonl");
  const offB = subscribe("/sessions/b.jsonl");
  jest.advanceTimersByTime(40);
  expect(FakeEventSource.connects.length).toBe(1);
  jest.advanceTimersByTime(1000);
  offB();
  unsubscribes = unsubscribes.filter((off) => off !== offB);
  jest.advanceTimersByTime(299);
  expect(FakeEventSource.connects.length).toBe(1);
  jest.advanceTimersByTime(1);
  expect(FakeEventSource.connects.length).toBe(2);
});
