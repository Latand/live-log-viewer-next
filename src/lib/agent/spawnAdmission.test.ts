import { expect, test } from "bun:test";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import type { DurableConversationMembership, RegistryConversation, RegistryFile, SpawnLineageEdge } from "./registry";
import {
  SPAWN_DENIED_ROLE_IDS,
  conversationAgentRole,
  conversationDelegationDepth,
  isSpawnDeniedRole,
  nestingDepthGuidance,
  resolveSpawnOrigin,
  reviewerOriginSpawnGuidance,
} from "./spawnAdmission";

type FileView = Pick<RegistryFile, "conversations" | "conversationAliases" | "lineageEdges" | "memberships">;

function conversation(id: string, fields: Partial<RegistryConversation> = {}): RegistryConversation {
  return {
    id: id as ViewerConversationId,
    engine: "codex",
    generations: [],
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
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...fields,
  };
}

function edge(child: string, parent: string, fields: Partial<SpawnLineageEdge> = {}): SpawnLineageEdge {
  return {
    childConversationId: child as ViewerConversationId,
    parentConversationId: parent as ViewerConversationId,
    childSessionKey: null,
    parentSessionKey: null,
    childArtifactPath: null,
    parentArtifactPath: null,
    kind: "spawn",
    role: null,
    reviewsConversationId: null,
    source: "viewer-spawn",
    evidence: { launchId: null, clientAttemptId: null },
    createdAt: "2026-07-18T00:00:00.000Z",
    ...fields,
  };
}

function membership(conversationId: string, role: string, createdAt: string): DurableConversationMembership {
  return {
    conversationId: conversationId as ViewerConversationId,
    kind: "pipeline",
    containerId: "pipe1234",
    role,
    slot: `${role}:${createdAt}`,
    stageId: null,
    stageOrder: null,
    round: null,
    parentConversationId: null,
    createdAt,
  };
}

function view(fields: Partial<FileView> = {}): FileView {
  return { conversations: {}, conversationAliases: {}, lineageEdges: {}, memberships: {}, ...fields };
}

test("the denied-role contract pins reviewer and verifier and nothing else", () => {
  expect(SPAWN_DENIED_ROLE_IDS).toEqual(["reviewer", "verifier"]);
  expect(isSpawnDeniedRole("reviewer")).toBe(true);
  expect(isSpawnDeniedRole("verifier")).toBe(true);
  expect(isSpawnDeniedRole("builder")).toBe(false);
  expect(isSpawnDeniedRole(null)).toBe(false);
  expect(isSpawnDeniedRole(undefined)).toBe(false);
});

test("role resolution prefers the recorded conversation role, then lineage edge, then newest membership", () => {
  const recorded = view({
    conversations: { conversation_a: conversation("conversation_a", { agentRole: "builder" }) },
    lineageEdges: { conversation_a: edge("conversation_a", "conversation_p", { role: "reviewer" }) },
  });
  expect(conversationAgentRole(recorded, "conversation_a" as ViewerConversationId)).toBe("builder");

  const edged = view({
    conversations: { conversation_a: conversation("conversation_a") },
    lineageEdges: { conversation_a: edge("conversation_a", "conversation_p", { role: "reviewer" }) },
  });
  expect(conversationAgentRole(edged, "conversation_a" as ViewerConversationId)).toBe("reviewer");

  const membered = view({
    memberships: {
      conversation_a: [
        membership("conversation_a", "builder", "2026-07-01T00:00:00.000Z"),
        membership("conversation_a", "verifier", "2026-07-02T00:00:00.000Z"),
      ],
    },
  });
  expect(conversationAgentRole(membered, "conversation_a" as ViewerConversationId)).toBe("verifier");

  expect(conversationAgentRole(view(), "conversation_unknown" as ViewerConversationId)).toBeNull();
});

test("role resolution follows conversation aliases", () => {
  const aliased = view({
    conversationAliases: { conversation_old: "conversation_new" as ViewerConversationId },
    conversations: { conversation_new: conversation("conversation_new", { agentRole: "reviewer" }) },
  });
  expect(conversationAgentRole(aliased, "conversation_old" as ViewerConversationId)).toBe("reviewer");
});

