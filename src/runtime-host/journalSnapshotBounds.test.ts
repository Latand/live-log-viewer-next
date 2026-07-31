import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

test("dead sessions retain durable audit state without shipping stale live text", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-snapshot-bounds-"));
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), { now: () => 100 });
  try {
    journal.append({
      scope: runtimeScope("session", "conversation-dead"),
      kind: "session-status",
      payload: {
        conversationId: "conversation-dead",
        sessionKey: { engine: "codex", sessionId: "session-dead" },
        hostKind: "codex-app-server",
        host: "dead",
        turn: "idle",
        provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
        liveTurn: { turnId: "turn-finished", text: "stale streamed text" },
      },
    });

    expect(journal.sessionState("conversation-dead")?.liveTurn?.text).toBe("stale streamed text");
    expect(journal.snapshot().sessions[0]?.liveTurn).toBeNull();
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
