import { describe, expect, test } from "bun:test";

import type { RuntimeSession } from "@/components/runtime/runtimeModel";

import { sessionForConversation } from "./useRuntime";

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
