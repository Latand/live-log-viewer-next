import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { AgentRegistry, normalizeRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

const LLV_PROJECT = "-agents-tools-live-log-viewer-next";

function registry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-ownership-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"));
}

function spawnEntry(pathname: string, sessionId: string, cwd = "/home/latand") {
  return {
    key: { engine: "codex" as const, sessionId },
    artifactPath: pathname,
    cwd,
    accountId: "terra",
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  };
}

describe("durable project ownership", () => {
  test("an explicit operator spawn admits durable conversation ownership", () => {
    const store = registry();
    const cwd = "/home/latand";
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      accountId: "terra",
      explicitProject: LLV_PROJECT,
      launchProfile: emptyLaunchProfile({ cwd }),
    });
    if (begun.kind !== "created") throw new Error("expected a fresh receipt");
    expect(begun.receipt.explicitProject).toBe(LLV_PROJECT);
    expect(begun.receipt.launchProfile.project).toBe(LLV_PROJECT);

    const settled = store.settleSpawn(
      begun.receipt.launchId,
      spawnEntry("/transcripts/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl", "019f4906-3f67-7b72-9fbc-9ec3b5ad1326", cwd),
    );
    if (settled.kind !== "settled") throw new Error("expected settlement");
    expect(settled.conversation.projectOwnership).toMatchObject({
      project: LLV_PROJECT,
      source: "operator",
      operationId: begun.receipt.launchId,
    });
    /* Conversation identity, generation identity, and the transcript path are
       exactly what the settlement recorded — ownership is metadata only. */
    expect(settled.conversation.id).toBe(begun.receipt.conversationId);
    expect(settled.conversation.generations.at(-1)?.path)
      .toBe("/transcripts/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl");
  });

  test("an ambiguous explicit project is rejected before any receipt exists", () => {
    const store = registry();
    expect(() => store.beginSpawnRequest({
      engine: "codex",
      cwd: "/home/latand",
      explicitProject: "not a/project",
    })).toThrow("explicit project is not a valid project key");
    expect(Object.keys(store.snapshot().receipts)).toHaveLength(0);
  });

  test("a replayed attempt must repeat the same explicit project", () => {
    const store = registry();
    const cwd = "/home/latand";
    const first = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      clientAttemptId: "attempt_ownership_replay_01",
      requestDigest: "a".repeat(64),
      explicitProject: LLV_PROJECT,
    });
    expect(first.kind).toBe("created");
    const replay = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      clientAttemptId: "attempt_ownership_replay_01",
      requestDigest: "a".repeat(64),
      explicitProject: LLV_PROJECT,
    });
    expect(replay.kind).toBe("replay");
    const conflicting = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      clientAttemptId: "attempt_ownership_replay_01",
      requestDigest: "a".repeat(64),
      explicitProject: "latand",
    });
    expect(conflicting.kind).toBe("conflict");
  });

  test("ownership survives a resume successor and is never demoted by later receipts", () => {
    const store = registry();
    const cwd = "/home/latand";
    const sourcePath = "/transcripts/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      explicitProject: LLV_PROJECT,
    });
    if (begun.kind !== "created") throw new Error("expected a fresh receipt");
    store.settleSpawn(begun.receipt.launchId, spawnEntry(sourcePath, "019f4906-3f67-7b72-9fbc-9ec3b5ad1326", cwd));

    const resume = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      conversationId: begun.receipt.conversationId,
      purpose: "resume-successor",
      launchProfile: emptyLaunchProfile({ cwd }),
    });
    if (resume.kind !== "created") throw new Error("expected a resume receipt");
    const successorPath = "/transcripts/019f4906-4f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const settled = store.settleSpawn(
      resume.receipt.launchId,
      spawnEntry(successorPath, "019f4906-4f67-7b72-9fbc-9ec3b5ad1327", cwd),
    );
    if (settled.kind !== "settled") throw new Error("expected resume settlement");
    expect(settled.conversation.id).toBe(begun.receipt.conversationId);
    expect(settled.conversation.projectOwnership).toMatchObject({
      project: LLV_PROJECT,
      source: "operator",
      operationId: begun.receipt.launchId,
    });

    /* A later explicit receipt for the SAME conversation cannot rewrite the
       durable record — relocation is the only sanctioned mutation path. */
    const second = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      conversationId: begun.receipt.conversationId,
      purpose: "resume-successor",
      explicitProject: "latand",
    });
    if (second.kind !== "created") throw new Error("expected a second resume receipt");
    const resettled = store.settleSpawn(
      second.receipt.launchId,
      spawnEntry("/transcripts/019f4906-5f67-7b72-9fbc-9ec3b5ad1328.jsonl", "019f4906-5f67-7b72-9fbc-9ec3b5ad1328", cwd),
    );
    if (resettled.kind !== "settled") throw new Error("expected second settlement");
    expect(resettled.conversation.projectOwnership?.project).toBe(LLV_PROJECT);
    expect(resettled.conversation.projectOwnership?.operationId).toBe(begun.receipt.launchId);
  });

  test("a conflicted resume-successor settlement leaves an unowned conversation unowned", () => {
    const store = registry();
    const cwd = "/home/latand";
    /* Conversation A: settled without operator intent — durably unowned. */
    const begunA = store.beginSpawnRequest({ engine: "codex", cwd });
    if (begunA.kind !== "created") throw new Error("expected a fresh receipt");
    store.settleSpawn(
      begunA.receipt.launchId,
      spawnEntry("/transcripts/019f4906-6f67-7b72-9fbc-9ec3b5ad1329.jsonl", "019f4906-6f67-7b72-9fbc-9ec3b5ad1329", cwd),
    );

    /* Conversation B: two generations, so it can never be adopted as a
       scanner-allocated provisional owner of its successor path. */
    const begunB = store.beginSpawnRequest({ engine: "codex", cwd });
    if (begunB.kind !== "created") throw new Error("expected a fresh receipt");
    store.settleSpawn(
      begunB.receipt.launchId,
      spawnEntry("/transcripts/019f4906-7f67-7b72-9fbc-9ec3b5ad1330.jsonl", "019f4906-7f67-7b72-9fbc-9ec3b5ad1330", cwd),
    );
    const resumeB = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      conversationId: begunB.receipt.conversationId,
      purpose: "resume-successor",
    });
    if (resumeB.kind !== "created") throw new Error("expected a resume receipt");
    const contestedPath = "/transcripts/019f4906-8f67-7b72-9fbc-9ec3b5ad1331.jsonl";
    const settledB = store.settleSpawn(
      resumeB.receipt.launchId,
      spawnEntry(contestedPath, "019f4906-8f67-7b72-9fbc-9ec3b5ad1331", cwd),
    );
    if (settledB.kind !== "settled") throw new Error("expected B's resume settlement");

    /* A resume-successor for A carrying explicit operator intent collides with
       B's owned path. The settlement conflicts — and the conflict must not
       persist ownership onto A. */
    const resumeA = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      conversationId: begunA.receipt.conversationId,
      purpose: "resume-successor",
      explicitProject: LLV_PROJECT,
    });
    if (resumeA.kind !== "created") throw new Error("expected a resume receipt");
    const conflicted = store.settleSpawn(
      resumeA.receipt.launchId,
      spawnEntry(contestedPath, "019f4906-9f67-7b72-9fbc-9ec3b5ad1332", cwd),
    );
    expect(conflicted.kind).toBe("conflict");
    if (conflicted.kind !== "conflict") throw new Error("expected a conflicted settlement");
    expect(conflicted.code).toBe("spawn_artifact_conflict");

    const snapshot = store.snapshot();
    expect(snapshot.conversations[begunA.receipt.conversationId]?.projectOwnership).toBeNull();
    expect(snapshot.conversations[begunB.receipt.conversationId]?.projectOwnership).toBeNull();
  });

  test("a launch settlement that loses a provisional-owner conflict admits no ownership", () => {
    const store = registry();
    const cwd = "/home/latand";
    /* Conversation A exists unowned; conversation B durably owns the contested
       path across two generations. */
    const begunA = store.beginSpawnRequest({ engine: "codex", cwd });
    if (begunA.kind !== "created") throw new Error("expected a fresh receipt");
    store.settleSpawn(
      begunA.receipt.launchId,
      spawnEntry("/transcripts/019f4907-0f67-7b72-9fbc-9ec3b5ad1333.jsonl", "019f4907-0f67-7b72-9fbc-9ec3b5ad1333", cwd),
    );
    const begunB = store.beginSpawnRequest({ engine: "codex", cwd });
    if (begunB.kind !== "created") throw new Error("expected a fresh receipt");
    store.settleSpawn(
      begunB.receipt.launchId,
      spawnEntry("/transcripts/019f4907-1f67-7b72-9fbc-9ec3b5ad1334.jsonl", "019f4907-1f67-7b72-9fbc-9ec3b5ad1334", cwd),
    );
    const resumeB = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      conversationId: begunB.receipt.conversationId,
      purpose: "resume-successor",
    });
    if (resumeB.kind !== "created") throw new Error("expected a resume receipt");
    const contestedPath = "/transcripts/019f4907-2f67-7b72-9fbc-9ec3b5ad1335.jsonl";
    const settledB = store.settleSpawn(
      resumeB.receipt.launchId,
      spawnEntry(contestedPath, "019f4907-2f67-7b72-9fbc-9ec3b5ad1335", cwd),
    );
    if (settledB.kind !== "settled") throw new Error("expected B's resume settlement");

    const launchA = store.beginSpawnRequest({
      engine: "codex",
      cwd,
      conversationId: begunA.receipt.conversationId,
      explicitProject: LLV_PROJECT,
    });
    if (launchA.kind !== "created") throw new Error("expected a launch receipt");
    const conflicted = store.settleSpawn(
      launchA.receipt.launchId,
      spawnEntry(contestedPath, "019f4907-3f67-7b72-9fbc-9ec3b5ad1336", cwd),
    );
    expect(conflicted.kind).toBe("conflict");
    if (conflicted.kind !== "conflict") throw new Error("expected a conflicted settlement");
    expect(conflicted.code).toBe("spawn_artifact_conflict");

    const snapshot = store.snapshot();
    expect(snapshot.conversations[begunA.receipt.conversationId]?.projectOwnership).toBeNull();
    for (const conversation of Object.values(snapshot.conversations)) {
      expect(conversation.projectOwnership).toBeNull();
    }
  });

  test("legacy sessions without ownership stay cwd-attributed", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/transcripts/legacy.jsonl", "terra");
    expect(conversation.projectOwnership).toBeNull();
  });

  test("legacy registry files normalize missing and malformed ownership to null", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/home/latand", explicitProject: LLV_PROJECT });
    if (begun.kind !== "created") throw new Error("expected a fresh receipt");
    store.settleSpawn(
      begun.receipt.launchId,
      spawnEntry("/transcripts/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl", "019f4906-3f67-7b72-9fbc-9ec3b5ad1326"),
    );
    const persisted = JSON.parse(fs.readFileSync(store.filename, "utf8")) as {
      conversations: Record<string, Record<string, unknown>>;
      receipts: Record<string, Record<string, unknown>>;
    };
    const conversation = Object.values(persisted.conversations)[0]!;
    expect(conversation.projectOwnership).toMatchObject({ project: LLV_PROJECT, source: "operator" });

    /* A registry written before #315 has neither field. */
    delete conversation.projectOwnership;
    for (const receipt of Object.values(persisted.receipts)) delete receipt.explicitProject;
    const legacy = normalizeRegistry(persisted);
    expect(Object.values(legacy.conversations)[0]!.projectOwnership).toBeNull();
    expect(Object.values(legacy.receipts)[0]!.explicitProject).toBeNull();

    /* Malformed durable rows fail closed instead of poisoning projections. */
    conversation.projectOwnership = { project: "bad project", source: "operator" };
    expect(Object.values(normalizeRegistry(persisted).conversations)[0]!.projectOwnership).toBeNull();
  });
});
