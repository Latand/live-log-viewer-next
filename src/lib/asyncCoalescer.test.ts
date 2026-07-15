import { describe, expect, test } from "bun:test";

import { createFreshAwareCoalescer } from "./asyncCoalescer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("fresh-aware async coalescing", () => {
  test("shares one ordinary operation across concurrent callers", async () => {
    const coalescer = createFreshAwareCoalescer<number>();
    const result = deferred<number>();
    const calls: boolean[] = [];
    const work = (fresh: boolean) => {
      calls.push(fresh);
      return result.promise;
    };

    const first = coalescer.run(false, work);
    const second = coalescer.run(false, work);
    await Promise.resolve();

    expect(calls).toEqual([false]);
    result.resolve(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
  });

  test("runs one fresh operation after an ordinary operation already in flight", async () => {
    const coalescer = createFreshAwareCoalescer<number>();
    const ordinary = deferred<number>();
    const fresh = deferred<number>();
    const calls: boolean[] = [];
    const work = (forceFresh: boolean) => {
      calls.push(forceFresh);
      return forceFresh ? fresh.promise : ordinary.promise;
    };

    const first = coalescer.run(false, work);
    const refreshOne = coalescer.run(true, work);
    const refreshTwo = coalescer.run(true, work);
    await Promise.resolve();
    expect(calls).toEqual([false]);

    ordinary.resolve(1);
    expect(await first).toBe(1);
    await Promise.resolve();
    expect(calls).toEqual([false, true]);

    fresh.resolve(2);
    expect(await Promise.all([refreshOne, refreshTwo])).toEqual([2, 2]);
  });

  test("clears a failed operation so the next caller can retry", async () => {
    const coalescer = createFreshAwareCoalescer<number>();
    const failed = deferred<number>();
    let calls = 0;
    const work = () => {
      calls += 1;
      return calls === 1 ? failed.promise : Promise.resolve(9);
    };

    const first = coalescer.run(false, work);
    failed.reject(new Error("scan failed"));
    await expect(first).rejects.toThrow("scan failed");
    await expect(coalescer.run(false, work)).resolves.toBe(9);
    expect(calls).toBe(2);
  });
});
