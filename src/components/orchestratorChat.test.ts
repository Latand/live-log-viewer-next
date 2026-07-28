import { expect, test } from "bun:test";

import { openOrchestratorConversation, orchestratorHash, orchestratorSpawnBody, type OrchestratorStatusBody } from "./orchestratorChat";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fetchStub(handlers: Record<string, (init?: RequestInit) => Response>): { calls: { url: string; init?: RequestInit }[]; fetch: typeof fetch } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${url}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler(init);
  }) as typeof fetch;
  return { calls, fetch: stub };
}

test("spawn body carries the fable-low orchestrator preset and the system prompt", () => {
  const body = orchestratorSpawnBody("/repo");
  expect(body).toMatchObject({ engine: "claude", model: "fable", effort: "low", role: "orchestrator", cwd: "/repo" });
  expect(String(body.prompt)).toContain("NEVER auto-start pipelines");
});

test("hash targets the canonical #c= deep link", () => {
  expect(orchestratorHash("conv/1")).toBe("#c=conv%2F1");
});

test("a live record opens without spawning", async () => {
  const status: OrchestratorStatusBody = { record: { conversationId: "conv-1", path: "/t.jsonl" }, exists: true, defaultCwd: "/repo" };
  const { calls, fetch } = fetchStub({ "GET /api/orchestrator": () => jsonResponse(status) });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-1");
  expect(calls).toHaveLength(1);
});

const OPERATOR_YES = { "GET /api/operator/session": () => jsonResponse({ operator: true }) };

test("an empty slot spawns, adopts, and returns the canonical winner", async () => {
  const { calls, fetch } = fetchStub({
    ...OPERATOR_YES,
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ ok: true, conversationId: "conv-new", path: "/new.jsonl", state: "settled" }),
    "POST /api/orchestrator": () => jsonResponse({ ok: true, adopted: false, record: { conversationId: "conv-winner", path: null } }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-winner");
  const spawnBody = JSON.parse(String(calls[2]!.init?.body)) as Record<string, unknown>;
  expect(spawnBody).toMatchObject({ role: "orchestrator", cwd: "/repo", effort: "low" });
  const adoptBody = JSON.parse(String(calls[3]!.init?.body)) as Record<string, unknown>;
  expect(adoptBody).toEqual({ conversationId: "conv-new", path: "/new.jsonl" });
});

test("a dead transcript respawns instead of navigating to the tombstone", async () => {
  const { calls, fetch } = fetchStub({
    ...OPERATOR_YES,
    "GET /api/orchestrator": () => jsonResponse({ record: { conversationId: "conv-old", path: "/gone.jsonl" }, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ ok: true, conversationId: "conv-new", path: null }),
    "POST /api/orchestrator": () => jsonResponse({ ok: true, adopted: true, record: { conversationId: "conv-new", path: null } }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-new");
  expect(calls).toHaveLength(4);
});

test("spawn failures surface the server error", async () => {
  const { fetch } = fetchStub({
    ...OPERATOR_YES,
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ error: "directory does not exist: /repo" }, 400),
  });
  await expect(openOrchestratorConversation(fetch)).rejects.toThrow("directory does not exist: /repo");
});

test("an unauthorized browser spawns NOTHING — no spawn, no adoption, four stalled managers never again", async () => {
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "GET /api/operator/session": () => jsonResponse({ operator: false }),
  });
  await expect(openOrchestratorConversation(fetch)).rejects.toThrow("operator authority");
  /* The old order spawned first and failed adoption after — every click leaked
     one live manager. The refusal must come before any side effect. */
  expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
    "GET /api/orchestrator",
    "GET /api/operator/session",
  ]);
});

test("an existing live record opens even in an unauthorized browser", async () => {
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: { conversationId: "conv-1", path: "/t.jsonl" }, exists: true, defaultCwd: "/repo" }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-1");
  expect(calls).toHaveLength(1);
});
