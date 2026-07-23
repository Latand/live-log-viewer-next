import { expect, test } from "bun:test";

import { applyConversationAction } from "./actions";

function conversation(id: `conversation_${string}`, paths: string[]) {
  return {
    id,
    generations: paths.map((path, index) => ({ id: `session_${index}`, path })),
    continuityPaths: [],
  };
}

test("conversation actions reject a transcript path owned by another durable conversation", async () => {
  const first = conversation("conversation_first", ["/sessions/first.jsonl"]);
  const second = conversation("conversation_second", ["/sessions/second.jsonl"]);
  let dispatched = false;
  const result = await applyConversationAction({
    operationId: "ownership-fence",
    conversationId: first.id,
    transcriptPath: "/sessions/second.jsonl",
    action: "interrupt",
  }, {
    registry: () => ({
      conversation: (id: string) => id === first.id ? first : second,
      conversationForPath: (pathname: string) => pathname === "/sessions/second.jsonl" ? second : first,
    } as never),
    structuredEnabled: () => true,
    dispatchStructuredControl: async () => { dispatched = true; return null; },
    interruptConversation: async () => ({ ok: true, target: "%1" }),
    killConversation: async () => ({ ok: true, target: "%1" }),
    resumeConversation: async () => ({ ok: true, target: "%1" }),
    compactConversation: async () => ({ ok: true, target: "%1" }),
    answerDialogKey: async () => ({ ok: true, target: "%1" }),
  });

  expect(result).toEqual({ status: 409, body: { error: "conversation identity does not own transcript path" } });
  expect(dispatched).toBe(false);
});

test("conversation actions carry the stable operation id through the structured ownership lane", async () => {
  const owner = conversation("conversation_owner", ["/sessions/old.jsonl", "/sessions/current.jsonl"]);
  const controls: unknown[] = [];
  const result = await applyConversationAction({
    operationId: "stable-operation-608",
    conversationId: owner.id,
    transcriptPath: "/sessions/old.jsonl",
    action: "kill",
  }, {
    registry: () => ({
      conversation: () => owner,
      conversationForPath: () => owner,
    } as never),
    structuredEnabled: () => true,
    dispatchStructuredControl: async (request) => {
      controls.push(request);
      return { status: 202, body: { ok: true, structured: true, target: owner.id, operationId: request.operationId!, receipt: { operationId: request.operationId!, status: "queued" } } };
    },
    interruptConversation: async () => ({ ok: true, target: "%1" }),
    killConversation: async () => ({ ok: true, target: "%1" }),
    resumeConversation: async () => ({ ok: true, target: "%1" }),
    compactConversation: async () => ({ ok: true, target: "%1" }),
    answerDialogKey: async () => ({ ok: true, target: "%1" }),
  });

  expect(controls).toEqual([{
    path: "/sessions/current.jsonl",
    conversationId: owner.id,
    action: "kill",
    operationId: "stable-operation-608",
  }]);
  expect(result).toMatchObject({ status: 202, body: { operationId: "stable-operation-608", receipt: { status: "queued" } } });
});
