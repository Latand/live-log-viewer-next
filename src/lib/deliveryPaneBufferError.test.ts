import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "./agent/registry";
import { deliverConversationMessage } from "./delivery";

const sandboxes: string[] = [];

afterEach(() => {
  setAgentRegistryForTests(null);
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("a failed legacy pane-buffer operation reaches the operator as words without its internal buffer id", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pane-buffer-error-"));
  sandboxes.push(sandbox);
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");

  const outcome = await deliverConversationMessage({
    pid: 203,
    path: "",
    conversationId: conversation.id,
    text: "continue the live turn",
    images: [],
    clientMessageId: "pane-buffer-failure",
  }, {
    targetForKnownPid: async () => "%20",
    sendText: async () => {
      throw new Error("no buffer viewer-1788205730123-481516");
    },
  });

  expect(outcome).toMatchObject({ ok: false, outcome: "failed" });
  expect(outcome.ok ? "" : outcome.error.toLowerCase()).toContain("pane buffer unreadable");
  expect(JSON.stringify(outcome)).not.toContain("viewer-1788205730123-481516");
});