test("depth resolution prefers the recorded depth and falls back membership-first for legacy records", () => {
  const recorded = view({
    conversations: { conversation_a: conversation("conversation_a", { delegationDepth: 2 }) },
    memberships: { conversation_a: [membership("conversation_a", "builder", "2026-07-01T00:00:00.000Z")] },
  });
  expect(conversationDelegationDepth(recorded, "conversation_a" as ViewerConversationId)).toBe(2);

  /* Legacy container children chain lineage stage-to-stage; membership means
     depth 1, not the lineage-hop count. */
  const containerLegacy = view({
    conversations: { conversation_a: conversation("conversation_a") },
    memberships: { conversation_a: [membership("conversation_a", "builder", "2026-07-01T00:00:00.000Z")] },
    lineageEdges: {
      conversation_a: edge("conversation_a", "conversation_b"),
      conversation_b: edge("conversation_b", "conversation_c"),
      conversation_c: edge("conversation_c", "conversation_root"),
    },
  });
  expect(conversationDelegationDepth(containerLegacy, "conversation_a" as ViewerConversationId)).toBe(1);

  expect(conversationDelegationDepth(view(), "conversation_root" as ViewerConversationId)).toBe(0);
});

test("legacy depth walks lineage edges bounded and cycle-guarded", () => {
  const chained = view({
    lineageEdges: {
      conversation_a: edge("conversation_a", "conversation_b"),
      conversation_b: edge("conversation_b", "conversation_c"),
    },
  });
  expect(conversationDelegationDepth(chained, "conversation_a" as ViewerConversationId)).toBe(2);

  const withRecordedAncestor = view({
    conversations: { conversation_b: conversation("conversation_b", { delegationDepth: 3 }) },
    lineageEdges: { conversation_a: edge("conversation_a", "conversation_b") },
  });
  expect(conversationDelegationDepth(withRecordedAncestor, "conversation_a" as ViewerConversationId)).toBe(4);

  const cyclic = view({
    lineageEdges: {
      conversation_a: edge("conversation_a", "conversation_b"),
      conversation_b: edge("conversation_b", "conversation_a"),
    },
  });
  expect(conversationDelegationDepth(cyclic, "conversation_a" as ViewerConversationId)).toBe(1);

  const edges: FileView["lineageEdges"] = {};
  for (let index = 0; index < 20; index += 1) {
    edges[`conversation_${index}`] = edge(`conversation_${index}`, `conversation_${index + 1}`);
  }
  expect(conversationDelegationDepth(view({ lineageEdges: edges }), "conversation_0" as ViewerConversationId)).toBe(8);

  /* Engine-native lineage never contributes delegation depth. */
  const native = view({
    lineageEdges: { conversation_a: edge("conversation_a", "conversation_b", { source: "engine-native" }) },
  });
  expect(conversationDelegationDepth(native, "conversation_a" as ViewerConversationId)).toBe(0);
});

test("origin resolution keys on the agent caller or the container creator", () => {
  const file = view({
    conversations: {
      conversation_reviewer: conversation("conversation_reviewer", { agentRole: "reviewer", delegationDepth: 1 }),
    },
  });
  expect(resolveSpawnOrigin(file, { kind: "agent", conversationId: "conversation_reviewer" as ViewerConversationId })).toEqual({
    kind: "agent",
    conversationId: "conversation_reviewer" as ViewerConversationId,
    role: "reviewer",
    depth: 1,
  });
  expect(resolveSpawnOrigin(file, {
    kind: "container",
    container: "pipeline",
    containerId: "pipe1234",
    creatorConversationId: "conversation_reviewer" as ViewerConversationId,
  })).toEqual({
    kind: "container",
    conversationId: "conversation_reviewer" as ViewerConversationId,
    role: "reviewer",
    depth: 1,
  });
  expect(resolveSpawnOrigin(file, {
    kind: "container",
    container: "flow",
    containerId: "flow1234",
    creatorConversationId: null,
  })).toEqual({ kind: "container", conversationId: null, role: null, depth: 0 });
  expect(resolveSpawnOrigin(file, { kind: "operator" })).toBeNull();
  expect(resolveSpawnOrigin(file, { kind: "external" })).toBeNull();
  expect(resolveSpawnOrigin(file, { kind: "successor" })).toBeNull();
});

test("rejection guidance is actionable and names the escalation paths", () => {
  expect(reviewerOriginSpawnGuidance("reviewer")).toContain("in-session");
  expect(reviewerOriginSpawnGuidance("verifier")).toStartWith("Verifier");
  expect(nestingDepthGuidance(3, 2)).toContain("depth 2");
  expect(nestingDepthGuidance(3, 2)).toContain("maxAgentNestingDepth");
});
