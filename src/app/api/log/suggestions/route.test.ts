import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-suggestions-route-"));
process.env.LLV_STATE_DIR = sandbox;

const routeModule = await import("./route");
const { GET } = routeModule;
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

function request(query: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898/api/log/suggestions${query}`, { headers: OPERATOR_HEADERS });
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

test("the read seam offers no way to retire a set — that is the send path's job", () => {
  /* A pane must not be able to take drafts down: the record is retired by the
     message that answers it, in the path that accepts that message. A mutating
     verb here would be a second, view-shaped way to lose the operator's
     current offer. */
  expect(Object.keys(routeModule).filter((name) => /^[A-Z]+$/.test(name))).toEqual(["GET"]);
});

test("a call without a conversation is refused rather than answered with somebody else's drafts", () => {
  expect(GET(request("")).status).toBe(400);
});
