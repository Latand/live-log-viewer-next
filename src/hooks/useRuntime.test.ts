import { describe, expect, test } from "bun:test";

import type { RuntimeReceipt, RuntimeSession } from "@/components/runtime/runtimeModel";

import { answerRuntime, interruptRuntime, sendRuntimeMessage, sessionForConversation } from "./useRuntime";

/*
 * P1#3 (round-1 review): launch-time assistant deltas must resolve by
 * conversation identity, not the transcript artifact path. During launch the
 * file path is `spawn:<launchId>` and the artifact does not exist yet, while the
 * runtime bus already carries the hosted session under its conversation id. An
 * artifact-only lookup returns null and the first deltas are lost; a
 * conversation-first lookup finds the live host. The transcript path stays a
 * fallback for a Claude subagent whose child transcript carries no bus id.
 */

function session(over: Partial<RuntimeSession> & { conversationId: string }): RuntimeSession {
  return {
    sessionKey: { engine: "codex", sessionId: "s" },
    hostKind: "codex-app-server",
    host: {} as RuntimeSession["host"],
    turn: {} as RuntimeSession["turn"],
    provenance: {} as RuntimeSession["provenance"],
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: null,
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: null,
    artifactPath: null,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null,
    liveTurn: { turnId: "t1", text: "streaming reply" },
    ...over,
  } as RuntimeSession;
}

describe("sessionForConversation", () => {
  const live = session({ conversationId: "conversation_live", artifactPath: "/real/rollout.jsonl" });
  const sessions = { conversation_live: live };

  test("resolves by conversation id even while the file path is still spawn:<launchId>", () => {
    // The launch window: path is the placeholder, artifact does not exist yet.
    expect(sessionForConversation(sessions, "conversation_live", "spawn:launch_abc")).toBe(live);
  });

  test("falls back to the transcript artifact path (subagent with no bus conversation id)", () => {
    expect(sessionForConversation(sessions, null, "/real/rollout.jsonl")).toBe(live);
    expect(sessionForConversation(sessions, "conversation_unknown", "/real/rollout.jsonl")).toBe(live);
  });

  test("an artifact-only lookup of the spawn placeholder path finds nothing (the regressed path)", () => {
    // This is exactly what the old useRuntimeSessionByArtifact(file.path) did.
    expect(sessionForConversation(sessions, null, "spawn:launch_abc")).toBeNull();
  });
});

describe("command HTTP evidence", () => {
  const receipt: RuntimeReceipt & { evidence: { recipient: string; dispatch: string } } = {
    operationId: "original-operation", idempotencyKey: "original-key",
    conversationId: "conversation-test", kind: "send", status: "failed",
    at: "2026-09-05T08:00:01.000Z", revision: 4, resend: "verify-first",
    reason: "Dispatch began; recipient transcript unavailable; arrival unverified",
    evidence: { recipient: "unavailable", dispatch: "began" },
  };
  const commands = [
    () => sendRuntimeMessage({ conversationId: receipt.conversationId, text: "Check status", idempotencyKey: receipt.idempotencyKey }),
    () => interruptRuntime(receipt.conversationId, receipt.operationId),
    () => answerRuntime(receipt.conversationId, "attention-test", "yes", receipt.operationId),
  ];
  test.each(commands)("retains the complete error receipt without reporting success", async command => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ operationId: receipt.operationId, receipt, error: "evidence unavailable" }, { status: 503 });
    }) as unknown as typeof fetch;
    try {
      expect(await command()).toEqual({ ok: false, status: 503, operationId: receipt.operationId, receipt, error: "evidence unavailable" });
      expect(calls).toBe(1);
    } finally { globalThis.fetch = original; }
  });
  test.each(["null", "[]", "broken-json", '{"receipt":false,"operationId":7,"error":{}}'])("malformed response %s keeps HTTP failure", async body => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 503 })) as unknown as typeof fetch;
    try {
      expect(await commands[0]!()).toEqual({ ok: false, status: 503, operationId: undefined, receipt: undefined, error: undefined });
    } finally { globalThis.fetch = original; }
  });
  test.each([400, 200])("preserves definitive evidence at HTTP %s", async status => {
    const original = globalThis.fetch;
    const definitive: RuntimeReceipt = { ...receipt, status: status === 200 ? "delivered" : "rejected", resend: status === 200 ? "not-needed" : "safe" };
    globalThis.fetch = (async () => Response.json({ receipt: definitive, error: "rejected" }, { status })) as unknown as typeof fetch;
    try {
      const result = await commands[0]!();
      expect(result.ok).toBe(status === 200);
      expect(result.status).toBe(status);
      expect(result.operationId).toBe(receipt.operationId);
      expect(result.receipt).toEqual(definitive);
      expect(result.error).toBe(status === 200 ? undefined : "rejected");
    } finally { globalThis.fetch = original; }
  });
  test("network rejection remains a failure without invented evidence", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("lost response"); }) as unknown as typeof fetch;
    try { expect(await commands[0]!()).toEqual({ ok: false, error: "network" }); }
    finally { globalThis.fetch = original; }
  });
});


test.each([202, 503])("held admission preserves identity and HTTP semantics at %s", async status => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ held: true, operationId: "held-operation" }, { status })) as unknown as typeof fetch;
  try {
    const result = await sendRuntimeMessage({ conversationId: "held-conversation", text: "Check status", idempotencyKey: "held-key" });
    expect(result.ok).toBe(status === 202);
    expect(result.status).toBe(status);
    expect(result.operationId).toBe("held-operation");
    expect(result.held).toBe(status === 202 ? true : undefined);
    expect(result.receipt).toBeUndefined();
  } finally { globalThis.fetch = original; }
});
