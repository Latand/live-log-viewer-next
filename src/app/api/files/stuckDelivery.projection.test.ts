/**
 * Issue #1213 — the `/api/files` projection that tells the board a message is owed.
 *
 * Every attention test builds `file.stuckDelivery` by hand, so the projection
 * that actually produces it could stop matching with all of them green. This is
 * the one place the annotation is derived from a registry snapshot: which
 * reservations count, which card carries it, and which conversation id it is
 * filed under.
 *
 * Runs against an in-memory snapshot inside a throwaway state directory —
 * nothing here reads the operator's registry or touches a host.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests, type RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { buildFilesResponse } from "./response";

let registryRoot = "";
let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1213-files-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1213-files-state-"));
  process.env.LLV_STATE_DIR = stateDir;
});

afterEach(() => {
  setAgentRegistryForTests(null);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const FIXTURE_NOW = "2026-08-27T10:00:00.000Z";
const LIVE_PATH = "/sessions/1213/live.jsonl";
const SUPERSEDED_PATH = "/sessions/1213/superseded.jsonl";
type FixtureConversationId = RegistryFile["conversations"][string]["id"];
const LIVE = "conversation_1213-live" as FixtureConversationId;
/** The id a reservation was written under before a migration rekeyed it. */
const ALIAS = "conversation_1213-alias" as FixtureConversationId;

function conversation(
  id: FixtureConversationId,
  generationPaths: readonly string[],
): RegistryFile["conversations"][string] {
  return {
    id,
    engine: "codex",
    generations: generationPaths.map((pathname, index) => ({
      id: `generation-${index}`,
      path: pathname,
      accountId: null,
      launchProfile: emptyLaunchProfile({ title: "Delivery fixture", project: "delivery-fixture" }),
      historyHash: null,
      host: null,
      createdAt: FIXTURE_NOW,
      archivedAt: null,
    })),
    continuityPaths: [],
    abandonedContinuityPaths: [],
    providerForkPaths: [],
    projectOwnership: null,
    migration: null,
    migrationOptOut: null,
    supersededBy: null,
    agentRole: null,
    delegationDepth: null,
    turn: { state: "busy", source: "empty", terminalAt: null, observedAt: null },
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  } as RegistryFile["conversations"][string];
}

function heldDelivery(
  id: string,
  conversationId: FixtureConversationId,
  state: RegistryFile["heldDeliveries"][string]["state"],
  createdAt: string,
  attempts: number,
): RegistryFile["heldDeliveries"][string] {
  return {
    id,
    conversationId,
    runtimeConversationId: conversationId,
    text: "the operator's message",
    createdAt,
    clientMessageId: id,
    payloadKind: "text",
    runtimeImages: [],
    contentDigest: null,
    artifactPaths: [],
    command: { operationId: `op_${id}`, kind: "send", policy: "queue" },
    requestDigest: null,
    state,
    generationId: "generation-0",
    attempts,
    assignedAt: createdAt,
    deliveredAt: state === "delivered" ? createdAt : null,
    error: null,
  } as RegistryFile["heldDeliveries"][string];
}

function scannedFile(pathname: string): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "delivery-fixture",
    title: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

