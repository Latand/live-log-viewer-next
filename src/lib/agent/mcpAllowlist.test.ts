import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";
import { AgentRegistry, normalizeRegistry, type RegistryFile } from "./registry";
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

/* One field is forged at a time. Forging both at once would look stronger and
   test less — the path rule catches a row-key forgery on its own, so the case
   would keep passing with the row-key rule deleted.

   These two pin the attack end to end on every backend and reader. Which
   individual RULE carries each denial is pinned separately below, on the pure
   functions, where a fixture can isolate one rule at a time. */
const IDENTITY_FORGERIES = [
  {
    what: "embedded session key",
    /* The transcript moves to a path no generation records, so the path rule
       has nothing to say about this row and the row-key rule stands alone. */
    forge: (): IdentityForgery => ({
      key: { engine: "codex", sessionId: sessionIdFor("nested-parent") },
      artifactPath: transcriptFor("unrecorded-transcript"),
    }),
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

test("an unowned entry pointing at another row's transcript is denied even in a partial read", () => {
  /* The per-collection pass deliberately leaves a merely-UNOWNED row alone, so
     that normalizing a lone entries row cannot wipe a legitimate root grant.
     A row that erased its own generation and points at the operator root's
     transcript would ride in on exactly that, in exactly the view a SQLite
     entries-only normalize produces. Borrowed identity is not mere absence. */
  const grant = ["viewer", "test-connector"];
  const borrowed = () => ({
    conversations: {
      root: {
        id: "conversation_root",
        engine: "codex",
        agentRole: null,
        delegationDepth: 0,
        generations: [{
          id: "root-generation",
          path: "/sessions/root.jsonl",
          launchProfile: { ...emptyLaunchProfile(), parentConversationId: null, mcpServers: [...grant] },
        }],
      },
    },
    entries: {
      "codex:orphan-worker": { artifactPath: "/sessions/root.jsonl", launchProfile: { mcpServers: [...grant] } },
    },
  } as unknown as StoredGrantFile);

  expect(reboundStoredMcpGrants(borrowed(), WITH_CONNECTOR).entries["codex:orphan-worker"]!.launchProfile!.mcpServers)
    .toEqual(["viewer"]);
  expect(reboundAssembledMcpGrants(borrowed(), WITH_CONNECTOR).entries["codex:orphan-worker"]!.launchProfile!.mcpServers)
    .toEqual(["viewer"]);
  /* The generation's own row keeps the grant, so this is the borrowing that is
     denied and not the transcript. */
  expect(reboundStoredMcpGrants(borrowed(), WITH_CONNECTOR).conversations.root!.generations[0]!.launchProfile.mcpServers)
    .toEqual(grant);
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

/** The origin fields a receipt carries, rewritten into the shape admission
    stamps on an operator root. The receipt's LINEAGE — the edge row admission
    wrote for it, and the conversation row once it settles — is left intact and
    still says delegated. */
const ROOT_SHAPE = { agentRole: null, delegationDepth: 0, parentConversationId: null } as const;
type ReceiptForgery = { agentRole?: string | null; delegationDepth?: number | null; parentConversationId?: string | null };

function forgeJsonReceiptOrigin(registryPath: string, launchId: string, forgery: ReceiptForgery, grant: string[]): void {
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    receipts: Record<string, ReceiptForgery & { launchProfile?: { mcpServers: string[] } }>;
  };
  const receipt = raw.receipts[launchId];
  if (!receipt) throw new Error(`expected a stored receipt for ${launchId}`);
  Object.assign(receipt, forgery);
  /* The launch profile carries its own copy of the parent, and settlement puts
     that copy on the generation, so a forgery that stopped at the receipt's
     top-level fields would leave the delegation visible on the row it writes. */
  receipt.launchProfile = { ...(receipt.launchProfile ?? {}), parentConversationId: null, mcpServers: [...grant] } as { mcpServers: string[] };
  fs.writeFileSync(registryPath, JSON.stringify(raw));
}

function forgeSqliteReceiptOrigin(sqlitePath: string, launchId: string, forgery: ReceiptForgery, grant: string[]): void {
  const db = new Database(sqlitePath, { strict: true });
  try {
    const row = db.query<{ value_json: string }, [string, string]>(
      "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
    ).get("receipts", launchId);
    if (!row) throw new Error(`expected a stored receipts row for ${launchId}`);
    const parsed = JSON.parse(row.value_json) as { launchProfile?: Record<string, unknown> };
    Object.assign(parsed, forgery);
    parsed.launchProfile = { ...(parsed.launchProfile ?? {}), parentConversationId: null, mcpServers: [...grant] };
    db.query<unknown, [string, string, string]>(
      "UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?",
    ).run(JSON.stringify(parsed), "receipts", launchId);
  } finally {
    db.close();
  }
}

/** A delegated launch admitted but NOT settled: its lineage edge row exists,
    its conversation row does not yet. This is the state where the receipt's own
    fields are the only thing describing it — and precisely where trusting them
    would let the row authorise itself. */
function admittedDelegatedChild(store: AgentRegistry, parentId: string) {
  const child = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role: "builder",
    parentConversationId: parentId as never,
    origin: { kind: "agent", conversationId: parentId as never },
  });
  if (child.kind !== "created") throw new Error("expected child reservation");
  return child.receipt;
}

test("a receipt forged into root shape is denied by the lineage it cannot rewrite, and nothing propagates through settlement (JSON)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipt-origin-"));
  const registryPath = path.join(directory, "registry.json");
  const storage = { sqliteMode: "off" as const, mcpGrantPolicy: WITH_CONNECTOR };
  try {
    const store = new AgentRegistry(registryPath, undefined, undefined, storage);
    const rootId = settledParent(store, ["viewer"]);
    const worker = admittedDelegatedChild(store, rootId);
    const honestRoot = store.beginSpawnRequest({ engine: "codex", cwd: "/repo" });

    /* The worker rewrites its receipt's role, depth and parent into root shape
       and helps itself to a connector. Its lineage edge is untouched. */
    forgeJsonReceiptOrigin(registryPath, worker.launchId, ROOT_SHAPE, ["viewer", "test-connector"]);
    /* The operator's own un-parented launch claims the same thing truthfully. */
    forgeJsonReceiptOrigin(registryPath, honestRoot.receipt.launchId, ROOT_SHAPE, ["viewer", "test-connector"]);

    const reloaded = new AgentRegistry(registryPath, undefined, undefined, storage);
    expect(reloaded.snapshot().receipts[worker.launchId]!.launchProfile.mcpServers).toEqual(["viewer"]);
    /* The honest root has no lineage edge to contradict it and keeps its grant,
       so the denial is the contradiction and not a blanket receipt wipe. */
    expect(reloaded.snapshot().receipts[honestRoot.receipt.launchId]!.launchProfile.mcpServers)
      .toEqual(["viewer", "test-connector"]);

    /* Settlement is the propagation path: it copies the receipt profile onto the
       conversation generation and the entry row, and stamps the receipt's own
       role and depth onto the conversation it creates. */
    const settledWorker = settleAs(reloaded, worker.launchId, "forged-worker");
    if (settledWorker.kind !== "settled") throw new Error("expected worker settlement");
    const settledRoot = settleAs(reloaded, honestRoot.receipt.launchId, "honest-root");
    if (settledRoot.kind !== "settled") throw new Error("expected root settlement");
    const after = reloaded.snapshot();

    expect(after.conversations[settledWorker.conversation.id]!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(after.entries[entryRowKey("forged-worker")]?.launchProfile?.mcpServers).toEqual(["viewer"]);
    expect(after.conversations[settledRoot.conversation.id]!.generations.at(-1)!.launchProfile.mcpServers)
      .toEqual(["viewer", "test-connector"]);
    expect(after.entries[entryRowKey("honest-root")]?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a receipt forged into root shape is denied on every SQLite reader, and on claim after it settles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipt-origin-sqlite-"));
  const registryPath = path.join(directory, "agent-registry.json");
  const sqlitePath = path.join(directory, "agent-registry.sqlite");
  const storage = { sqliteMode: "sqlite" as const, mcpGrantPolicy: WITH_CONNECTOR };
  try {
    const store = new AgentRegistry(registryPath, undefined, undefined, storage);
    const rootId = settledParent(store, ["viewer"]);
    const worker = admittedDelegatedChild(store, rootId);

    forgeSqliteReceiptOrigin(sqlitePath, worker.launchId, ROOT_SHAPE, ["viewer", "test-connector"]);

    const reopened = new AgentRegistry(registryPath, undefined, undefined, storage);
    /* readOnlySnapshot is what boot ADOPTION filters from; snapshot is what
       structured RECOVERY reads through. */
    expect(reopened.readOnlySnapshot().receipts[worker.launchId]!.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(reopened.snapshot().receipts[worker.launchId]!.launchProfile.mcpServers).toEqual(["viewer"]);

    /* Settle it anyway. Settlement stamps the receipt's OWN role and depth onto
       the conversation it creates, so the row now on disk reads `agentRole:
       null, delegationDepth: 0` — an operator root by its own account. The
       conversation's origin alone can no longer tell; only the lineage edge
       admission wrote, which settlement never touches, still says otherwise. */
    const settled = settleAs(reopened, worker.launchId, "sqlite-forged-worker");
    if (settled.kind !== "settled") throw new Error("expected worker settlement");
    structuredRow(reopened, "sqlite-forged-worker");
    structuredRow(reopened, "nested-parent");
    const workerRow = entryRowKey("sqlite-forged-worker");
    const rootRow = entryRowKey("nested-parent");
    expect(reopened.snapshot().conversations[settled.conversation.id]!.delegationDepth).toBe(0);

    /* And it helps itself to the connector on every row it now owns. */
    tamperSqliteGrant(sqlitePath, [
      { collection: "entries", key: workerRow },
      { collection: "conversations", key: settled.conversation.id },
      { collection: "entries", key: rootRow },
      { collection: "conversations", key: rootId },
    ], ["viewer", "test-connector"]);

    const settledView = new AgentRegistry(registryPath, undefined, undefined, storage);
    expect(settledView.readOnlySnapshot().entries[workerRow]?.launchProfile?.mcpServers).toEqual(["viewer"]);
    expect(settledView.snapshot().conversations[settled.conversation.id]!.generations.at(-1)!.launchProfile.mcpServers)
      .toEqual(["viewer"]);
    /* And the CLAIM mutation, which hands a host one row of its own. */
    const claimed = settledView.claimStructuredHost(
      { engine: "codex", sessionId: sessionIdFor("sqlite-forged-worker") },
      { pid: process.pid, startIdentity: null },
      { allowUnhosted: true },
    );
    expect(claimed).not.toBeNull();
    expect(claimed?.launchProfile?.mcpServers).toEqual(["viewer"]);
    /* The operator root has no lineage edge contradicting it and keeps the
       grant on all three, so none of the above is a blanket wipe. */
    expect(settledView.readOnlySnapshot().entries[rootRow]?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
    expect(settledView.snapshot().conversations[rootId]!.generations.at(-1)!.launchProfile.mcpServers)
      .toEqual(["viewer", "test-connector"]);
    expect(settledView.claimStructuredHost({ engine: "codex", sessionId: sessionIdFor("nested-parent") }, { pid: process.pid, startIdentity: null }, { allowUnhosted: true })
      ?.launchProfile?.mcpServers).toEqual(["viewer", "test-connector"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a receipt whose self-description disagrees with the rows attesting to it is denied in either direction", () => {
  const grant = ["viewer", "test-connector"];
  const fileWith = (
    receipt: ReceiptForgery & { conversationId: string },
    rows: { conversation?: { delegationDepth: number | null; agentRole: string | null }; edgeParent?: string },
  ) => ({
    conversations: rows.conversation
      ? { [receipt.conversationId]: { engine: "codex", ...rows.conversation, generations: [] } }
      : {},
    lineageEdges: rows.edgeParent ? { [receipt.conversationId]: { parentConversationId: rows.edgeParent } } : {},
    entries: {},
    receipts: { launch: { ...receipt, launchProfile: { mcpServers: [...grant] } } },
  } as unknown as StoredGrantFile);
  const grantOf = (file: StoredGrantFile) =>
    reboundAssembledMcpGrants(file, WITH_CONNECTOR).receipts!.launch!.launchProfile!.mcpServers;

  /* Claims root; its lineage edge records a parent. The forgery direction. */
  expect(grantOf(fileWith(
    { conversationId: "conversation_worker", ...ROOT_SHAPE },
    { edgeParent: "conversation_root" },
  ))).toEqual(["viewer"]);

  /* Claims delegated; the conversation attesting to it is an operator root.
     Denied too — resolving a contradiction by believing whichever row is more
     generous is how a tamper signal turns into an authorisation. */
  expect(grantOf(fileWith(
    { conversationId: "conversation_root", agentRole: "builder", delegationDepth: 1, parentConversationId: null },
    { conversation: { agentRole: null, delegationDepth: 0 } },
  ))).toEqual(["viewer"]);

  /* Agreeing rows keep the grant, so neither denial above is a blanket wipe. */
  expect(grantOf(fileWith(
    { conversationId: "conversation_root", ...ROOT_SHAPE },
    { conversation: { agentRole: null, delegationDepth: 0 } },
  ))).toEqual(grant);
  /* And an un-parented launch that has not settled has nothing attesting to it
     yet, which is not a contradiction — it still only narrows. */
  expect(grantOf(fileWith({ conversationId: "conversation_fresh", ...ROOT_SHAPE }, {}))).toEqual(grant);
  expect(grantOf(fileWith(
    { conversationId: "conversation_fresh", agentRole: "builder", delegationDepth: 1, parentConversationId: null },
    {},
  ))).toEqual(["viewer"]);
});

test("a receipt cannot shed the lineage attesting to it by retargeting the conversation it names", () => {
  const grant = ["viewer", "test-connector"];
  /* The worker rewrites itself into root shape AND points `conversationId` at
     the operator root, so every attestor reachable through a pointer it owns
     now agrees with it. The edge admission wrote is indexed by the launch id in
     the EDGE's own evidence, so it still names this receipt whatever the
     receipt says about itself. */
  const retargeted = (conversationId: string | null, launchId = "launch") => ({
    conversations: {
      conversation_root: { engine: "codex", agentRole: null, delegationDepth: 0, generations: [] },
    },
    lineageEdges: {
      conversation_worker: { parentConversationId: "conversation_root", evidence: { launchId } },
    },
    entries: {},
    receipts: { launch: { conversationId, ...ROOT_SHAPE, launchProfile: { mcpServers: [...grant] } } },
  } as unknown as StoredGrantFile);
  const grantOf = (file: StoredGrantFile) =>
    reboundAssembledMcpGrants(file, WITH_CONNECTOR).receipts!.launch!.launchProfile!.mcpServers;

  /* Named at the operator root, whose own row attests root truthfully. */
  expect(grantOf(retargeted("conversation_root"))).toEqual(["viewer"]);
  /* And blanked, so no pointer-reachable row attests to it at all. */
  expect(grantOf(retargeted(null))).toEqual(["viewer"]);
  /* An edge naming a DIFFERENT launch leaves this receipt genuinely unattested
     and it keeps the grant, so the denials above are this receipt's own lineage
     rather than any edge anywhere existing. */
  expect(grantOf(retargeted("conversation_root", "other-launch"))).toEqual(grant);
});

test("a receipt claiming root is denied by a delegated attestor no lineage edge names", () => {
  const grant = ["viewer", "test-connector"];
  /* No lineage edge exists here at all, so the only rows that can contradict the
     receipt are the two it points at itself: the conversation it names, and the
     conversation owning the entry row its key settled onto. Both still deny,
     which is the point of collecting them — following a pointer the subject
     controls can only ever ADD a contradiction, never supply the origin. */
  const delegatedOwner = (receipt: Record<string, unknown>) => ({
    conversations: {
      conversation_worker: {
        engine: "codex",
        agentRole: "builder",
        delegationDepth: 1,
        generations: [{
          id: "worker-generation",
          path: "/sessions/worker.jsonl",
          launchProfile: { parentConversationId: null, mcpServers: ["viewer"] },
        }],
      },
    },
    lineageEdges: {},
    entries: {},
    receipts: { launch: { ...ROOT_SHAPE, ...receipt, launchProfile: { mcpServers: [...grant] } } },
  } as unknown as StoredGrantFile);
  const grantOf = (file: StoredGrantFile) =>
    reboundAssembledMcpGrants(file, WITH_CONNECTOR).receipts!.launch!.launchProfile!.mcpServers;

  /* The conversation it names is delegated by its own role and depth. */
  expect(grantOf(delegatedOwner({ conversationId: "conversation_worker" }))).toEqual(["viewer"]);
  /* It names no conversation, but its key settled onto the row that one owns. */
  expect(grantOf(delegatedOwner({ conversationId: null, key: { engine: "codex", sessionId: "worker-generation" } })))
    .toEqual(["viewer"]);
  /* A key pointing at a row no generation owns attests nothing and the receipt
     keeps its grant, so both denials are the delegated OWNER rather than the
     receipt merely carrying a key. */
  expect(grantOf(delegatedOwner({ conversationId: null, key: { engine: "codex", sessionId: "unowned-generation" } })))
    .toEqual(grant);

  /* Two conversations claiming one entry row key with different origins name no
     owner at all. A receipt keyed at that row is denied rather than handed
     whichever of the two readings suits it. */
  const disputed = delegatedOwner({ conversationId: null, key: { engine: "codex", sessionId: "worker-generation" } }) as unknown as {
    conversations: Record<string, unknown>;
  };
  disputed.conversations.conversation_root = {
    engine: "codex",
    agentRole: null,
    delegationDepth: 0,
    generations: [{
      id: "worker-generation",
      path: null,
      launchProfile: { parentConversationId: null, mcpServers: ["viewer"] },
    }],
  };
  expect(grantOf(disputed as unknown as StoredGrantFile)).toEqual(["viewer"]);
});

test("a conversation whose lineage edge contradicts its own row is denied rather than believed", () => {
  const grant = ["viewer", "test-connector"];
  /* The row settlement writes from a receipt forged into root shape: depth 0,
     no role, no parent — while the edge admission wrote still records a parent.
     Two rows, one of them lying, and no way to tell which. */
  const contradicted = () => ({
    conversations: {
      conversation_worker: {
        id: "conversation_worker",
        engine: "codex",
        agentRole: null,
        delegationDepth: 0,
        generations: [{
          id: "worker-generation",
          path: "/sessions/worker.jsonl",
          launchProfile: { ...emptyLaunchProfile(), parentConversationId: null, mcpServers: [...grant] },
        }],
      },
    },
    lineageEdges: {
      conversation_worker: { childConversationId: "conversation_worker", parentConversationId: "conversation_root" },
    },
    entries: {
      "codex:worker-generation": { artifactPath: "/sessions/worker.jsonl", launchProfile: { mcpServers: [...grant] } },
    },
  } as unknown as StoredGrantFile);

  const rebounded = reboundAssembledMcpGrants(contradicted(), WITH_CONNECTOR);
  expect(rebounded.conversations.conversation_worker!.generations[0]!.launchProfile.mcpServers).toEqual(["viewer"]);
  expect(rebounded.entries["codex:worker-generation"]!.launchProfile!.mcpServers).toEqual(["viewer"]);

  /* Drop the edge and the same row is an ordinary operator root again, so the
     denial above is the contradiction rather than the row's own shape. */
  const uncontradicted = contradicted();
  delete (uncontradicted as { lineageEdges?: unknown }).lineageEdges;
  expect(reboundAssembledMcpGrants(uncontradicted, WITH_CONNECTOR)
    .conversations.conversation_worker!.generations[0]!.launchProfile.mcpServers).toEqual(grant);
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

/**
 * Every `SqliteAgentRegistryStore` method that reaches a row writer, read out of
 * the SOURCE rather than listed by hand.
 *
 * The origin half of the grant bound is a PRECONDITION of a row being observed
 * or written, and this lane has now reopened that ordering twice — once because
 * a mutation ran on lazily normalized rows, once because a wholesale
 * replacement carried its payload in from outside. A new mutation path is the
 * obvious third way in, so it has to fail here until somebody exercises it,
 * rather than quietly inheriting whatever gate the path it was copied from had.
 */
function storeMutationEntryPoints(): string[] {
  const lines = fs.readFileSync(path.join(import.meta.dir, "sqliteRegistryStore.ts"), "utf8").split("\n");
  const writes = /this\.(persistAll|persistDiff|persistChanges)\(/;
  const signature = /^ {2}(?:private |protected |public |static )*(?:async )?([A-Za-z_]\w*)\s*(?:<[^(]*>)?\(/;
  const found = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!writes.test(line)) continue;
    for (let above = index; above >= 0; above -= 1) {
      const match = signature.exec(lines[above]!);
      if (!match) continue;
      found.add(match[1]!);
      break;
    }
  }
  return [...found].sort();
}

function storedReceiptGrant(sqlitePath: string, launchId: string): string[] {
  const db = new Database(sqlitePath, { strict: true });
  try {
    const row = db.query<{ value_json: string }, [string, string]>(
      "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
    ).get("receipts", launchId);
    if (!row) throw new Error(`expected a stored receipts row for ${launchId}`);
    return (JSON.parse(row.value_json) as { launchProfile: { mcpServers: string[] } }).launchProfile.mcpServers;
  } finally {
    db.close();
  }
}

/** The same forgery `forgeSqliteReceiptOrigin` writes, applied to a file the
    caller is about to hand a store, for the entry points whose payload arrives
    from outside rather than off disk. */
function forgeReceiptOriginInFile(file: RegistryFile, launchId: string, forgery: ReceiptForgery, grant: string[]): void {
  const receipt = file.receipts[launchId] as unknown as ReceiptForgery & { launchProfile: Record<string, unknown> };
  if (!receipt) throw new Error(`expected a receipt for ${launchId}`);
  Object.assign(receipt, forgery);
  receipt.launchProfile = { ...receipt.launchProfile, parentConversationId: null, mcpServers: [...grant] };
}

test("every SQLite store mutation entry point re-decides grants before it can persist a row", () => {
  const grant = ["viewer", "test-connector"];
  const storage = { sqliteMode: "sqlite" as const, mcpGrantPolicy: WITH_CONNECTOR };
  const storeOptions = {
    normalize: (value: unknown) => normalizeRegistry(value, WITH_CONNECTOR),
    mcpGrantPolicy: WITH_CONNECTOR,
  };

  /** A forged delegated receipt and an honest root one, both admitted and
      unsettled, on a real registry backed by SQLite. */
  const seed = (label: string) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-mcp-entrypoint-${label}-`));
    const sqlitePath = path.join(directory, "agent-registry.sqlite");
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, storage);
    const rootId = settledParent(registry, ["viewer"], `entrypoint-parent-${label}`);
    const workerId = settledDelegatedChild(registry, rootId, `entrypoint-worker-${label}`);
    const forged = admittedDelegatedChild(registry, rootId).launchId;
    const honest = registry.beginSpawnRequest({ engine: "codex", cwd: "/repo" }).receipt.launchId;
    return { directory, sqlitePath, registry, rootId, workerId, forged, honest };
  };

  /** A conversation row rewritten into root shape and helped to a connector, on
      its GENERATIONS and nowhere else. Its lineage edge is left alone.

      The row-at-a-time normalize decides a conversation from its own origin
      fields, which this rewrite now satisfies, so only the assembled decision —
      which can see the edge still recording a parent — denies it. That makes
      this the case where the gate has to look INSIDE the row: the grant it
      claims lives on a nested generation profile, not at the row's top level. */
  const forgeConversationIntoRoot = (sqlitePath: string, conversationId: string, intoRoot: boolean) => {
    const db = new Database(sqlitePath, { strict: true });
    try {
      const row = db.query<{ value_json: string }, [string, string]>(
        "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
      ).get("conversations", conversationId);
      if (!row) throw new Error(`expected a stored conversations row for ${conversationId}`);
      const parsed = JSON.parse(row.value_json) as {
        agentRole: string | null;
        delegationDepth: number | null;
        generations: { launchProfile: { mcpServers: string[]; parentConversationId: string | null } }[];
      };
      if (intoRoot) {
        parsed.agentRole = null;
        parsed.delegationDepth = 0;
      }
      for (const generation of parsed.generations) {
        generation.launchProfile.mcpServers = [...grant];
        if (intoRoot) generation.launchProfile.parentConversationId = null;
      }
      db.query<unknown, [string, string, string]>(
        "UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?",
      ).run(JSON.stringify(parsed), "conversations", conversationId);
    } finally {
      db.close();
    }
  };

  /* Each entry point is driven for real, with the forgery arriving the way that
     entry point receives its payload. The honest root's receipt rides along
     through the same call, so a gate that simply wiped every grant would fail
     here rather than pass. */
  const exercises: Record<string, () => void> = {
    /* Two routes to a row, each on its own seed so neither can cover for the
       other: whichever read comes FIRST in a mutation is the one that has to
       run the decision, and a second read afterwards would hide a first that
       did not. */
    mutate: () => {
      const receipts = seed("mutate-receipts");
      try {
        forgeSqliteReceiptOrigin(receipts.sqlitePath, receipts.forged, ROOT_SHAPE, grant);
        forgeSqliteReceiptOrigin(receipts.sqlitePath, receipts.honest, ROOT_SHAPE, grant);
        const store = new SqliteAgentRegistryStore(receipts.sqlitePath, {
          ...storeOptions,
          initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }, WITH_CONNECTOR),
        });
        /* What settlement and the structured claim do: reach for the receipt row
           by key, here out of the cache a preceding enumeration filled — the
           route a boot sweep takes, and a second way in that has to be gated as
           the keyed one is. The row the operation sees is already decided, and
           the decision is what the mutation then persists. */
        const seenByOperation = store.mutate((file) => {
          expect(Object.keys(file.receipts)).toContain(receipts.forged);
          return [
            file.receipts[receipts.forged]!.launchProfile.mcpServers,
            file.receipts[receipts.honest]!.launchProfile.mcpServers,
          ];
        }).result;
        expect(seenByOperation).toEqual([["viewer"], grant]);
        expect(storedReceiptGrant(receipts.sqlitePath, receipts.forged)).toEqual(["viewer"]);
        expect(storedReceiptGrant(receipts.sqlitePath, receipts.honest)).toEqual(grant);
      } finally {
        fs.rmSync(receipts.directory, { recursive: true, force: true });
      }

      const conversations = seed("mutate-conversations");
      try {
        forgeConversationIntoRoot(conversations.sqlitePath, conversations.workerId, true);
        forgeConversationIntoRoot(conversations.sqlitePath, conversations.rootId, false);
        const store = new SqliteAgentRegistryStore(conversations.sqlitePath, {
          ...storeOptions,
          initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }, WITH_CONNECTOR),
        });
        /* Nothing else is read first. A conversation row claims a grant only
           through a profile NESTED in its generations, so a gate that looked no
           deeper than the row's top level would hand this one over untouched. */
        const seenByOperation = store.mutate((file) => [
          file.conversations[conversations.workerId]!.generations.at(-1)!.launchProfile.mcpServers,
          file.conversations[conversations.rootId]!.generations.at(-1)!.launchProfile.mcpServers,
        ]).result;
        expect(seenByOperation).toEqual([["viewer"], grant]);
      } finally {
        fs.rmSync(conversations.directory, { recursive: true, force: true });
      }
    },
    replace: () => {
      const { directory, sqlitePath, registry, forged, honest } = seed("replace");
      try {
        const store = new SqliteAgentRegistryStore(sqlitePath, {
          ...storeOptions,
          initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }, WITH_CONNECTOR),
        });
        const file = registry.snapshot();
        forgeReceiptOriginInFile(file, forged, ROOT_SHAPE, grant);
        forgeReceiptOriginInFile(file, honest, ROOT_SHAPE, grant);
        expect(store.replace(file, store.revision()).replaced).toBe(true);
        expect(storedReceiptGrant(sqlitePath, forged)).toEqual(["viewer"]);
        expect(storedReceiptGrant(sqlitePath, honest)).toEqual(grant);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    importFirstBoot: () => {
      const { directory, registry, forged, honest } = seed("import");
      try {
        const file = registry.snapshot();
        forgeReceiptOriginInFile(file, forged, ROOT_SHAPE, grant);
        forgeReceiptOriginInFile(file, honest, ROOT_SHAPE, grant);
        const importedPath = path.join(directory, "imported.sqlite");
        new SqliteAgentRegistryStore(importedPath, { ...storeOptions, initialSnapshot: file });
        expect(storedReceiptGrant(importedPath, forged)).toEqual(["viewer"]);
        expect(storedReceiptGrant(importedPath, honest)).toEqual(grant);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };

  expect(storeMutationEntryPoints()).toEqual(Object.keys(exercises).sort());
  for (const exercise of Object.values(exercises)) exercise();
});
