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
const {
  readReplySuggestionsFile,
  recordReplySuggestions,
  replySuggestionsFile,
  retireReplySuggestionsOnOperatorMessage,
} = await import("@/lib/suggestions/store");

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

test("drafts the operator has answered stay off the read even when the clear could not be written, and the record catches up", async () => {
  const conversationId = "conversation_write_failed";
  recordReplySuggestions({
    conversationId,
    replies: [{ label: "hold", text: "Hold. Explain the rollback first." }],
    origin: { kind: "manager", conversationId, role: "orchestrator" },
    at: new Date(Date.now() - 60_000),
  });

  /* Every write to the record blocked at the shared file transaction's own
     queue: a plain file where it enqueues refuses the mkdir, which is how a
     busy lock, a full disk and a read-only state dir all arrive. */
  const queuePath = `${replySuggestionsFile()}.write-locks`;
  fs.rmSync(queuePath, { recursive: true, force: true });
  fs.writeFileSync(queuePath, "blocked", "utf8");

  const retirement = retireReplySuggestionsOnOperatorMessage(conversationId, new Date(), "operator-answer-unwritable");
  /* The operator's message is never held hostage by this record. */
  expect(retirement).toEqual({ cleared: false, pending: true });

  const blocked = await GET(request(`?conversationId=${conversationId}`)).json() as { set: unknown };
  expect(blocked.set).toBeNull();
  expect(readReplySuggestionsFile().sets.some((set) => set.conversationId === conversationId)).toBe(true);

  fs.rmSync(queuePath);
  const recovered = await GET(request(`?conversationId=${conversationId}`)).json() as { set: unknown };
  expect(recovered.set).toBeNull();
  /* The retry rode the read: nothing had to send a second message for the
     record to agree with what the operator is being shown. */
  expect(readReplySuggestionsFile().sets.some((set) => set.conversationId === conversationId)).toBe(false);
});
