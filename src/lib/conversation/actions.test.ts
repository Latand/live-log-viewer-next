import { expect, test } from "bun:test";

import { applyConversationAction } from "./actions";

function conversation(id: `conversation_${string}`, paths: string[]) {
  return {
    id,
    generations: paths.map((path, index) => ({ id: `session_${index}`, path })),
    continuityPaths: [] as string[],
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

test("conversation actions reject a supplied path that has no durable owner", async () => {
  const owner = conversation("conversation_owner", ["/sessions/owner.jsonl"]);
  let dispatched = false;
  const result = await applyConversationAction({
    operationId: "unresolved-path-selector",
    conversationId: owner.id,
    transcriptPath: "/sessions/owner.jsonl",
    action: "interrupt",
  }, {
    registry: () => ({
      conversation: () => owner,
      conversationForPath: () => null,
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

test("structured conversation actions reject an unknown supplied id before path-based dispatch", async () => {
  const owner = conversation("conversation_owner", ["/sessions/owner.jsonl"]);
  let dispatches = 0;
  let deliveries = 0;
  const delivered = async () => {
    deliveries += 1;
    return { ok: true as const, target: "%1" };
  };
  const result = await applyConversationAction({
    operationId: "unknown-selector",
    conversationId: "conversation_unknown",
    transcriptPath: "/sessions/owner.jsonl",
    action: "interrupt",
  }, {
    registry: () => ({
      conversation: () => null,
      conversationForPath: () => owner,
    } as never),
    structuredEnabled: () => true,
    dispatchStructuredControl: async () => {
      dispatches += 1;
      return { status: 200, body: { ok: true, structured: true, target: owner.id, outcome: "delivered" } };
    },
    interruptConversation: delivered,
    killConversation: delivered,
    resumeConversation: delivered,
    compactConversation: delivered,
    answerDialogKey: delivered,
  });

  expect(result).toEqual({ status: 404, body: { error: "viewer conversation is unknown" } });
  expect(dispatches).toBe(0);
  expect(deliveries).toBe(0);
});

test("legacy conversation actions reject an unknown supplied id before delivery", async () => {
  const owner = conversation("conversation_owner", ["/sessions/owner.jsonl"]);
  let dispatches = 0;
  let deliveries = 0;
  const delivered = async () => {
    deliveries += 1;
    return { ok: true as const, target: "%1" };
  };
  const result = await applyConversationAction({
    conversationId: "conversation_unknown",
    transcriptPath: "/sessions/owner.jsonl",
    action: "interrupt",
  }, {
    registry: () => ({
      conversation: () => null,
      conversationForPath: () => owner,
    } as never),
    structuredEnabled: () => false,
    dispatchStructuredControl: async () => {
      dispatches += 1;
      return null;
    },
    interruptConversation: delivered,
    killConversation: delivered,
    resumeConversation: delivered,
    compactConversation: delivered,
    answerDialogKey: delivered,
  });

  expect(result).toEqual({ status: 404, body: { error: "viewer conversation is unknown" } });
  expect(dispatches).toBe(0);
  expect(deliveries).toBe(0);
});

test("current and continuity selectors remain valid in structured and legacy routing", async () => {
  const owner = conversation("conversation_owner", ["/sessions/old.jsonl", "/sessions/current.jsonl"]);
  owner.continuityPaths.push("/sessions/continuity.jsonl");
  for (const structured of [true, false]) {
    for (const transcriptPath of ["/sessions/current.jsonl", "/sessions/continuity.jsonl"]) {
      let dispatches = 0;
      let deliveries = 0;
      const result = await applyConversationAction({
        operationId: `valid-${structured}-${transcriptPath}`,
        conversationId: owner.id,
        transcriptPath,
        action: "interrupt",
      }, {
        registry: () => ({
          conversation: () => owner,
          conversationForPath: (candidate: string) => (
            candidate === "/sessions/current.jsonl" || candidate === "/sessions/continuity.jsonl"
              ? owner
              : null
          ),
        } as never),
        structuredEnabled: () => structured,
        dispatchStructuredControl: async () => {
          dispatches += 1;
          return { status: 200, body: { ok: true, structured: true, target: owner.id, outcome: "delivered" } };
        },
        interruptConversation: async (target) => {
          deliveries += 1;
          return { ok: true, target };
        },
        killConversation: async () => ({ ok: true, target: "%1" }),
        resumeConversation: async () => ({ ok: true, target: "%1" }),
        compactConversation: async () => ({ ok: true, target: "%1" }),
        answerDialogKey: async () => ({ ok: true, target: "%1" }),
      });

      expect(result.status).toBe(200);
      expect(dispatches).toBe(structured ? 1 : 0);
      expect(deliveries).toBe(structured ? 0 : 1);
    }
  }
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
