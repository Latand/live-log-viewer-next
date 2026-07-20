import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { AgentRegistry, type ConversationObservation, type SpawnLineageEdge } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

function registry(): AgentRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-engine-native-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"));
}

const SLUG = "-home-agent-project";
const PARENT_SID = "11111111-2222-3333-4444-555555555555";
const PARENT_PATH = `/claude/${SLUG}/${PARENT_SID}.jsonl`;
const CHILD_PATHS = [
  `/claude/${SLUG}/${PARENT_SID}/subagents/agent-c1.jsonl`,
  `/claude/${SLUG}/${PARENT_SID}/subagents/workflows/wf-1/agent-c2.jsonl`,
  `/claude/${SLUG}/${PARENT_SID}/subagents/workflows/wf-1/agent-c3.jsonl`,
];

function observation(pathname: string, parentArtifactPath: string | null): ConversationObservation {
  return {
    engine: "claude",
    path: pathname,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-20T12:00:00.000Z",
    parentArtifactPath,
  };
}

describe("engine-native subagent lineage (issue #339)", () => {
  test("first inventory of one parent and three children persists three engine-native edges in one mutation", () => {
    const store = registry();
    // Children observed BEFORE the parent: the parent has no prior registry
    // identity, so only the post-admission pass can resolve these edges.
    store.reconcileConversations([
      ...CHILD_PATHS.map((childPath) => observation(childPath, PARENT_PATH)),
      observation(PARENT_PATH, null),
    ]);

    const snapshot = store.snapshot();
    expect(Object.values(snapshot.conversations)).toHaveLength(4);
    const parentId = store.conversationForPath(PARENT_PATH)!.id;
    for (const childPath of CHILD_PATHS) {
      const childId = store.conversationForPath(childPath)!.id;
      expect(snapshot.lineageEdges[childId]).toMatchObject({
        parentConversationId: parentId,
        childArtifactPath: childPath,
        source: "engine-native",
      });
    }
  });

  test("an existing viewer-spawn edge stays authoritative when scanner evidence arrives", () => {
    const store = registry();
    const realParent = store.ensureConversation("claude", PARENT_PATH, null);
    const child = store.ensureConversation("claude", CHILD_PATHS[0]!, null);
    const impostorParentPath = `/claude/${SLUG}/99999999-8888-7777-6666-555555555555.jsonl`;

    const persisted = store.snapshot();
    const edge: SpawnLineageEdge = {
      childConversationId: child.id,
      parentConversationId: realParent.id,
      childSessionKey: null,
      parentSessionKey: null,
      childArtifactPath: CHILD_PATHS[0]!,
      parentArtifactPath: PARENT_PATH,
      kind: "spawn",
      role: null,
      reviewsConversationId: null,
      source: "viewer-spawn",
      evidence: { launchId: "launch-1", clientAttemptId: null },
      createdAt: "2026-07-20T11:00:00.000Z",
    };
    persisted.lineageEdges[child.id] = edge;
    fs.writeFileSync(store.filename, JSON.stringify(persisted));

    const restarted = new AgentRegistry(store.filename);
    // A late engine-native observation points the child at an impostor parent.
    restarted.reconcileConversations([
      observation(impostorParentPath, null),
      observation(CHILD_PATHS[0]!, impostorParentPath),
    ]);

    expect(restarted.snapshot().lineageEdges[child.id]).toMatchObject({
      parentConversationId: realParent.id,
      source: "viewer-spawn",
    });
  });
});
