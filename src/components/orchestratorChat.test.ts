import { afterEach, expect, test } from "bun:test";

import { adoptOperatorCredential, resetOperatorCredentialForTests } from "./operatorCredential";
import { openOrchestratorConversation, orchestratorHash, orchestratorSpawnBody, type OrchestratorStatusBody } from "./orchestratorChat";

/** A well-shaped operator key: 32 random bytes base64url, as the server mints. */
const OPERATOR_KEY = "A".repeat(43);

/** The tab has been through `OperatorKeyGate` — it holds the operator secret. */
function authorizeBrowser(): void {
  expect(adoptOperatorCredential(OPERATOR_KEY)).toBe(true);
}

afterEach(() => {
  resetOperatorCredentialForTests();
});

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
  authorizeBrowser();
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
  authorizeBrowser();
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: { conversationId: "conv-old", path: "/gone.jsonl" }, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ ok: true, conversationId: "conv-new", path: null }),
    "POST /api/orchestrator": () => jsonResponse({ ok: true, adopted: true, record: { conversationId: "conv-new", path: null } }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-new");
  expect(calls).toHaveLength(3);
});

test("spawn failures surface the server error", async () => {
  authorizeBrowser();
  const { fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
    "POST /api/spawn": () => jsonResponse({ error: "directory does not exist: /repo" }, 400),
  });
  await expect(openOrchestratorConversation(fetch)).rejects.toThrow("directory does not exist: /repo");
});

test("an unauthorized browser spawns NOTHING — no spawn, no adoption, four stalled managers never again", async () => {
  /* No credential adopted: this tab never went through the operator key gate. */
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: null, exists: false, defaultCwd: "/repo" }),
  });
  await expect(openOrchestratorConversation(fetch)).rejects.toThrow("operator authority");
  /* The old order spawned first and failed adoption after — every click leaked
     one live manager. The refusal must come before any side effect. */
  expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
    "GET /api/orchestrator",
  ]);
});

test("an existing live record opens even in an unauthorized browser", async () => {
  const { calls, fetch } = fetchStub({
    "GET /api/orchestrator": () => jsonResponse({ record: { conversationId: "conv-1", path: "/t.jsonl" }, exists: true, defaultCwd: "/repo" }),
  });
  expect(await openOrchestratorConversation(fetch)).toBe("conv-1");
  expect(calls).toHaveLength(1);
});