async function project(
  mutate: (snapshot: RegistryFile) => void,
  paths: readonly string[] = [LIVE_PATH],
): Promise<Record<string, FileEntry>> {
  const registry = new AgentRegistry(path.join(registryRoot, "registry.json"));
  const snapshot = registry.snapshot();
  mutate(snapshot);
  (registry as unknown as { readOnlySnapshot: () => RegistryFile }).readOnlySnapshot = () => snapshot;
  setAgentRegistryForTests(registry);
  const response = await buildFilesResponse(new Request("http://127.0.0.1/api/files"), {
    listFilesWithProjectCatalog: async () => ({
      files: paths.map((pathname) => scannedFile(pathname)),
      projectCatalog: [],
      complete: true,
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { files: FileEntry[] };
  return Object.fromEntries(body.files.map((file) => [file.path, file]));
}

test("#1213 an owed message annotates its conversation's live card with how long it has waited", async () => {
  const files = await project((snapshot) => {
    snapshot.conversations[LIVE] = conversation(LIVE, [LIVE_PATH]);
    snapshot.heldDeliveries["held-1"] = heldDelivery("held-1", LIVE, "delivery-uncertain", FIXTURE_NOW, 2);
  });
  expect(files[LIVE_PATH]!.stuckDelivery).toEqual({
    since: FIXTURE_NOW,
    attempts: 2,
    state: "delivery-uncertain",
  });
});

test("#1213 the OLDEST owed message is the one the card reports", async () => {
  /* The operator is blocked from the first message that stopped arriving, not
     the last one they typed on top of it. */
  const older = "2026-08-27T09:30:00.000Z";
  const files = await project((snapshot) => {
    snapshot.conversations[LIVE] = conversation(LIVE, [LIVE_PATH]);
    snapshot.heldDeliveries["held-new"] = heldDelivery("held-new", LIVE, "assigned", FIXTURE_NOW, 1);
    snapshot.heldDeliveries["held-old"] = heldDelivery("held-old", LIVE, "delivery-uncertain", older, 3);
  });
  expect(files[LIVE_PATH]!.stuckDelivery).toEqual({ since: older, attempts: 3, state: "delivery-uncertain" });
});

test("#1213 a settled reservation annotates nothing", async () => {
  for (const state of ["delivered", "failed"] as const) {
    const files = await project((snapshot) => {
      snapshot.conversations[LIVE] = conversation(LIVE, [LIVE_PATH]);
      snapshot.heldDeliveries["held-1"] = heldDelivery("held-1", LIVE, state, FIXTURE_NOW, 2);
    });
    expect(files[LIVE_PATH]!.stuckDelivery).toBeUndefined();
  }
});

test("#1213 only the live generation carries the annotation", async () => {
  /* A superseded round can no longer take delivery of anything, and a retired
     card raising an alarm sends the operator to a conversation that ended. */
  const files = await project(
    (snapshot) => {
      snapshot.conversations[LIVE] = conversation(LIVE, [SUPERSEDED_PATH, LIVE_PATH]);
      snapshot.heldDeliveries["held-1"] = heldDelivery("held-1", LIVE, "delivery-uncertain", FIXTURE_NOW, 1);
    },
    [SUPERSEDED_PATH, LIVE_PATH],
  );
  expect(files[LIVE_PATH]!.stuckDelivery).toBeDefined();
  expect(files[SUPERSEDED_PATH]!.stuckDelivery).toBeUndefined();
});

test("#1213 a reservation written under a rekeyed id still reaches the card that owns it", async () => {
  /* An account migration rekeys the conversation and leaves an alias behind.
     The reservation keeps the id it was written under; the card is read by the
     canonical one. Keying this map raw loses exactly the messages a migration
     left owed — the population least likely to arrive on its own. */
  const files = await project((snapshot) => {
    snapshot.conversations[LIVE] = conversation(LIVE, [LIVE_PATH]);
    snapshot.conversationAliases[ALIAS] = LIVE;
    snapshot.heldDeliveries["held-1"] = heldDelivery("held-1", ALIAS, "delivery-uncertain", FIXTURE_NOW, 2);
  });
  expect(files[LIVE_PATH]!.stuckDelivery).toEqual({
    since: FIXTURE_NOW,
    attempts: 2,
    state: "delivery-uncertain",
  });
});

test("#1213 a conversation with nothing owed carries no field at all", async () => {
  const files = await project((snapshot) => {
    snapshot.conversations[LIVE] = conversation(LIVE, [LIVE_PATH]);
  });
  expect(files[LIVE_PATH]!.stuckDelivery).toBeUndefined();
});
