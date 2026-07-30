import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import {
  AgentRegistry,
  readOnlyConversationLookupFromSnapshot,
  setAgentRegistryForTests,
  type RegistryFile,
} from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { buildFilesResponse } from "./response";

let registryRoot = "";
let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-perf-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-perf-state-"));
  process.env.LLV_STATE_DIR = stateDir;
});

afterEach(() => {
  setAgentRegistryForTests(null);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const CONVERSATIONS = 4_500;
const SCANNED_FILES = 400;
const LINEAGE_EDGES = 2_000;
const FIXTURE_NOW = "2026-07-30T00:00:00.000Z";

type FixtureConversationId = RegistryFile["conversations"][string]["id"];

function conversationId(index: number): FixtureConversationId {
  return `conversation_perf-${index}` as FixtureConversationId;
}

function sessionPath(index: number): string {
  return `/sessions/perf/rollout-${index}.jsonl`;
}

/** A production-shaped registry snapshot: thousands of conversations with
    launch profiles plus a lineage-edge population, built in memory so the
    fixture never touches a real state directory. */
function productionShapedSnapshot(registry: AgentRegistry): RegistryFile {
  const snapshot = registry.snapshot();
  for (let index = 0; index < CONVERSATIONS; index += 1) {
    const id = conversationId(index);
    const pathname = sessionPath(index);
    snapshot.conversations[id] = {
      id,
      engine: "codex",
      generations: [{
        id: `generation-perf-${index}`,
        path: pathname,
        accountId: null,
        launchProfile: emptyLaunchProfile({ title: `Perf session ${index}`, project: "perf-project" }),
        historyHash: null,
        host: null,
        createdAt: FIXTURE_NOW,
        archivedAt: null,
      }],
      continuityPaths: [],
      abandonedContinuityPaths: [],
      providerForkPaths: [],
      projectOwnership: null,
      migration: null,
      migrationOptOut: null,
      supersededBy: null,
      agentRole: null,
      delegationDepth: null,
      turn: { state: "unknown", source: "empty", terminalAt: null, observedAt: null },
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    } as RegistryFile["conversations"][string];
  }
  for (let index = 1; index <= LINEAGE_EDGES; index += 1) {
    snapshot.lineageEdges[conversationId(index)] = {
      childConversationId: conversationId(index),
      parentConversationId: conversationId(0),
      childSessionKey: null,
      parentSessionKey: null,
      childArtifactPath: sessionPath(index),
      parentArtifactPath: sessionPath(0),
      kind: "spawn",
      role: null,
      reviewsConversationId: null,
      source: "viewer-spawn",
      evidence: { launchId: null, clientAttemptId: null },
      createdAt: FIXTURE_NOW,
    };
  }
  return snapshot;
}

function scannedFile(index: number): FileEntry {
  return {
    path: sessionPath(index),
    root: "codex-sessions",
    name: `rollout-${index}.jsonl`,
    project: "perf-project",
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

test("issue 798: a production-shaped files projection reads the registry once, stays within budget, and is byte-stable", async () => {
  const registry = new AgentRegistry(path.join(registryRoot, "registry.json"));
  const snapshot = productionShapedSnapshot(registry);
  let registryReads = 0;
  (registry as unknown as { readOnlySnapshot: () => RegistryFile }).readOnlySnapshot = () => {
    registryReads += 1;
    return snapshot;
  };
  setAgentRegistryForTests(registry);
  const dependencies = {
    listFilesWithProjectCatalog: async () => ({
      files: Array.from({ length: SCANNED_FILES }, (_, index) => scannedFile(index)),
      projectCatalog: [],
      complete: true,
    }),
  };
  const request = () => new Request("http://127.0.0.1/api/files");

  const coldStartedAt = performance.now();
  const cold = await buildFilesResponse(request(), dependencies);
  const coldDuration = performance.now() - coldStartedAt;
  expect(cold.status).toBe(200);
  /* The whole request holds ONE registry snapshot: identity/lineage stamping,
     the title overlay, and the project catalog all consume it. A second read
     is the #798 regression (the title projector re-projecting the registry). */
  expect(registryReads).toBe(1);

  const warmStartedAt = performance.now();
  const warm = await buildFilesResponse(request(), dependencies);
  const warmDuration = performance.now() - warmStartedAt;
  expect(warm.status).toBe(200);
  expect(registryReads).toBe(2);

  const coldBody = await cold.json() as { files: Array<{ path: string; conversationId?: string; parent?: string | null }> };
  expect(coldBody.files).toHaveLength(SCANNED_FILES);
  expect(coldBody.files[1]?.conversationId).toBe(conversationId(1));
  expect(coldBody.files[1]?.parent).toBe(sessionPath(0));
  /* Byte-stable output: identical inputs produce an identical strong ETag, so
     the projection carries no per-request nondeterminism. */
  expect(warm.headers.get("etag")).toBe(cold.headers.get("etag"));

  /* Performance contract, isolated state only: generous CI ceilings that the
     pre-#798 double projection and per-entry deep clones cannot meet at this
     corpus size, while the single-projection path passes with wide margin. */
  expect(coldDuration).toBeLessThan(2_000);
  expect(warmDuration).toBeLessThan(500);
});

test("issue 798: the read-only conversation lookup shares snapshot structure instead of cloning per call", () => {
  const registry = new AgentRegistry(path.join(registryRoot, "registry.json"));
  const snapshot = productionShapedSnapshot(registry);
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const owned = snapshot.conversations[conversationId(7)];
  expect(lookup.conversationForPath(sessionPath(7))).toBe(owned!);
  expect(lookup.conversation(conversationId(7))).toBe(owned!);
  expect(lookup.conversationForPath("/sessions/perf/unknown.jsonl")).toBeNull();
});
