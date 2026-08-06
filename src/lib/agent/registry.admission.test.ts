import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-admission-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { AgentRegistry } = await import("./registry");
const { SpawnAdmissionError } = await import("./spawnAdmission");
const { saveSpawnNestingPolicy } = await import("./nestingPolicy");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function registryAt(name: string): { store: InstanceType<typeof AgentRegistry>; filename: string } {
  const filename = path.join(sandbox, `${name}.json`);
  return { store: new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" }), filename };
}

function settleLaunch(
  store: InstanceType<typeof AgentRegistry>,
  launchId: string,
  sessionId = crypto.randomUUID(),
): ViewerConversationId {
  const settled = store.settleSpawn(launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: `/sessions/${sessionId}.jsonl`,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error(`settlement conflict: ${settled.code}`);
  return settled.conversation.id;
}

function spawnAtDepth(
  store: InstanceType<typeof AgentRegistry>,
  origin: Parameters<InstanceType<typeof AgentRegistry>["beginSpawnRequest"]>[0]["origin"],
  role: string | null = null,
): { launchId: string; conversationId: ViewerConversationId } {
  const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", origin, role });
  if (begun.kind !== "created") throw new Error("expected create");
  return { launchId: begun.receipt.launchId, conversationId: settleLaunch(store, begun.receipt.launchId) };
}

test("fresh spawn admission normalizes generic placeholder titles", () => {
  const { store } = registryAt("placeholder-title");
  const placeholder = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Codex session" }),
  });
  if (placeholder.kind !== "created") throw new Error("expected create");
  expect(placeholder.receipt.launchProfile.title).toBeNull();

  const semantic = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Review issue #913" }),
  });
  if (semantic.kind !== "created") throw new Error("expected create");
  expect(semantic.receipt.launchProfile.title).toBe("Review issue #913");
});

test("observations and resume successors preserve semantic title punctuation", () => {
  const { store } = registryAt("semantic-title-punctuation");
  const first = store.reconcileConversations([{
    engine: "codex",
    path: "/sessions/semantic-title.jsonl",
    accountId: "terra",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Own issue #913" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-08-06T00:00:00.000Z",
  }]);
  const conversation = Object.values(first.conversations)[0]!;
  expect(conversation.generations.at(-1)?.launchProfile.title).toBe("Own issue #913");

  const resumed = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    conversationId: conversation.id,
    purpose: "resume-successor",
    origin: { kind: "successor" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  });
  if (resumed.kind !== "created") throw new Error("expected create");
  expect(resumed.receipt.launchProfile.title).toBe("Own issue #913");

  const refreshed = store.reconcileConversations([{
    engine: "codex",
    path: "/sessions/semantic-title.jsonl",
    accountId: "terra",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Scanner issue #999" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-08-06T00:01:00.000Z",
  }]);
  expect(refreshed.conversations[conversation.id]?.generations.at(-1)?.launchProfile.title).toBe("Own issue #913");
});

test("a delegated conversation never acquires a Codex plugin grant (#687)", () => {
  const { store } = registryAt("plugin-grant-delegation");
  const parent = store.ensureConversation("codex", "/sessions/plugin-grant-parent.jsonl", "terra");
  /* A stored profile that claims the grant is overridden for every delegated
     launch shape: a role preset, and a lineage parent. */
  const claimed = { plugins: ["computer-use"] };
  const roleLaunch = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role: "builder",
    origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", ...claimed }),
  });
  if (roleLaunch.kind !== "created") throw new Error("expected create");
  const roleConversation = settleLaunch(store, roleLaunch.receipt.launchId);
  const resumed = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    conversationId: roleConversation,
    purpose: "resume-successor",
    origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", ...claimed }),
  });
  if (resumed.kind !== "created") throw new Error("expected create");
  expect(resumed.receipt.launchProfile.plugins).toEqual([]);

  const childLaunch = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: parent.id,
    origin: { kind: "agent", conversationId: parent.id },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", ...claimed }),
  });
  if (childLaunch.kind !== "created") throw new Error("expected create");
  expect(childLaunch.receipt.launchProfile.plugins).toEqual([]);

  /* The operator's own root session keeps the grant its spawn decided. */
  const rootLaunch = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", ...claimed }),
  });
  if (rootLaunch.kind !== "created") throw new Error("expected create");
  expect(rootLaunch.receipt.launchProfile.plugins).toEqual(["computer-use"]);
});

