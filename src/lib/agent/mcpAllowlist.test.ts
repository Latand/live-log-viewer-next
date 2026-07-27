import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

import {
  GRANTABLE_MCP_SERVERS,
  reboundAssembledMcpGrants,
  MCP_GRANT_POLICY,
  defaultMcpServersForOrigin,
  grantedMcpServers,
  mcpServersForSession,
  mcpServersForStoredSession,
  normalizeSpawnMcpServers,
  reboundStoredMcpGrants,
  storedSessionOriginFor,
  type StoredGrantFile,
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
  /* The operator's own root keeps what it was granted — but only because the
     row PROVES it is one, which is what makes the resets above the origin rule
     rather than a blanket wipe. */
  expect(mcpServersForStoredSession({ delegationDepth: 0, requested: tampered }, WITH_CONNECTOR))
    .toEqual(["viewer", "test-connector"]);
  expect(mcpServersForStoredSession({ origin: { kind: "operator" }, requested: tampered }, WITH_CONNECTOR))
    .toEqual(["viewer", "test-connector"]);
});

test("a stored grant with missing or erased origin evidence is denied, never promoted to operator root", () => {
  const tampered = ["viewer", "test-connector"];
  /* Absence of a delegation signal is not evidence of an operator root. If it
     were, ERASING the evidence would be the widening path: a delegated worker
     that blanks its own durable origin fields would be read as the most
     privileged session class and keep a connector across every resume, attach
     and structured recovery. */
  expect(storedSessionOriginFor({})).toBe("delegated");
  expect(storedSessionOriginFor({ agentRole: null, parentConversationId: null, delegationDepth: null })).toBe("delegated");
  expect(storedSessionOriginFor({ delegationDepth: 0 })).toBe("operator-root");
  expect(mcpServersForStoredSession({ requested: tampered }, WITH_CONNECTOR)).toEqual(["viewer"]);
  expect(mcpServersForStoredSession({ agentRole: null, parentConversationId: null, delegationDepth: null, requested: tampered }, WITH_CONNECTOR))
    .toEqual(["viewer"]);
  /* A row that only lost its depth — the one affirmative root marker #393
     stamps — is no longer a root either. */
  expect(mcpServersForStoredSession({ agentRole: null, parentConversationId: null, origin: { kind: "successor" }, requested: tampered }, WITH_CONNECTOR))
    .toEqual(["viewer"]);
});

