import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import {
  AgentRegistry,
  readOnlyConversationLookupFromSnapshot,
} from "./registry";

test("the read-only conversation lookup shares immutable snapshot entries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-read-only-lookup-"));
  try {
    const transcript = path.join(directory, "session.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    registry.reconcileConversations([{
      engine: "codex",
      path: transcript,
      accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: "/fixtures/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-31T00:00:00.000Z",
    }]);
    const snapshot = registry.readOnlySnapshot();
    const conversation = Object.values(snapshot.conversations)[0]!;

    const lookup = readOnlyConversationLookupFromSnapshot(snapshot);

    expect(lookup.conversationForPath(transcript)).toBe(conversation);
    expect(lookup.conversation(conversation.id)).toBe(conversation);
    expect(lookup.canonicalConversationId(conversation.id)).toBe(conversation.id);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
