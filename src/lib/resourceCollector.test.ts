import { describe, expect, test } from "bun:test";

import { createResourceCollector } from "./resourceCollector";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("resource collector", () => {
  test("a fresh fence waits for an observation that started after the request", async () => {
    let now = 0;
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => (++calls === 1 ? first.promise : second.promise),
      now: () => now,
    });

    const stale = collector.observe(0, 1_000);
    await Promise.resolve();
    const requestFence = collector.fence();
    const fresh = collector.observe(requestFence, 1_000);
    first.resolve("first");
    await expect(stale).resolves.toMatchObject({ generation: 1, value: "first" });
    now = 1;
    second.resolve("second");
    await expect(fresh).resolves.toMatchObject({ generation: 2, value: "second" });
  });

  test("a bounded wait returns the immutable previous observation with a timeout diagnostic", async () => {
    const first = deferred<string>();
    const never = deferred<string>();
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => (++calls === 1 ? first.promise : never.promise),
    });

    const initial = collector.observe(0, 1_000);
    first.resolve("prior");
    await initial;
    const timedOut = await collector.observe(collector.fence(), 1);

    expect(timedOut).toMatchObject({ generation: 1, value: "prior", degradedReason: "timeout" });
    expect(Object.isFrozen(timedOut)).toBeTrue();
  });

  test("concurrent callers coalesce only when their fences are already satisfied", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => (++calls === 1 ? first.promise : second.promise),
    });

    const one = collector.observe(0, 1_000);
    const two = collector.observe(0, 1_000);
    await Promise.resolve();
    expect(calls).toBe(1);
    first.resolve("one");
    await Promise.all([one, two]);

    const fence = collector.fence();
    const three = collector.observe(fence, 1_000);
    const four = collector.observe(fence, 1_000);
    await Promise.resolve();
    expect(calls).toBe(2);
    second.resolve("two");
    await expect(Promise.all([three, four])).resolves.toEqual([
      expect.objectContaining({ generation: 2, value: "two" }),
      expect.objectContaining({ generation: 2, value: "two" }),
    ]);
  });
});