test("a stored conversation whose delegation depth was erased loses its grant on the next read", () => {
  const fileWith = (delegationDepth: number | null) => ({
    conversations: {
      root: {
        id: "conversation_root",
        engine: "codex",
        agentRole: null,
        delegationDepth,
        generations: [{
          id: "root-generation",
          launchProfile: { ...emptyLaunchProfile(), parentConversationId: null, mcpServers: ["viewer", "test-connector"] },
        }],
      },
    },
    entries: {
      "codex:root-generation": { launchProfile: { ...emptyLaunchProfile(), mcpServers: ["viewer", "test-connector"] } },
    },
  } as unknown as StoredGrantFile);

  const proven = reboundStoredMcpGrants(fileWith(0), WITH_CONNECTOR);
  expect(proven.conversations.root!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer", "test-connector"]);
  /* Same row, origin evidence deleted: the grant goes with it on both copies. */
  const erased = reboundStoredMcpGrants(fileWith(null), WITH_CONNECTOR);
  expect(erased.conversations.root!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer"]);
  expect(erased.entries["codex:root-generation"]!.launchProfile!.mcpServers).toEqual(["viewer"]);
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

/* A session id and its transcript, in the shapes production actually uses. The
   registry derives a generation's id from the transcript FILENAME
   (`nativeGenerationId`), and an entry's row key from its session key, so the
   two agree only when the file is named `<session-uuid>.jsonl` — which is what
   both engines write. A fixture named `/sessions/worker.jsonl` instead makes the
   registry synthesize a random generation id that no entry row key can ever
   match, and would test the ownership link against a shape that never exists. */
const sessionIds = new Map<string, string>();
function sessionIdFor(label: string): string {
  const existing = sessionIds.get(label);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionIds.set(label, created);
  return created;
}
function transcriptFor(label: string): string {
  return `/sessions/${sessionIdFor(label)}.jsonl`;
}
function entryRowKey(label: string): string {
  return `codex:${sessionIdFor(label)}`;
}

function settleAs(store: AgentRegistry, launchId: string, label: string) {
  return store.settleSpawn(launchId, {
    key: { engine: "codex", sessionId: sessionIdFor(label) },
    artifactPath: transcriptFor(label),
    cwd: "/repo",
    accountId: "account",
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
}

function settledParent(store: AgentRegistry, mcpServers: string[], label = "nested-parent") {
  const parent = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    launchProfile: { mcpServers },
  });
  if (parent.kind !== "created") throw new Error("expected parent reservation");
  const settled = settleAs(store, parent.receipt.launchId, label);
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
  } as unknown as StoredGrantFile;

  const rebounded = reboundStoredMcpGrants(file, WITH_CONNECTOR);

  expect(rebounded.conversations.root!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer", "test-connector"]);
  expect(rebounded.conversations.worker!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer"]);
  /* The entry row is the copy structured host adoption reads, so it moves too. */
  expect(rebounded.entries["codex:root-generation"]!.launchProfile!.mcpServers).toEqual(["viewer", "test-connector"]);
  expect(rebounded.entries["codex:worker-generation"]!.launchProfile!.mcpServers).toEqual(["viewer"]);
});

/** Every row in the JSON file that carries an MCP grant, set to `grant`. The
    tamper is deliberately indiscriminate — a worker with write access to the
    file edits what it can reach, not what the boundary expects it to. */
function tamperJsonGrant(registryPath: string, grant: string[]): void {
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    conversations: Record<string, { generations: { launchProfile: { mcpServers: string[] } }[] }>;
    entries: Record<string, { launchProfile?: { mcpServers: string[] } }>;
    receipts: Record<string, { launchProfile?: { mcpServers: string[] } }>;
  };
  for (const conversation of Object.values(raw.conversations)) {
    for (const generation of conversation.generations) generation.launchProfile.mcpServers = [...grant];
  }
  for (const row of [...Object.values(raw.entries), ...Object.values(raw.receipts)]) {
    if (row.launchProfile) row.launchProfile.mcpServers = [...grant];
  }
  fs.writeFileSync(registryPath, JSON.stringify(raw));
}

test("a delegated conversation cannot keep a hand-edited grant across resume or reload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-tamper-"));
  const registryPath = path.join(directory, "registry.json");
  /* The tampered name must be one the bound genuinely GRANTS, and the policy
     must be injected on both the seeding and the reloading store. With an
     out-of-bound name the global bound alone strips it, and this case would
     keep passing with the origin decision deleted — proving nothing. */
  const storage = { sqliteMode: "off" as const, mcpGrantPolicy: WITH_CONNECTOR };
  try {
    /* This case tampers with the JSON file itself, so it pins the backend
       rather than inheriting the environment's: under a SQLite-authoritative
       mode that file is a lagging rollback mirror, not the source of truth. */
    const store = new AgentRegistry(registryPath, undefined, undefined, storage);
    const parentId = settledParent(store, ["viewer"]);
    const workerId = settledDelegatedChild(store, parentId, "delegated-worker");

    /* The worker edits the durable file it can reach on disk, naming a server
       that IS inside the grant bound — the global bound alone would honour it. */
    tamperJsonGrant(registryPath, ["viewer", "test-connector"]);

    const reloaded = new AgentRegistry(registryPath, undefined, undefined, storage);
    expect(reloaded.launchProfileForPath(transcriptFor("delegated-worker"))?.mcpServers).toEqual(["viewer"]);
    const snapshot = reloaded.snapshot();
    expect(snapshot.entries[entryRowKey("delegated-worker")]?.launchProfile?.mcpServers).toEqual(["viewer"]);
    expect(snapshot.conversations[workerId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer"]);
    /* The operator root's own rows keep the tampered grant, because its stored
       origin proves it may hold one. Without this control the assertions above
       would also pass if the read simply wiped every grant it saw. */
    expect(reloaded.launchProfileForPath(transcriptFor("nested-parent"))?.mcpServers).toEqual(["viewer", "test-connector"]);
    expect(snapshot.entries[entryRowKey("nested-parent")]?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
    expect(snapshot.conversations[parentId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer", "test-connector"]);

    const resumedWorker = reloaded.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      conversationId: workerId as never,
      purpose: "resume-successor",
    });
    expect(resumedWorker.receipt.launchProfile.mcpServers).toEqual(["viewer"]);
    const resumedRoot = reloaded.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      conversationId: parentId as never,
      purpose: "resume-successor",
    });
    expect(resumedRoot.receipt.launchProfile.mcpServers).toEqual(["viewer", "test-connector"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a tampered receipt cannot carry a grant into settlement or attach", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipt-tamper-"));
  const registryPath = path.join(directory, "registry.json");
  const storage = { sqliteMode: "off" as const, mcpGrantPolicy: WITH_CONNECTOR };
  try {
    const store = new AgentRegistry(registryPath, undefined, undefined, storage);
    const parentId = settledParent(store, ["viewer"]);
    /* Two receipts admitted and left UNSETTLED, so the widening path is the
       live one: settlement copies `receipt.launchProfile` onto the conversation
       generation and the entry row, and attach reads it back from there. */
    const worker = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      role: "builder",
      parentConversationId: parentId,
      origin: { kind: "agent", conversationId: parentId },
    });
    const root = store.beginSpawnRequest({ engine: "codex", cwd: "/repo" });

    tamperJsonGrant(registryPath, ["viewer", "test-connector"]);

    const reloaded = new AgentRegistry(registryPath, undefined, undefined, storage);
    const settle = (launchId: string, label: string) => {
      const settled = settleAs(reloaded, launchId, label);
      if (settled.kind !== "settled") throw new Error(`expected ${label} settlement`);
      return settled.conversation.id;
    };

    const workerId = settle(worker.receipt.launchId, "receipt-worker");
    const rootId = settle(root.receipt.launchId, "receipt-root");
    const snapshot = reloaded.snapshot();

    /* The delegated receipt's claim dies at the storage boundary, so neither
       copy settlement writes ever holds the connector. */
    expect(snapshot.receipts[worker.receipt.launchId]!.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(snapshot.conversations[workerId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(snapshot.entries[entryRowKey("receipt-worker")]?.launchProfile?.mcpServers).toEqual(["viewer"]);
    /* The operator root's receipt keeps it through the same reload and the same
       settlement, so the reset above is the origin rule, not a blanket wipe. */
    expect(snapshot.receipts[root.receipt.launchId]!.launchProfile.mcpServers).toEqual(["viewer", "test-connector"]);
    expect(snapshot.conversations[rootId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer", "test-connector"]);
    expect(snapshot.entries[entryRowKey("receipt-root")]?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function settledDelegatedChild(store: AgentRegistry, parentId: string, label: string) {
  const child = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role: "builder",
    parentConversationId: parentId as never,
    origin: { kind: "agent", conversationId: parentId as never },
  });
  if (child.kind !== "created") throw new Error("expected child reservation");
  const settled = settleAs(store, child.receipt.launchId, label);
  if (settled.kind !== "settled") throw new Error("expected child settlement");
  return settled.conversation.id;
}

function structuredRow(store: AgentRegistry, label: string) {
  /* A structured host row is what boot adoption filters for and what a claim
     hands to `optionsFor`, so the claim path is exercised rather than skipped. */
  store.upsert({
    key: { engine: "codex", sessionId: sessionIdFor(label) },
    artifactPath: transcriptFor(label),
    cwd: "/repo",
    accountId: "account",
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:old",
      process: null,
      eventCursor: 4,
      protocolVersion: "0.145.0",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
}

function tamperSqliteGrant(sqlitePath: string, rows: { collection: "entries" | "conversations"; key: string }[], grant: string[]): void {
  const db = new Database(sqlitePath, { strict: true });
  try {
    for (const { collection, key } of rows) {
      const row = db.query<{ value_json: string }, [string, string]>(
        "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
      ).get(collection, key);
      if (!row) throw new Error(`expected a stored ${collection} row for ${key}`);
      const parsed = JSON.parse(row.value_json) as {
        launchProfile?: Record<string, unknown>;
        generations?: { launchProfile: Record<string, unknown> }[];
      };
      parsed.launchProfile = { ...(parsed.launchProfile ?? {}), mcpServers: [...grant] };
      for (const generation of parsed.generations ?? []) generation.launchProfile.mcpServers = [...grant];
      db.query<unknown, [string, string, string]>(
        "UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?",
      ).run(JSON.stringify(parsed), collection, key);
    }
  } finally {
    db.close();
  }
}

/** Rewrite ONE entry row's embedded identity, leaving its row KEY — the
    storage-level identity a row does not get to choose — alone. This is the
    escalation the origin rule alone does not see: the row keeps its own origin
    and simply claims to be somebody else's session. */
type IdentityForgery = { key?: { engine: string; sessionId: string }; artifactPath?: string };

function forgeJsonEntryIdentity(registryPath: string, rowKey: string, forgery: IdentityForgery): void {
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    entries: Record<string, IdentityForgery>;
  };
  const entry = raw.entries[rowKey];
  if (!entry) throw new Error(`expected a stored entry row for ${rowKey}`);
  Object.assign(entry, forgery);
  fs.writeFileSync(registryPath, JSON.stringify(raw));
}

function forgeSqliteEntryIdentity(sqlitePath: string, rowKey: string, forgery: IdentityForgery): void {
  const db = new Database(sqlitePath, { strict: true });
  try {
    const row = db.query<{ value_json: string }, [string, string]>(
      "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
    ).get("entries", rowKey);
    if (!row) throw new Error(`expected a stored entries row for ${rowKey}`);
    db.query<unknown, [string, string, string]>(
      "UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?",
    ).run(JSON.stringify({ ...JSON.parse(row.value_json) as object, ...forgery }), "entries", rowKey);
  } finally {
    db.close();
  }
}

/* Each forgery is exercised ALONE. Applying both at once would let either
   check alone carry the case, and the other could be deleted unnoticed. */
const IDENTITY_FORGERIES = [
  {
    what: "embedded session key",
    forge: (): IdentityForgery => ({ key: { engine: "codex", sessionId: sessionIdFor("nested-parent") } }),
  },
  {
    what: "transcript path",
    forge: (): IdentityForgery => ({ artifactPath: transcriptFor("nested-parent") }),
  },
] as const;

for (const { what, forge } of IDENTITY_FORGERIES) {
  test(`a delegated entry cannot borrow the operator root's grant by forging its ${what} (JSON)`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-json-identity-"));
    const registryPath = path.join(directory, "registry.json");
    const storage = { sqliteMode: "off" as const, mcpGrantPolicy: WITH_CONNECTOR };
    const workerRow = entryRowKey("json-identity-worker");
    try {
      const store = new AgentRegistry(registryPath, undefined, undefined, storage);
      const rootId = settledParent(store, ["viewer"]);
      settledDelegatedChild(store, rootId, "json-identity-worker");
      /* The root legitimately holds the connector, so there is something worth
         borrowing; the worker's own rows are reset by the origin rule. */
      tamperJsonGrant(registryPath, ["viewer", "test-connector"]);
      forgeJsonEntryIdentity(registryPath, workerRow, forge());

      const reloaded = new AgentRegistry(registryPath, undefined, undefined, storage);
      expect(reloaded.snapshot().entries[workerRow]?.launchProfile?.mcpServers).toEqual(["viewer"]);
      expect(reloaded.readOnlySnapshot().entries[workerRow]?.launchProfile?.mcpServers).toEqual(["viewer"]);
      /* The root's own row is untouched by the forgery and keeps its grant, so
         the denial is the identity rule rather than a blanket wipe. */
      expect(reloaded.snapshot().entries[entryRowKey("nested-parent")]?.launchProfile?.mcpServers)
        .toEqual(["viewer", "test-connector"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`a delegated entry cannot borrow the operator root's grant by forging its ${what} (SQLite, claim, adoption, recovery)`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-sqlite-identity-"));
    const registryPath = path.join(directory, "agent-registry.json");
    const sqlitePath = path.join(directory, "agent-registry.sqlite");
    const storage = { sqliteMode: "sqlite" as const, mcpGrantPolicy: WITH_CONNECTOR };
    const workerRow = entryRowKey("sqlite-identity-worker");
    const rootRow = entryRowKey("nested-parent");
    try {
      const store = new AgentRegistry(registryPath, undefined, undefined, storage);
      const rootId = settledParent(store, ["viewer"]);
      const workerId = settledDelegatedChild(store, rootId, "sqlite-identity-worker");
      structuredRow(store, "sqlite-identity-worker");
      structuredRow(store, "nested-parent");

      tamperSqliteGrant(sqlitePath, [
        { collection: "entries", key: workerRow },
        { collection: "conversations", key: workerId },
        { collection: "entries", key: rootRow },
        { collection: "conversations", key: rootId },
      ], ["viewer", "test-connector"]);
      forgeSqliteEntryIdentity(sqlitePath, workerRow, forge());

      const reopened = new AgentRegistry(registryPath, undefined, undefined, storage);
      /* readOnlySnapshot is what boot ADOPTION filters rows from; snapshot is
         what structured RECOVERY reads a profile and cursor through. */
      expect(reopened.readOnlySnapshot().entries[workerRow]?.launchProfile?.mcpServers).toEqual(["viewer"]);
      expect(reopened.snapshot().entries[workerRow]?.launchProfile?.mcpServers).toEqual(["viewer"]);
      /* And the CLAIM mutation, which hands a host one row and never sees an
         assembled snapshot at all. */
      const owner = { pid: process.pid, startIdentity: null };
      const claimed = reopened.claimStructuredHost(
        { engine: "codex", sessionId: sessionIdFor("sqlite-identity-worker") },
        owner,
        { allowUnhosted: true },
      );
      expect(claimed).not.toBeNull();
      expect(claimed?.launchProfile?.mcpServers).toEqual(["viewer"]);
      /* The operator root keeps its grant on every one of those paths. */
      expect(reopened.readOnlySnapshot().entries[rootRow]?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
      expect(reopened.claimStructuredHost({ engine: "codex", sessionId: sessionIdFor("nested-parent") }, owner, { allowUnhosted: true })
        ?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("identity evidence that cannot name one owner denies rather than picking a winner", () => {
  const profileFor = (mcpServers: string[], parentConversationId: string | null) => ({
    ...emptyLaunchProfile(),
    parentConversationId: parentConversationId as never,
    mcpServers,
  });
  const grant = ["viewer", "test-connector"];
  /* Two conversations of DIFFERENT origin whose generations claim one entry row
     — the delegated one by having copied the root generation's id. Nothing left
     in the file says which decision the row should follow. */
  const contested = () => ({
    conversations: {
      root: {
        id: "conversation_root",
        engine: "codex",
        agentRole: null,
        delegationDepth: 0,
        generations: [{ id: "contested", path: "/sessions/root.jsonl", launchProfile: profileFor(grant, null) }],
      },
      worker: {
        id: "conversation_worker",
        engine: "codex",
        agentRole: "builder",
        delegationDepth: 1,
        generations: [{ id: "contested", path: "/sessions/worker.jsonl", launchProfile: profileFor(grant, "conversation_root") }],
      },
    },
    entries: { "codex:contested": { launchProfile: profileFor(grant, null) } },
  } as unknown as StoredGrantFile);

  expect(reboundStoredMcpGrants(contested(), WITH_CONNECTOR).entries["codex:contested"]!.launchProfile!.mcpServers)
    .toEqual(["viewer"]);
  expect(reboundAssembledMcpGrants(contested(), WITH_CONNECTOR).entries["codex:contested"]!.launchProfile!.mcpServers)
    .toEqual(["viewer"]);

  /* And the same for a transcript two generations both record: the path names
     no single owner, so an entry pointing at it is attributable to neither. */
  const sharedPath = () => ({
    conversations: {
      root: {
        id: "conversation_root",
        engine: "codex",
        agentRole: null,
        delegationDepth: 0,
        generations: [{ id: "root-generation", path: "/sessions/shared.jsonl", launchProfile: profileFor(grant, null) }],
      },
      worker: {
        id: "conversation_worker",
        engine: "codex",
        agentRole: "builder",
        delegationDepth: 1,
        generations: [{ id: "worker-generation", path: "/sessions/shared.jsonl", launchProfile: profileFor(grant, "conversation_root") }],
      },
    },
    entries: {
      "codex:root-generation": { artifactPath: "/sessions/shared.jsonl", launchProfile: profileFor(grant, null) },
    },
  } as unknown as StoredGrantFile);

  expect(reboundAssembledMcpGrants(sharedPath(), WITH_CONNECTOR).entries["codex:root-generation"]!.launchProfile!.mcpServers)
    .toEqual(["viewer"]);
});

test("a forged embedded key is denied even where no conversation is loaded", () => {
  /* A row key/payload mismatch needs nothing but the row, so the per-collection
     pass — which deliberately leaves merely-unowned rows alone — still denies
     it. Otherwise a SQLite entries-only normalize would be the way in. */
  const forged = {
    conversations: {},
    entries: {
      "codex:worker": {
        key: { engine: "codex", sessionId: "root" },
        launchProfile: { mcpServers: ["viewer", "test-connector"] },
      },
    },
  } as unknown as StoredGrantFile;
  expect(reboundStoredMcpGrants(forged, WITH_CONNECTOR).entries["codex:worker"]!.launchProfile!.mcpServers)
    .toEqual(["viewer"]);
});

test("a SQLite-authoritative registry re-bounds a tampered entry row on the paths adoption reads", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-sqlite-tamper-"));
  const registryPath = path.join(directory, "agent-registry.json");
  const sqlitePath = path.join(directory, "agent-registry.sqlite");
  const storage = { sqliteMode: "sqlite" as const, mcpGrantPolicy: WITH_CONNECTOR };
  const workerEntryId = entryRowKey("sqlite-delegated-worker");
  const rootEntryId = entryRowKey("nested-parent");
  try {
    const store = new AgentRegistry(registryPath, undefined, undefined, storage);
    const parentId = settledParent(store, ["viewer"]);
    const workerId = settledDelegatedChild(store, parentId, "sqlite-delegated-worker");
    structuredRow(store, "sqlite-delegated-worker");
    structuredRow(store, "nested-parent");

    /* Rows are written and normalized one collection — one row — at a time, so
       an entry row is the copy that carries no origin evidence of its own.
       Tamper where SQLite is authoritative; the JSON file is only a mirror. */
    tamperSqliteGrant(sqlitePath, [
      { collection: "entries", key: workerEntryId },
      { collection: "conversations", key: workerId },
      { collection: "entries", key: rootEntryId },
      { collection: "conversations", key: parentId },
    ], ["viewer", "test-connector"]);

    const reopened = new AgentRegistry(registryPath, undefined, undefined, storage);
    /* readOnlySnapshot is what boot adoption filters rows from, and snapshot is
       what structured recovery reads a profile and cursor through. */
    expect(reopened.readOnlySnapshot().entries[workerEntryId]?.launchProfile?.mcpServers).toEqual(["viewer"]);
    expect(reopened.snapshot().entries[workerEntryId]?.launchProfile?.mcpServers).toEqual(["viewer"]);
    /* The operator root's own row keeps what it was granted, so the reset above
       is the origin rule and not a blanket wipe. */
    expect(reopened.snapshot().entries[rootEntryId]?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);

    /* And the entry a claim mutation hands to a host, which never sees an
       assembled snapshot at all. */
    const owner = { pid: process.pid, startIdentity: null };
    const claimedWorker = reopened.claimStructuredHost({ engine: "codex", sessionId: sessionIdFor("sqlite-delegated-worker") }, owner, { allowUnhosted: true });
    expect(claimedWorker).not.toBeNull();
    expect(claimedWorker?.launchProfile?.mcpServers).toEqual(["viewer"]);
    const claimedRoot = reopened.claimStructuredHost({ engine: "codex", sessionId: sessionIdFor("nested-parent") }, owner, { allowUnhosted: true });
    expect(claimedRoot?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an assembled SQLite snapshot re-decides entry rows by their owning conversation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-sqlite-origin-"));
  const registryPath = path.join(directory, "agent-registry.json");
  try {
    const store = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "sqlite" });
    const rootId = settledParent(store, ["viewer"]);
    const workerId = settledDelegatedChild(store, rootId, "sqlite-origin-worker");
    const snapshot = store.snapshot();

    /* Both rows claim a connector this tranche cannot grant at all, so the
       decision is replayed against a policy that CAN — otherwise the reset
       proves the bound rather than the origin rule. */
    const grant = ["viewer", "test-connector"];
    for (const conversationId of [rootId, workerId]) {
      for (const generation of snapshot.conversations[conversationId]!.generations) {
        generation.launchProfile.mcpServers = [...grant];
      }
    }
    for (const entry of Object.values(snapshot.entries)) {
      if (entry.launchProfile) entry.launchProfile.mcpServers = [...grant];
    }

    reboundStoredMcpGrants(snapshot as unknown as StoredGrantFile, WITH_CONNECTOR);

    expect(snapshot.conversations[rootId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(grant);
    expect(snapshot.entries[entryRowKey("nested-parent")]?.launchProfile?.mcpServers).toEqual(grant);
    /* The delegated worker loses it on both copies, matched by real session key. */
    expect(snapshot.conversations[workerId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(snapshot.entries[entryRowKey("sqlite-origin-worker")]?.launchProfile?.mcpServers).toEqual(["viewer"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the SQLite store re-decides entry rows by origin when it assembles a snapshot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-sqlite-assembled-"));
  try {
    /* Seeded through the real registry so ids, session keys and artifact paths
       are the production ones, then re-read through a store whose normalizer
       runs under a policy that HAS a grantable connector — the shipped bound
       has none, and an empty bound cannot tell an origin reset from itself. */
    const seed = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const rootId = settledParent(seed, ["viewer"]);
    const workerId = settledDelegatedChild(seed, rootId, "assembled-worker");
    const initial = seed.snapshot();
    const grant = ["viewer", "test-connector"];
    for (const conversationId of [rootId, workerId]) {
      for (const generation of initial.conversations[conversationId]!.generations) {
        generation.launchProfile.mcpServers = [...grant];
      }
    }
    for (const entry of Object.values(initial.entries)) {
      if (entry.launchProfile) entry.launchProfile.mcpServers = [...grant];
    }

    const store = new SqliteAgentRegistryStore(path.join(directory, "agent-registry.sqlite"), {
      initialSnapshot: initial,
      normalize: (value) => normalizeRegistry(value, WITH_CONNECTOR),
      mcpGrantPolicy: WITH_CONNECTOR,
    });
    {
      const file = store.snapshot().file;
      /* The operator root keeps the grant on both copies of its profile. */
      expect(file.conversations[rootId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(grant);
      expect(file.entries[entryRowKey("nested-parent")]!.launchProfile!.mcpServers).toEqual(grant);
      /* The delegated worker loses it on both — including the ENTRY row, which
         is normalized with no conversation in sight and is what boot adoption
         and structured recovery consume. */
      expect(file.conversations[workerId]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer"]);
      expect(file.entries[entryRowKey("assembled-worker")]!.launchProfile!.mcpServers).toEqual(["viewer"]);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an entry no conversation owns keeps its grant per row and loses it in an assembled read", () => {
  const orphan = () => ({
    conversations: {},
    entries: {
      "codex:orphan": {
        key: { engine: "codex", sessionId: "orphan" },
        artifactPath: "/sessions/orphan.jsonl",
        launchProfile: { mcpServers: ["viewer", "test-connector"] },
      },
    },
  } as unknown as StoredGrantFile);

  /* Per-row normalization sees no conversations at all, so "unowned" there is a
     statement about how much was loaded — narrowing then would wipe a
     legitimate root grant on every lone entries row. */
  const perRow = reboundStoredMcpGrants(orphan(), WITH_CONNECTOR);
  expect(perRow.entries["codex:orphan"]!.launchProfile!.mcpServers).toEqual(["viewer", "test-connector"]);
  /* In a complete snapshot the same entry is genuinely unowned: no origin
     evidence exists for it, so it falls back to the baseline. */
  const assembled = reboundAssembledMcpGrants(orphan(), WITH_CONNECTOR);
  expect(assembled.entries["codex:orphan"]!.launchProfile!.mcpServers).toEqual(["viewer"]);
});
