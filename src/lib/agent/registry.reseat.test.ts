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
    expect(Object.values(reopened.snapshot().migrationIntents)).toHaveLength(1);
  });
}

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
