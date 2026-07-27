import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";
import { AgentRegistry, reboundStoredMcpGrants } from "./registry";
import type { RegistryFile } from "./registry";

import {
  GRANTABLE_MCP_SERVERS,
  MCP_GRANT_POLICY,
  defaultMcpServersForOrigin,
  grantedMcpServers,
  mcpServersForSession,
  mcpServersForStoredSession,
  normalizeSpawnMcpServers,
  type McpGrantPolicy,
} from "./mcpAllowlist";

/** A policy shaped like the one tranche 2 will ship, so the origin rules are
    exercised against a connector that is genuinely grantable. Proving them
    against the shipped bound would prove only that it is currently empty. */
const WITH_CONNECTOR: McpGrantPolicy = Object.freeze({
  grantable: Object.freeze(["viewer", "test-connector"]),
  operatorRoot: Object.freeze(["viewer", "test-connector"]),
  delegated: Object.freeze(["viewer"]),
});

test("tranche 1 ships no grantable connector beyond the Viewer baseline", () => {
  expect([...GRANTABLE_MCP_SERVERS]).toEqual(["viewer"]);
  expect([...MCP_GRANT_POLICY.operatorRoot]).toEqual(["viewer"]);
  expect([...MCP_GRANT_POLICY.delegated]).toEqual(["viewer"]);
});

test("a spawn without an MCP selection receives Viewer only", () => {
  expect(normalizeSpawnMcpServers(undefined)).toEqual({ ok: true, value: ["viewer"] });
});

test("a custom MCP selection is deduplicated and force-includes Viewer", () => {
  expect(normalizeSpawnMcpServers(["test-connector", "viewer", "test-connector"], WITH_CONNECTOR))
    .toEqual({ ok: true, value: ["viewer", "test-connector"] });
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
    error: "mcpServers may only contain viewer; rejected: telegram",
  });
  expect(normalizeSpawnMcpServers(["*"])).toMatchObject({ ok: false });
  expect(normalizeSpawnMcpServers(["all"])).toMatchObject({ ok: false });
  /* Every configured server is outside the bound this tranche, whoever asks. */
  expect(normalizeSpawnMcpServers(["agent-browser"])).toMatchObject({ ok: false });
});

test("a delegated spawn cannot obtain a grantable connector and keeps its Viewer baseline", () => {
  expect(defaultMcpServersForOrigin("delegated", WITH_CONNECTOR)).toEqual(["viewer"]);
  expect(mcpServersForSession({ origin: "delegated", requested: ["viewer", "test-connector"] }, WITH_CONNECTOR))
    .toEqual(["viewer"]);
  expect(mcpServersForSession({ origin: "delegated", requested: null }, WITH_CONNECTOR)).toEqual(["viewer"]);
});

test("an operator-root spawn receives the grantable connector it requests", () => {
  expect(defaultMcpServersForOrigin("operator-root", WITH_CONNECTOR)).toEqual(["viewer", "test-connector"]);
  expect(mcpServersForSession({ origin: "operator-root", requested: ["viewer", "test-connector"] }, WITH_CONNECTOR))
    .toEqual(["viewer", "test-connector"]);
});

test("an empty selection stays the explicit opt-out and still yields Viewer", () => {
  const requested = normalizeSpawnMcpServers([], WITH_CONNECTOR);
  expect(requested).toEqual({ ok: true, value: ["viewer"] });
  expect(mcpServersForSession({ origin: "operator-root", requested: requested.ok ? requested.value : null }, WITH_CONNECTOR))
    .toEqual(["viewer"]);
  expect(mcpServersForSession({ origin: "delegated", requested: [] }, WITH_CONNECTOR)).toEqual(["viewer"]);
});

test("a stored grant is re-decided from the session's durable origin, not replayed", () => {
  const tampered = ["viewer", "test-connector"];
  /* The delegation signals #393 records, one at a time: each is enough on its
     own, so a tampered profile cannot ride in on the other two being absent. */
  expect(mcpServersForStoredSession({ agentRole: "builder", requested: tampered }, WITH_CONNECTOR)).toEqual(["viewer"]);
  expect(mcpServersForStoredSession({ parentConversationId: "conversation_parent", requested: tampered }, WITH_CONNECTOR)).toEqual(["viewer"]);
  expect(mcpServersForStoredSession({ delegationDepth: 1, requested: tampered }, WITH_CONNECTOR)).toEqual(["viewer"]);
  expect(mcpServersForStoredSession({ origin: { kind: "agent" }, requested: tampered }, WITH_CONNECTOR)).toEqual(["viewer"]);
  /* The operator's own root keeps what it was granted. */
  expect(mcpServersForStoredSession({ delegationDepth: 0, requested: tampered }, WITH_CONNECTOR))
    .toEqual(["viewer", "test-connector"]);
});

test("a launch profile hand-edited to carry an ungranted server is re-bounded at the point of use", () => {
  expect(grantedMcpServers(["viewer", "telegram", "test-connector"], WITH_CONNECTOR)).toEqual(["viewer", "test-connector"]);
  expect(grantedMcpServers(["viewer", "telegram"])).toEqual(["viewer"]);
  expect(grantedMcpServers(undefined)).toEqual(["viewer"]);
  /* Durable storage re-bounds the edit as it is written, and every engine's
     enable table is materialized from the re-validated list, never the stored
     one — a profile edited behind the Viewer's back grants nothing. */
  expect(emptyLaunchProfile({ mcpServers: ["viewer", "telegram"] }).mcpServers).toEqual(["viewer"]);
  const thread = headlessCodexThreadConfig({
    config: { mcp_servers: { viewer: {}, telegram: {}, "agent-browser": {} } },
  }, false, ["viewer", "telegram", "agent-browser"]) as { mcp_servers: Record<string, { enabled: boolean }> };
  expect(thread.mcp_servers.viewer.enabled).toBe(true);
  expect(thread.mcp_servers["agent-browser"].enabled).toBe(false);
  expect(thread.mcp_servers.telegram.enabled).toBe(false);
});

