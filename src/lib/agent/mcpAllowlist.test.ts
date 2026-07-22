import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "./registry";

import { normalizeSpawnMcpServers } from "./mcpAllowlist";

test("a spawn without an MCP selection receives Viewer only", () => {
  expect(normalizeSpawnMcpServers(undefined)).toEqual({ ok: true, value: ["viewer"] });
});

test("a custom MCP selection is deduplicated and force-includes Viewer", () => {
  expect(normalizeSpawnMcpServers(["agent-browser", "viewer", "agent-browser"]))
    .toEqual({ ok: true, value: ["viewer", "agent-browser"] });
});

test("malformed MCP selections are rejected", () => {
  for (const value of ["viewer", ["viewer", 42], [""], ["two words"]]) {
    expect(normalizeSpawnMcpServers(value)).toEqual({
      ok: false,
      error: "mcpServers must be an array of non-empty server names",
    });
  }
});

test("durable launch profiles reset each new spawn to Viewer only", () => {
  expect(emptyLaunchProfile().mcpServers).toEqual(["viewer"]);
});

test("a nested spawn resets its parent allowlist while resume preserves it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-nested-reset-"));
  try {
    const store = new AgentRegistry(path.join(directory, "registry.json"));
    const parent = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      launchProfile: { mcpServers: ["viewer", "agent-browser"] },
    });
    if (parent.kind !== "created") throw new Error("expected parent reservation");
    const settled = store.settleSpawn(parent.receipt.launchId, {
      key: { engine: "codex", sessionId: "nested-parent" },
      artifactPath: "/sessions/nested-parent.jsonl",
      cwd: "/repo",
      accountId: "account",
      status: "idle",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("expected parent settlement");

    const child = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      parentConversationId: settled.conversation.id,
      origin: { kind: "agent", conversationId: settled.conversation.id },
    });
    expect(child.receipt.launchProfile.mcpServers).toEqual(["viewer"]);

    const resumed = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      conversationId: settled.conversation.id,
      purpose: "resume-successor",
    });
    expect(resumed.receipt.launchProfile.mcpServers).toEqual(["viewer", "agent-browser"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