test("a reviewer-origin launch is terminally rejected with a durable typed receipt and zero child artifacts", () => {
  const { store } = registryAt("reviewer-origin");
  const implementer = store.ensureConversation("codex", "/sessions/reviewed-implementer.jsonl", "terra");
  const reviewerBegun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role: "reviewer",
    reviewsConversationId: implementer.id,
    parentConversationId: implementer.id,
    origin: { kind: "operator" },
  });
  if (reviewerBegun.kind !== "created") throw new Error("expected create");
  expect(reviewerBegun.receipt.agentRole).toBe("reviewer");
  expect(reviewerBegun.receipt.delegationDepth).toBe(0);
  const reviewerId = settleLaunch(store, reviewerBegun.receipt.launchId);
  expect(store.conversation(reviewerId)).toMatchObject({ agentRole: "reviewer", delegationDepth: 0 });

  const attempt = () => store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: reviewerId,
    role: "builder",
    origin: { kind: "agent", conversationId: reviewerId },
    clientAttemptId: "reviewer-child-attempt-1",
    requestDigest: "digest-1",
    memberships: [],
  });
  expect(attempt).toThrow(SpawnAdmissionError);

  let rejectionError: InstanceType<typeof SpawnAdmissionError> | null = null;
  try {
    attempt();
  } catch (error) {
    rejectionError = error as InstanceType<typeof SpawnAdmissionError>;
  }
  const receipt = rejectionError!.receipt;
  expect(receipt.state).toBe("failed");
  expect(receipt.completionMode).toBeNull();
  expect(receipt.rejection).toMatchObject({
    code: "reviewer_origin_spawn",
    origin: { kind: "agent", conversationId: reviewerId, role: "reviewer", depth: 0 },
    requestedRole: "builder",
    childDepth: 1,
    maxDepth: 2,
  });
  expect(receipt.error).toBe(receipt.rejection!.guidance);

  const snapshot = store.snapshot();
  const durable = snapshot.receipts[receipt.launchId]!;
  expect(durable.state).toBe("failed");
  expect(durable.rejection?.code).toBe("reviewer_origin_spawn");
  expect(snapshot.conversations[receipt.conversationId]).toBeUndefined();
  expect(snapshot.lineageEdges[receipt.conversationId]).toBeUndefined();
  expect(snapshot.memberships[receipt.conversationId]).toBeUndefined();

  /* Replay of the same clientAttemptId is idempotent: the identical rejected
     receipt comes back, no second receipt appears. */
  const receiptsBefore = Object.keys(snapshot.receipts).length;
  let replayed: InstanceType<typeof SpawnAdmissionError> | null = null;
  try {
    attempt();
  } catch (error) {
    replayed = error as InstanceType<typeof SpawnAdmissionError>;
  }
  expect(replayed!.receipt.launchId).toBe(receipt.launchId);
  expect(Object.keys(store.snapshot().receipts).length).toBe(receiptsBefore);
});

test("delegation depth records at birth and the ceiling rejects the child that would exceed it", () => {
  const { store } = registryAt("depth-chain");
  const root = spawnAtDepth(store, { kind: "operator" });
  expect(store.conversation(root.conversationId)).toMatchObject({ delegationDepth: 0 });

  const first = spawnAtDepth(store, { kind: "agent", conversationId: root.conversationId });
  expect(store.conversation(first.conversationId)).toMatchObject({ delegationDepth: 1 });

  const second = spawnAtDepth(store, { kind: "agent", conversationId: first.conversationId });
  expect(store.conversation(second.conversationId)).toMatchObject({ delegationDepth: 2 });

  let rejection: InstanceType<typeof SpawnAdmissionError> | null = null;
  try {
    store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      origin: { kind: "agent", conversationId: second.conversationId },
    });
  } catch (error) {
    rejection = error as InstanceType<typeof SpawnAdmissionError>;
  }
  expect(rejection!.rejection).toMatchObject({
    code: "nesting_depth_exceeded",
    childDepth: 3,
    maxDepth: 2,
    origin: { kind: "agent", conversationId: second.conversationId, depth: 2 },
  });
  expect(store.snapshot().conversations[rejection!.receipt.conversationId]).toBeUndefined();
});

test("the durable nesting policy governs the ceiling", () => {
  const { store } = registryAt("policy-ceiling");
  saveSpawnNestingPolicy({ maxAgentNestingDepth: 1 });
  try {
    const root = spawnAtDepth(store, { kind: "operator" });
    const first = spawnAtDepth(store, { kind: "agent", conversationId: root.conversationId });
    expect(() => store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      origin: { kind: "agent", conversationId: first.conversationId },
    })).toThrow("capped at depth 1");
  } finally {
    fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "spawn-nesting.json"), { force: true });
  }
});

