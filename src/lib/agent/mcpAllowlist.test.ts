import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";
import { AgentRegistry } from "./registry";

import {
  GRANTABLE_MCP_SERVERS,
  defaultMcpServersForOrigin,
  grantedMcpServers,
  mcpServersForSession,
  normalizeSpawnMcpServers,
} from "./mcpAllowlist";

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

test("an MCP server outside the grant bound is rejected, never silently dropped", () => {
  /* Actionable: the caller learns the bound and which name failed, instead of
     receiving a quietly trimmed allowlist it believes it got in full. The
     grantable `viewer` alongside it does not rescue the request. */
  expect(normalizeSpawnMcpServers(["viewer", "telegram"])).toEqual({
    ok: false,
    error: `mcpServers may only contain ${GRANTABLE_MCP_SERVERS.join(", ")}; rejected: telegram`,
  });
  expect(normalizeSpawnMcpServers(["*"])).toMatchObject({ ok: false });
  expect(normalizeSpawnMcpServers(["all"])).toMatchObject({ ok: false });
});

test("a delegated spawn cannot obtain a grantable connector and keeps its Viewer baseline", () => {
  expect(defaultMcpServersForOrigin("delegated")).toEqual(["viewer"]);
  expect(mcpServersForSession({ origin: "delegated", requested: ["viewer", "agent-browser"] }))
    .toEqual(["viewer"]);
  expect(mcpServersForSession({ origin: "delegated", requested: null })).toEqual(["viewer"]);
});

test("an operator-root spawn receives the grantable connector it requests", () => {
  expect(defaultMcpServersForOrigin("operator-root")).toEqual([...GRANTABLE_MCP_SERVERS]);
  expect(mcpServersForSession({ origin: "operator-root", requested: ["viewer", "agent-browser"] }))
    .toEqual(["viewer", "agent-browser"]);
});

test("an empty selection stays the explicit opt-out and still yields Viewer", () => {
  const requested = normalizeSpawnMcpServers([]);
  expect(requested).toEqual({ ok: true, value: ["viewer"] });
  expect(mcpServersForSession({ origin: "operator-root", requested: requested.ok ? requested.value : null }))
    .toEqual(["viewer"]);
  expect(mcpServersForSession({ origin: "delegated", requested: [] })).toEqual(["viewer"]);
});

test("a launch profile hand-edited to carry an ungranted server is re-bounded at the point of use", () => {
  expect(grantedMcpServers(["viewer", "telegram", "agent-browser"])).toEqual(["viewer", "agent-browser"]);
  expect(grantedMcpServers(undefined)).toEqual(["viewer"]);
  /* Durable storage re-bounds the edit as it is written, and every engine's
     enable table is materialized from the re-validated list, never the stored
     one — a profile edited behind the Viewer's back grants nothing. */
  expect(emptyLaunchProfile({ mcpServers: ["viewer", "telegram"] }).mcpServers).toEqual(["viewer"]);
  const thread = headlessCodexThreadConfig({
    config: { mcp_servers: { viewer: {}, telegram: {}, "agent-browser": {} } },
  }, false, ["viewer", "telegram", "agent-browser"]) as { mcp_servers: Record<string, { enabled: boolean }> };
  expect(thread.mcp_servers.viewer.enabled).toBe(true);
  expect(thread.mcp_servers["agent-browser"].enabled).toBe(true);
  expect(thread.mcp_servers.telegram.enabled).toBe(false);
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
