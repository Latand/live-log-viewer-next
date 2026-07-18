import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { AgentRegistry, type AgentRegistrySqliteMode, type ConversationObservation } from "./registry";

/*
 * Issue #97 — one-click successor reseat of a rate-limited conversation.
 * The registry seam must be lineage-safe (no duplicate successor, ever) and
 * durable across a viewer restart in both persistence modes.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function registryFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-reseat-"));
  roots.push(root);
  return path.join(root, "agent-registry.json");
}

function observation(pathname: string, accountId: string): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({
      cwd: "/repo/checkout",
      model: "gpt-5.6-terra",
      title: "Implementer",
      project: "repo",
      role: "worker",
      parentConversationId: "conversation_parent",
    }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T18:00:00.000Z",
  };
}

function seededRegistry(mode: AgentRegistrySqliteMode, filename: string): { store: AgentRegistry; id: ViewerConversationId } {
  const store = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
  store.reconcileConversations([observation("/sessions/limited.jsonl", "limited")]);
  const id = store.conversationForPath("/sessions/limited.jsonl")!.id;
  return { store, id };
}

for (const mode of ["off", "sqlite"] as const) {
  test(`a requested reseat survives a ${mode === "off" ? "JSON" : "SQLite"} registry restart with cwd and parentage intact`, () => {
    const filename = registryFile();
    const { store, id } = seededRegistry(mode, filename);
    const requested = store.requestConversationReseat(id, "healthy");
    expect(requested.migration).toMatchObject({ targetId: "healthy", phase: "requested" });

    const reopened = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
    const restored = reopened.conversation(id)!;
    expect(restored.migration).toMatchObject({
      targetId: "healthy",
      phase: "requested",
      operationId: requested.migration!.operationId,
      sourceGenerationId: requested.migration!.sourceGenerationId,
    });
    /* The successor inherits the source launch profile at commit time — the
       restart must not lose the cwd/parent lineage the fork will copy. */
    const source = restored.generations.at(-1)!;
    expect(source.launchProfile.cwd).toBe("/repo/checkout");
    expect(source.launchProfile.parentConversationId).toBe("conversation_parent");
    const intents = Object.values(reopened.snapshot().migrationIntents);
    expect(intents).toHaveLength(1);
    /* The reseat rides a conversation-scoped intent and must still be one
       after restart — an engine-scoped survivor would drain the whole engine. */
    expect(intents[0]).toMatchObject({ scope: "conversation", targetId: "healthy", state: "draining" });
  });
}

test("a conversation reseat never reuses or retargets the single engine drain intent", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const reseated = store.requestConversationReseat(id, "healthy");
  const reseatIntentId = reseated.migration!.intentId;
  expect(store.snapshot().migrationIntents[reseatIntentId]).toMatchObject({ scope: "conversation", targetId: "healthy", state: "draining" });

  /* An engine-wide drain that starts while the reseat is in flight must mint
     its own intent instead of adopting and retargeting the reseat's. */
  const engineIntent = store.upsertMigrationIntent("codex", "engine-target", "manual", "engine-drain-request");
  expect(engineIntent.id).not.toBe(reseatIntentId);
  expect(store.snapshot().migrationIntents[reseatIntentId]).toMatchObject({ scope: "conversation", targetId: "healthy", requestIds: [`reseat:${id}:${reseated.migration!.sourceGenerationId}`] });

  /* Single engine-drain invariant: exactly one engine-scoped draining intent,
     and repeat engine requests keep converging on it. */
  const engineDrains = Object.values(store.snapshot().migrationIntents)
    .filter((intent) => intent.state === "draining" && (intent.scope ?? "engine") === "engine");
  expect(engineDrains).toHaveLength(1);
  expect(engineDrains[0]!.id).toBe(engineIntent.id);
  expect(store.upsertMigrationIntent("codex", "engine-target", "manual", "engine-drain-repeat").id).toBe(engineIntent.id);
});

test("a new spawn during a conversation reseat is never adopted into the drain", () => {
  const { store, id } = seededRegistry("off", registryFile());
  store.requestConversationReseat(id, "healthy");

  const spawnEntry = (sessionId: string, artifactPath: string) => ({
    key: { engine: "codex" as const, sessionId },
    artifactPath,
    cwd: "/repo/checkout",
    accountId: "limited",
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const spawn = store.beginSpawn("codex", "/repo/checkout");
  const settled = store.settleSpawn(spawn.launchId, spawnEntry("019f4906-3f67-7b72-9fbc-9ec3b5ad1326", "/sessions/unrelated-spawn.jsonl"));
  expect(settled.kind).toBe("settled");
  expect(store.conversationForPath("/sessions/unrelated-spawn.jsonl")!.migration).toBeNull();

  /* The engine-wide contract is untouched: once a real engine drain is
     active, a spawn born on the departed account is still adopted. */
  store.commitMigrationIntent({
    engine: "codex",
    targetId: "engine-target",
    origin: "manual",
    requestId: "engine-wide-after-reseat",
    expectedRevision: store.engineRouting("codex").revision,
  });
  const second = store.beginSpawn("codex", "/repo/checkout");
  expect(store.settleSpawn(second.launchId, spawnEntry("019f4906-3f67-7b72-9fbc-9ec3b5ad1327", "/sessions/adopted-spawn.jsonl")).kind).toBe("settled");
  expect(store.conversationForPath("/sessions/adopted-spawn.jsonl")!.migration).toMatchObject({ targetId: "engine-target" });
});

test("repeat reseat clicks never mint a second successor operation", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const first = store.requestConversationReseat(id, "healthy");
  const second = store.requestConversationReseat(id, "healthy");
  expect(second.migration!.operationId).toBe(first.migration!.operationId);
  expect(Object.values(store.snapshot().migrationIntents)).toHaveLength(1);

  /* Even a click that races the coordinator mid-fork (any in-flight phase, any
     target) must not re-request: the running operation owns the successor. */
  const inFlight = store.transitionConversationMigration(id, first.migration!.revision, ["requested"], { phase: "successor-starting" });
  const raced = store.requestConversationReseat(id, "other-healthy");
  expect(raced.migration).toMatchObject({
    targetId: "healthy",
    phase: "successor-starting",
    operationId: inFlight.migration!.operationId,
  });
});

test("a thread a migration already forked is never reseated again", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const requested = store.requestConversationReseat(id, "healthy");
  const revision = requested.migration!.revision;
  store.transitionConversationMigration(id, revision, ["requested"], { phase: "preparing" });
  store.transitionConversationMigration(id, revision, ["preparing"], { phase: "successor-starting" });
  store.transitionConversationMigration(id, revision, ["successor-starting"], { phase: "verifying" });
  const committed = store.commitSuccessor(id, {
    id: "successor-native-id",
    path: "/sessions/successor.jsonl",
    accountId: "healthy",
  }, revision);
  expect(committed.migration!.phase).toBe("committed");
  expect(committed.generations).toHaveLength(2);
  expect(committed.generations.at(-1)!.launchProfile.cwd).toBe("/repo/checkout");

  const repeated = store.requestConversationReseat(id, "healthy");
  expect(repeated.migration!.phase).toBe("committed");
  expect(repeated.migration!.operationId).toBe(committed.migration!.operationId);
  expect(repeated.generations).toHaveLength(2);
});