test("container origin keys on the creator, not the lineage parent, and records membership before launch", () => {
  const { store } = registryAt("container-origin");
  const implementer = store.ensureConversation("codex", "/sessions/pipeline-implementer.jsonl", "terra");
  const reviewerBegun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role: "reviewer",
    reviewsConversationId: implementer.id,
    parentConversationId: implementer.id,
    origin: { kind: "operator" },
  });
  if (reviewerBegun.kind !== "created") throw new Error("expected create");
  const reviewerId = settleLaunch(store, reviewerBegun.receipt.launchId);

  /* A stage whose lineage parent is the passed review stage stays admissible
     (I7): the initiating origin is the pipeline creator. */
  const stage = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: reviewerId,
    role: "builder",
    origin: { kind: "container", container: "pipeline", containerId: "pipe1234", creatorConversationId: null },
    memberships: [{
      kind: "pipeline",
      containerId: "pipe1234",
      role: "builder",
      slot: "build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: reviewerId,
    }],
  });
  if (stage.kind !== "created") throw new Error("expected create");
  expect(stage.receipt.delegationDepth).toBe(1);
  expect(stage.receipt.agentRole).toBe("builder");
  const snapshot = store.snapshot();
  expect(snapshot.memberships[stage.receipt.conversationId]).toMatchObject([{ containerId: "pipe1234", role: "builder" }]);
  expect(snapshot.lineageEdges[stage.receipt.conversationId]).toMatchObject({ parentConversationId: reviewerId, role: "builder" });

  /* A container reviewer stage records its role without a reviews target. */
  const reviewStage = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: stage.receipt.conversationId,
    role: "reviewer",
    origin: { kind: "container", container: "pipeline", containerId: "pipe1234", creatorConversationId: null },
  });
  if (reviewStage.kind !== "created") throw new Error("expected create");
  expect(reviewStage.receipt.agentRole).toBe("reviewer");
  expect(store.snapshot().lineageEdges[reviewStage.receipt.conversationId]).toMatchObject({ kind: "review", role: "reviewer" });

  /* A reviewer-created container is a reviewer-origin launch. */
  expect(() => store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    origin: { kind: "container", container: "pipeline", containerId: "pipe9999", creatorConversationId: reviewerId },
  })).toThrow(SpawnAdmissionError);
});

test("successor purposes are exempt, carry recorded identity, and force reviewer profiles to deny subagents", () => {
  const { store } = registryAt("successor-carry");
  const implementer = store.ensureConversation("codex", "/sessions/successor-implementer.jsonl", "terra");
  const reviewerBegun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role: "reviewer",
    reviewsConversationId: implementer.id,
    parentConversationId: implementer.id,
    origin: { kind: "operator" },
  });
  if (reviewerBegun.kind !== "created") throw new Error("expected create");
  const reviewerId = settleLaunch(store, reviewerBegun.receipt.launchId);

  const resume = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    conversationId: reviewerId,
    purpose: "resume-successor",
    origin: { kind: "successor" },
    launchProfile: { allowSubagents: true },
  });
  if (resume.kind !== "created") throw new Error("expected create");
  expect(resume.receipt.agentRole).toBe("reviewer");
  expect(resume.receipt.delegationDepth).toBe(0);
  expect(resume.receipt.rejection).toBeNull();
  expect(resume.receipt.launchProfile.allowSubagents).toBe(false);
  expect(store.conversation(reviewerId)).toMatchObject({ agentRole: "reviewer", delegationDepth: 0 });

  /* Account-switch successors conserve the same identity without admission. */
  const migration = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    conversationId: reviewerId,
    purpose: "migration-successor",
    origin: { kind: "successor" },
  });
  if (migration.kind !== "created") throw new Error("expected create");
  expect(migration.receipt).toMatchObject({ agentRole: "reviewer", delegationDepth: 0, rejection: null });
});

test("legacy registry files load with null role and depth and legacy receipts stay unrejected", () => {
  const { store, filename } = registryAt("legacy-normalize");
  const { conversationId } = spawnAtDepth(store, { kind: "operator" }, "builder");
  const raw = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
  for (const receipt of Object.values(raw.receipts as Record<string, Record<string, unknown>>)) {
    delete receipt.agentRole;
    delete receipt.delegationDepth;
    delete receipt.rejection;
  }
  for (const conversation of Object.values(raw.conversations as Record<string, Record<string, unknown>>)) {
    delete conversation.agentRole;
    delete conversation.delegationDepth;
  }
  fs.writeFileSync(filename, JSON.stringify(raw));
  const reloaded = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  const conversation = reloaded.conversation(conversationId);
  expect(conversation).toMatchObject({ agentRole: null, delegationDepth: null });
  for (const receipt of Object.values(reloaded.snapshot().receipts)) {
    expect(receipt.agentRole).toBeNull();
    expect(receipt.delegationDepth).toBeNull();
    expect(receipt.rejection).toBeNull();
  }
});