test("durable launch profiles reset each new spawn to Viewer only", () => {
  expect(emptyLaunchProfile().mcpServers).toEqual(["viewer"]);
});

function settledParent(store: AgentRegistry, mcpServers: string[]) {
  const parent = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    launchProfile: { mcpServers },
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
  return settled.conversation.id;
}

test("a nested spawn resets its parent allowlist while resume preserves it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-nested-reset-"));
  try {
    const store = new AgentRegistry(path.join(directory, "registry.json"));
    const parentId = settledParent(store, ["viewer"]);

    const child = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      parentConversationId: parentId,
      origin: { kind: "agent", conversationId: parentId },
    });
    expect(child.receipt.launchProfile.mcpServers).toEqual(["viewer"]);

    const resumed = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      conversationId: parentId,
      purpose: "resume-successor",
    });
    /* The operator root keeps its grant across a resume; with this tranche's
       empty bound that grant is the baseline itself. */
    expect(resumed.receipt.launchProfile.mcpServers).toEqual(["viewer"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the storage boundary re-decides a grantable connector by the conversation's durable origin", () => {
  /* Registry-shaped input, exercised against a policy that has a connector to
     lose — the shipped bound has none, so with it this file could never tell an
     origin reset apart from the bound doing the work. */
  const profileFor = (mcpServers: string[], parentConversationId: string | null) => ({
    ...emptyLaunchProfile(),
    parentConversationId: parentConversationId as never,
    mcpServers,
  });
  const file = {
    conversations: {
      root: {
        id: "conversation_root",
        engine: "codex",
        agentRole: null,
        delegationDepth: 0,
        generations: [{ id: "root-generation", launchProfile: profileFor(["viewer", "test-connector"], null) }],
      },
      worker: {
        id: "conversation_worker",
        engine: "codex",
        agentRole: "builder",
        delegationDepth: 1,
        generations: [{ id: "worker-generation", launchProfile: profileFor(["viewer", "test-connector"], "conversation_root") }],
      },
    },
    entries: {
      "codex:root-generation": { launchProfile: profileFor(["viewer", "test-connector"], null) },
      "codex:worker-generation": { launchProfile: profileFor(["viewer", "test-connector"], "conversation_root") },
    },
  } as unknown as RegistryFile;

  const rebounded = reboundStoredMcpGrants(file, WITH_CONNECTOR);

  expect(rebounded.conversations.root!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer", "test-connector"]);
  expect(rebounded.conversations.worker!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer"]);
  /* The entry row is the copy structured host adoption reads, so it moves too. */
  expect(rebounded.entries["codex:root-generation"]!.launchProfile!.mcpServers).toEqual(["viewer", "test-connector"]);
  expect(rebounded.entries["codex:worker-generation"]!.launchProfile!.mcpServers).toEqual(["viewer"]);
});

test("a delegated conversation cannot keep a hand-edited grant across resume or reload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-tamper-"));
  const registryPath = path.join(directory, "registry.json");
  try {
    const store = new AgentRegistry(registryPath);
    const parentId = settledParent(store, ["viewer"]);
    const child = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      role: "builder",
      parentConversationId: parentId,
      origin: { kind: "agent", conversationId: parentId },
    });
    if (child.kind !== "created") throw new Error("expected child reservation");
    const settledChild = store.settleSpawn(child.receipt.launchId, {
      key: { engine: "codex", sessionId: "delegated-worker" },
      artifactPath: "/sessions/delegated-worker.jsonl",
      cwd: "/repo",
      accountId: "account",
      status: "idle",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    if (settledChild.kind !== "settled") throw new Error("expected child settlement");

    /* The worker edits the durable file it can reach on disk, naming a server
       that IS inside the grant bound — the global bound alone would honour it. */
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      conversations: Record<string, { generations: { launchProfile: { mcpServers: string[] } }[] }>;
      entries: Record<string, { launchProfile?: { mcpServers: string[] } }>;
    };
    const conversation = raw.conversations[settledChild.conversation.id]!;
    for (const generation of conversation.generations) generation.launchProfile.mcpServers = ["viewer", "granted-connector"];
    for (const entry of Object.values(raw.entries)) {
      if (entry.launchProfile) entry.launchProfile.mcpServers = ["viewer", "granted-connector"];
    }
    fs.writeFileSync(registryPath, JSON.stringify(raw));

    const reloaded = new AgentRegistry(registryPath);
    const profile = reloaded.launchProfileForPath("/sessions/delegated-worker.jsonl");
    expect(profile?.mcpServers).toEqual(["viewer"]);
    const snapshot = reloaded.snapshot();
    for (const entry of Object.values(snapshot.entries)) {
      expect(entry.launchProfile?.mcpServers ?? ["viewer"]).toEqual(["viewer"]);
    }
    const resumed = reloaded.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      conversationId: settledChild.conversation.id,
      purpose: "resume-successor",
    });
    expect(resumed.receipt.launchProfile.mcpServers).toEqual(["viewer"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
