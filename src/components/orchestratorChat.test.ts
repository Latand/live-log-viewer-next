import { expect, test } from "bun:test";

import { openOrchestratorConversation, orchestratorHash, orchestratorSpawnBody, type OrchestratorStatusBody } from "./orchestratorChat";

/**
 * ONE CLICK, FROM AN ORDINARY TAB.
 *
 * Nothing here authorizes the browser first, and nothing may need to: the paste
 * ceremony that used to stand between the click and the manager was rejected on
 * stage. Every case below runs in a tab that has never seen a key.
 */

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

test("spawn body carries the opus-low orchestrator preset and the system prompt", () => {
  const body = orchestratorSpawnBody("/repo");
  expect(body).toMatchObject({ engine: "claude", model: "opus", effort: "low", role: "orchestrator", cwd: "/repo" });
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

test("an empty slot spawns, adopts, and returns the canonical winner", async () => {
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ ok: true, conversationId: "conv-new", path: "/new.jsonl", state: "settled" }),
    "POST /api/orchestrator": () => jsonResponse({ ok: true, adopted: false, record: { conversationId: "conv-winner", path: null } }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-winner");
  const spawnBody = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>;
  expect(spawnBody).toMatchObject({ role: "orchestrator", cwd: "/repo", effort: "low" });
  const adoptBody = JSON.parse(String(calls[2]!.init?.body)) as Record<string, unknown>;
  expect(adoptBody).toEqual({ conversationId: "conv-new", path: "/new.jsonl" });
});

test("a dead transcript respawns instead of navigating to the tombstone", async () => {
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: { conversationId: "conv-old", path: "/gone.jsonl" }, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ ok: true, conversationId: "conv-new", path: null }),
    "POST /api/orchestrator": () => jsonResponse({ ok: true, adopted: true, record: { conversationId: "conv-new", path: null } }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-new");
  expect(calls).toHaveLength(3);
});

test("spawn failures surface the server error", async () => {
  const { fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ error: "directory does not exist: /repo" }, 400),
  });
  await expect(openOrchestratorConversation(fetch)).rejects.toThrow("directory does not exist: /repo");
});

test("REGRESSION: a fresh tab with no key, no cookie and nothing pasted opens the manager in one click", async () => {
  /* The rejected build refused here — `hasOperatorCredential()` was false in every
     tab that had not been through the paste gate, so the click threw instead of
     spawning, and a reload put the operator back in that state. */
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ ok: true, conversationId: "conv-fresh", path: "/fresh.jsonl" }),
    "POST /api/orchestrator": () => jsonResponse({ ok: true, adopted: true, record: { conversationId: "conv-fresh", path: "/fresh.jsonl" } }),
  });

  expect(await openOrchestratorConversation(fetch)).toBe("conv-fresh");
  /* Reuse-or-spawn-or-adopt, in one gesture and with no unlock step between. */
  expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
    "GET /api/orchestrator",
    "POST /api/spawn",
    "POST /api/orchestrator",
  ]);
});

test("REGRESSION: the adoption presents no credential header of any kind", async () => {
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ ok: true, conversationId: "conv-bare", path: null }),
    "POST /api/orchestrator": () => jsonResponse({ ok: true, adopted: true, record: { conversationId: "conv-bare", path: null } }),
  });
  await openOrchestratorConversation(fetch);

  for (const call of calls) {
    const headers = new Headers(call.init?.headers ?? {});
    /* Not the capability header, and not anything else that smells like one: the
       browser proves nothing and needs to prove nothing. */
    expect(headers.get("x-viewer-spawn-capability")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect([...headers.keys()].filter((name) => name !== "content-type")).toEqual([]);
  }
});

test("an existing live record opens in one call", async () => {
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: { conversationId: "conv-1", path: "/t.jsonl" }, exists: true, defaultCwd: "/repo" }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-1");
  expect(calls).toHaveLength(1);
});
