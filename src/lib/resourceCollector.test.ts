import { describe, expect, test } from "bun:test";

import { createResourceCollector, ResourceCollectorFailureError, RESOURCE_FAILURE_STDERR_MAX_BYTES } from "./resourceCollector";

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
    await expect(stale).resolves.toMatchObject({ observation: { generation: 1, value: "first" } });
    now = 1;
    second.resolve("second");
    await expect(fresh).resolves.toMatchObject({ observation: { generation: 2, value: "second" } });
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

    expect(timedOut).toMatchObject({
      observation: { generation: 1, value: "prior" },
      failure: { reason: "timeout", diagnostic: { cause: "observation-timeout" } },
    });
    expect(Object.isFrozen(timedOut)).toBeTrue();
  });

  test("a zero-wait observation reports a typed busy result", async () => {
    const pending = deferred<string>();
    const collector = createResourceCollector({
      collectorId: "busy-collector",
      collect: async () => pending.promise,
    });

    const result = await collector.observe(0, 0);
    expect(result).toMatchObject({
      observation: null,
      collectorId: "busy-collector",
      failure: { reason: "collector-busy", diagnostic: { cause: "collection-active" } },
    });
    pending.resolve("complete");
  });

  test("failure diagnostics preserve bounded redacted nested causes and stderr", async () => {
    const nested = new Error("PASSWORD=inner-secret");
    const outer = new Error("Bearer outer-secret", { cause: nested });
    const collector = createResourceCollector({
      collectorId: "failed-collector",
      collect: async () => {
        throw new ResourceCollectorFailureError(
          "collector-crash",
          "collector-error",
          "resource collection failed",
          {
            cause: outer,
            stderr: `${"safe ".repeat(RESOURCE_FAILURE_STDERR_MAX_BYTES)}\nAPI_TOKEN=stderr-secret`,
          },
        );
      },
    });

    const result = await collector.observe(0, 1_000);
    expect(result.failure).toMatchObject({
      reason: "collector-crash",
      diagnostic: {
        cause: "collector-error",
        causes: ["Bearer <redacted>", "PASSWORD=<redacted>"],
      },
    });
    const stderr = result.failure?.diagnostic.stderr ?? "";
    expect(Buffer.byteLength(stderr)).toBe(RESOURCE_FAILURE_STDERR_MAX_BYTES);
    expect(stderr).toContain("API_TOKEN=<redacted>");
    expect(stderr).not.toContain("stderr-secret");
  });

  test("stderr tail truncation preserves every UTF-8 boundary", async () => {
    for (const character of ["é", "€", "😀"]) {
      const width = Buffer.byteLength(character);
      for (let offset = 0; offset < width; offset += 1) {
        const marker = `\ntail-${width}-${offset}`;
        const suffixBytes = RESOURCE_FAILURE_STDERR_MAX_BYTES - width + offset;
        const fillerBytes = suffixBytes - Buffer.byteLength(marker);
        const filler = "s ".repeat(Math.floor(fillerBytes / 2)) + "s".repeat(fillerBytes % 2);
        const stderrInput = `prefix${character}${filler}${marker}`;
        const collector = createResourceCollector({
          collectorId: `utf8-${width}-${offset}`,
          collect: async () => {
            throw new ResourceCollectorFailureError(
              "collector-crash",
              "collector-error",
              "resource collection failed",
              { stderr: stderrInput },
            );
          },
        });

        const result = await collector.observe(0, 1_000);
        const stderr = result.failure?.diagnostic.stderr ?? "";
        expect(Buffer.byteLength(stderr), `width ${width}, offset ${offset}`).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
        expect(stderr.includes("\uFFFD"), `width ${width}, offset ${offset}`).toBeFalse();
        expect(stderr.endsWith(marker), `width ${width}, offset ${offset}`).toBeTrue();
      }
    }
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
      expect.objectContaining({ observation: expect.objectContaining({ generation: 2, value: "two" }) }),
      expect.objectContaining({ observation: expect.objectContaining({ generation: 2, value: "two" }) }),
    ]);
  });

  test("a durable completed observation serves before any new collection starts", async () => {
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => {
        calls += 1;
        return "new";
      },
      initial: Object.freeze({ generation: 7, startedAt: 1, completedAt: 2, collectorId: "prior", value: "durable" }),
    });

    expect(collector.latest()).toMatchObject({ generation: 7, value: "durable" });
    expect(calls).toBe(0);
  });
});
