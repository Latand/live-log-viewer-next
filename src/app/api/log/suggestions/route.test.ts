import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-suggestions-route-"));
process.env.LLV_STATE_DIR = sandbox;

const { GET, DELETE } = await import("./route");
const { recordReplySuggestions } = await import("@/lib/suggestions/store");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const OPERATOR_HEADERS = {
  host: "127.0.0.1:8898",
  origin: "http://127.0.0.1:8898",
  "sec-fetch-site": "same-origin",
};

function request(query: string, method: "GET" | "DELETE" = "GET"): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898/api/log/suggestions${query}`, { method, headers: OPERATOR_HEADERS });
}

test("the route answers a conversation's current set, and nothing for one without", async () => {
  recordReplySuggestions({
    conversationId: "conversation_a",
    replies: [{ label: "yes, do it", text: "Yes — go ahead." }],
    origin: { kind: "manager", conversationId: "conversation_a", role: "orchestrator" },
  });

  const found = await GET(request("?conversationId=conversation_a")).json() as { set: { replies: unknown[] } | null };
  expect(found.set?.replies).toEqual([{ label: "yes, do it", text: "Yes — go ahead." }]);

  const empty = await GET(request("?conversationId=conversation_b")).json() as { set: unknown };
  expect(empty.set).toBeNull();
});

test("the operator's message clears the set through DELETE, and clearing twice is honest about it", async () => {
  recordReplySuggestions({
    conversationId: "conversation_c",
    replies: [{ label: "hold", text: "Hold." }],
    origin: { kind: "manager", conversationId: "conversation_c", role: "orchestrator" },
  });

  expect(await DELETE(request("?conversationId=conversation_c", "DELETE")).json()).toEqual({ cleared: true });
  expect(await DELETE(request("?conversationId=conversation_c", "DELETE")).json()).toEqual({ cleared: false });
  expect((await GET(request("?conversationId=conversation_c")).json() as { set: unknown }).set).toBeNull();
});

test("a call without a conversation is refused rather than answered with somebody else's drafts", () => {
  expect(GET(request("")).status).toBe(400);
  expect(DELETE(request("", "DELETE")).status).toBe(400);
});
