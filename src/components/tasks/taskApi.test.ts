import { afterEach, expect, test } from "bun:test";

import { createTaskSpawnGesture, spawnTaskAgent } from "./taskApi";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("task spawn gestures own distinct replay-stable attempt identities", async () => {
  const first = createTaskSpawnGesture({ engine: "claude", cwd: "/repo", model: "opus" });
  const second = createTaskSpawnGesture({ engine: "claude", cwd: "/repo", model: "opus" });
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ error: "lost response" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await spawnTaskAgent("task-1", first);
  await spawnTaskAgent("task-1", first);
  await spawnTaskAgent("task-1", second);

  expect(first.clientAttemptId).not.toBe(second.clientAttemptId);
  expect(bodies).toEqual([first, first, second]);
});
