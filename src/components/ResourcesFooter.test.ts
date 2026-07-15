import { expect, test } from "bun:test";

import type { ResourcesPayload } from "@/lib/types";

import { createResourcesLoader } from "./ResourcesFooter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const payload: ResourcesPayload = { system: null, sessions: [] };

test("resource polling shares an in-flight request", async () => {
  const reply = deferred<Response>();
  const urls: string[] = [];
  const applied: ResourcesPayload[] = [];
  const loader = createResourcesLoader(
    async (input) => {
      urls.push(String(input));
      return reply.promise;
    },
    (value) => applied.push(value),
    () => {},
  );

  const first = loader.load();
  const overlappingPoll = loader.load();
  await Promise.resolve();
  expect(urls).toEqual(["/api/resources"]);

  reply.resolve(Response.json(payload));
  expect(await Promise.all([first, overlappingPoll])).toEqual([true, true]);
  expect(applied).toEqual([payload]);
});

test("a forced refresh waits for the current poll and then fetches fresh data", async () => {
  const ordinary = deferred<Response>();
  const fresh = deferred<Response>();
  const urls: string[] = [];
  const loader = createResourcesLoader(
    async (input) => {
      const url = String(input);
      urls.push(url);
      return url.includes("fresh=1") ? fresh.promise : ordinary.promise;
    },
    () => {},
    () => {},
  );

  const first = loader.load();
  const refreshOne = loader.load(true);
  const refreshTwo = loader.load(true);
  await Promise.resolve();
  expect(urls).toEqual(["/api/resources"]);

  ordinary.resolve(Response.json(payload));
  await first;
  await Promise.resolve();
  expect(urls).toEqual(["/api/resources", "/api/resources?fresh=1"]);

  fresh.resolve(Response.json(payload));
  expect(await Promise.all([refreshOne, refreshTwo])).toEqual([true, true]);
});

test("a failed request can be retried", async () => {
  let calls = 0;
  const loader = createResourcesLoader(
    async () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 503 }) : Response.json(payload);
    },
    () => {},
    () => {},
  );

  expect(await loader.load()).toBeFalse();
  expect(await loader.load()).toBeTrue();
  expect(calls).toBe(2);
});

test("dispose prevents a queued forced refresh from starting", async () => {
  const ordinary = deferred<Response>();
  const urls: string[] = [];
  const loader = createResourcesLoader(
    async (input) => {
      urls.push(String(input));
      return ordinary.promise;
    },
    () => {},
    () => {},
  );

  const first = loader.load();
  const queuedRefresh = loader.load(true);
  await Promise.resolve();
  expect(urls).toEqual(["/api/resources"]);

  loader.dispose();
  ordinary.resolve(Response.json(payload));

  expect(await first).toBeTrue();
  expect(await queuedRefresh).toBeFalse();
  expect(await loader.load(true)).toBeFalse();
  expect(urls).toEqual(["/api/resources"]);
});

test("dispose aborts the active resource request", async () => {
  const capture: { signal?: AbortSignal } = {};
  const loader = createResourcesLoader(
    async (_input, init) => {
      const requestSignal = init?.signal;
      if (!requestSignal) throw new Error("resource request must carry an abort signal");
      capture.signal = requestSignal;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    () => {
      throw new Error("disposed loader must not publish a payload");
    },
    () => {
      throw new Error("disposed loader must not publish a failure");
    },
  );

  const active = loader.load();
  await Promise.resolve();
  const signal = capture.signal;
  if (!signal) throw new Error("resource request did not start");
  expect(signal.aborted).toBeFalse();

  loader.dispose();
  expect(signal?.aborted).toBeTrue();
  expect(await active).toBeFalse();
});
