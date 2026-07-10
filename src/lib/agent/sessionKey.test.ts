import { describe, expect, test } from "bun:test";

import { sessionKeyFromArgv, sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";

const ID = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";

describe("engine-native session keys", () => {
  test("uses the engine and normalized native id", () => {
    const key = sessionKeyFromTranscript("codex", `/home/user/rollout-${ID.toUpperCase()}.jsonl`);
    expect(key && sessionKeyId(key)).toBe(`codex:${ID}`);
  });

  test("extracts a resume identity from argv", () => {
    expect(sessionKeyFromArgv("claude", ["claude", "--resume", ID])).toEqual({ engine: "claude", sessionId: ID });
  });

  test("rejects arbitrary path text", () => {
    expect(sessionKeyFromTranscript("codex", "/home/user/session.jsonl")).toBeNull();
  });
});
