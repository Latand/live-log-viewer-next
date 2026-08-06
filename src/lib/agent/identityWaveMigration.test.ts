import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  orchestratorSeatFor,
} from "@/lib/orchestrator/seats";
import { readOrchestratorRecord, replaceOrchestratorIncumbent } from "@/lib/orchestrator/store";

import { AgentRegistry } from "./registry";
import { IDENTITY_WAVE_MIGRATION } from "./identityWaveMigration";
import { sessionKeyFromTranscript } from "./sessionKey";
import {
  runIdentityWaveMigrationAtStartup,
  sharedPathForLegacyClaudeTranscript,
  titleFromTranscriptHead,
} from "./identityWaveStartup";

const NOW = "2026-08-05T12:00:00.000Z";

test("the identity wave retitles, rekeys, stamps roots, supports dry-run, and completes once", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const legacyRoot = path.join(directory, "legacy-projects");
    const sharedRoot = path.join(directory, "shared-projects");
    const receiptFilename = `${crypto.randomUUID()}.jsonl`;
    const transcriptFilename = `${crypto.randomUUID()}.jsonl`;
    const receiptLegacyPath = path.join(legacyRoot, "-repo", receiptFilename);
    const receiptSharedPath = path.join(sharedRoot, "-repo", receiptFilename);
    const olderReceiptFilename = `${crypto.randomUUID()}.jsonl`;
    const olderReceiptLegacyPath = path.join(legacyRoot, "-repo", olderReceiptFilename);
    const olderReceiptSharedPath = path.join(sharedRoot, "-repo", olderReceiptFilename);
    const transcriptLegacyPath = path.join(legacyRoot, "-repo", transcriptFilename);
    const transcriptSharedPath = path.join(sharedRoot, "-repo", transcriptFilename);
    const noEvidencePath = path.join(directory, "no-evidence.jsonl");
    const orchestratorPath = path.join(directory, "orchestrator.jsonl");
    const successorPath = path.join(directory, "orchestrator-successor.jsonl");
    for (const pathname of [receiptSharedPath, olderReceiptSharedPath, transcriptSharedPath, orchestratorPath, successorPath]) {
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
    }
    fs.writeFileSync(receiptSharedPath, `${JSON.stringify({ type: "ai-title", aiTitle: "Lower-priority transcript title" })}\n`);
    fs.writeFileSync(olderReceiptSharedPath, "{}\n");
    fs.writeFileSync(transcriptSharedPath, `${JSON.stringify({ type: "ai-title", aiTitle: "Transcript head title" })}\n`);
    fs.writeFileSync(orchestratorPath, "{}\n");
    fs.writeFileSync(successorPath, "{}\n");

    const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const receiptConversation = seed.ensureConversation("claude", receiptLegacyPath, null);
    const transcriptConversation = seed.ensureConversation("claude", transcriptLegacyPath, null);
    const noEvidenceConversation = seed.ensureConversation("codex", noEvidencePath, null);
    const orchestratorConversation = seed.ensureConversation("codex", orchestratorPath, null);
    const successorConversation = seed.ensureConversation("codex", successorPath, null);
    const reserved = seed.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      conversationId: receiptConversation.id,
      purpose: "resume-successor",
      expectedArtifactPath: receiptLegacyPath,
      launchProfile: { title: "Seed receipt backfill evidence" },
      launchDisplay: {
        ["prompt"]: "Implement receipt backfill\nAcceptance evidence follows",
        echo: "Implement receipt backfill\nAcceptance evidence follows",
        images: 0,
      },
    });
    if (reserved.kind !== "created") throw new Error("expected identity-wave receipt reservation");
    const receiptKey = sessionKeyFromTranscript("claude", receiptLegacyPath);
    if (!receiptKey) throw new Error("expected a receipt transcript key");
    seed.upsert({
      key: receiptKey,
      artifactPath: receiptLegacyPath,
      cwd: directory,
      accountId: null,
      status: "dead",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    const legacy = seed.snapshot();
    legacy.receipts[reserved.receipt.launchId]!.launchProfile.title = "Claude session";
    const receiptGeneration = legacy.conversations[receiptConversation.id]!.generations.at(-1)!;
    legacy.conversations[receiptConversation.id]!.generations.unshift({
      ...structuredClone(receiptGeneration),
      id: crypto.randomUUID(),
      path: olderReceiptLegacyPath,
      createdAt: "2026-08-04T12:00:00.000Z",
      archivedAt: NOW,
    });
    for (const conversationId of [receiptConversation.id, transcriptConversation.id, noEvidenceConversation.id]) {
      legacy.conversations[conversationId]!.generations.at(-1)!.launchProfile.title = conversationId === noEvidenceConversation.id
        ? "Codex session"
        : "Claude session";
    }
    legacy.conversations[orchestratorConversation.id]!.generations.at(-1)!.launchProfile.title = "Own identity migrations";
    legacy.conversations[successorConversation.id]!.generations.at(-1)!.launchProfile.title = "Continue identity migrations";
    legacy.conversations[orchestratorConversation.id]!.agentRole = "reviewer";
    legacy.conversations[orchestratorConversation.id]!.delegationDepth = 3;
    legacy.conversations[successorConversation.id]!.agentRole = "worker";
    legacy.conversations[successorConversation.id]!.delegationDepth = 2;
    legacy.lineageEdges[transcriptConversation.id] = {
      childConversationId: transcriptConversation.id,
      parentConversationId: receiptConversation.id,
      childSessionKey: null,
      parentSessionKey: null,
      childArtifactPath: transcriptLegacyPath,
      parentArtifactPath: receiptLegacyPath,
      kind: "spawn",
      role: "worker",
      reviewsConversationId: null,
      source: "viewer-spawn",
      evidence: { launchId: null, clientAttemptId: null, parentSource: null },
      createdAt: NOW,
    };
    const providerHost = { kind: "claude-stream" as const, identity: "migration-host", epoch: 1, verifiedAt: NOW };
    legacy.conversations[receiptConversation.id]!.migration = {
      intentId: "intent_identity_wave",
      phase: "verifying",
      targetId: "account-b",
      revision: 1,
      error: null,
      errorCode: null,
      operationId: "operation_identity_wave",
      sourceGenerationId: receiptGeneration.id,
      providerReceipt: {
        operationId: "operation_identity_wave",
        nativeId: "successor_identity_wave",
        path: olderReceiptLegacyPath,
        continuityPaths: [receiptLegacyPath],
        historyHash: "history",
        host: providerHost,
      },
      pendingContinuityPaths: [olderReceiptLegacyPath],
      boardProject: null,
      boardOperationId: null,
      boardPlacementProject: null,
      updatedAt: NOW,
    };
    legacy.pendingSuccessorCleanups.operation_cleanup = {
      conversationId: transcriptConversation.id,
      receipt: {
        operationId: "operation_cleanup",
        nativeId: "cleanup_identity_wave",
        path: transcriptLegacyPath,
        continuityPaths: [transcriptLegacyPath],
        historyHash: "history",
        host: providerHost,
      },
      createdAt: NOW,
      lastError: null,
    };
    legacy.receipts[reserved.receipt.launchId]!.launchProfile.title = "Claude session";
    legacy.legacyResumePanes.panes[receiptLegacyPath] = { paneId: "%1", windowName: "identity-wave" };
    fs.writeFileSync(filename, `${JSON.stringify(legacy, null, 2)}\n`);

    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const input = {
      now: NOW,
      transcriptTitle: titleFromTranscriptHead,
      sharedPathForLegacy: (pathname: string) => sharedPathForLegacyClaudeTranscript(pathname, legacyRoot, sharedRoot),
      orchestratorSeats: [
        {
          project: "viewer",
          seatEpoch: 7,
          conversationId: orchestratorConversation.id,
          predecessorConversationId: null,
          designatedAt: NOW,
          activatedAt: NOW,
        },
        {
          project: "viewer-successor",
          seatEpoch: 8,
          conversationId: successorConversation.id,
          predecessorConversationId: orchestratorConversation.id,
          designatedAt: NOW,
          activatedAt: NOW,
        },
      ],
    };
    const beforeDryRun = fs.readFileSync(filename, "utf8");

    expect(registry.runIdentityWaveMigration({ ...input, dryRun: true })).toEqual({
      dryRun: true,
      alreadyCompleted: false,
      retitled: 2,
      rekeyed: 2,
      edgesStamped: 2,
    });
    expect(fs.readFileSync(filename, "utf8")).toBe(beforeDryRun);

    expect(registry.runIdentityWaveMigration(input)).toEqual({
      dryRun: false,
      alreadyCompleted: false,
      retitled: 2,
      rekeyed: 2,
      edgesStamped: 2,
    });
    const migrated = registry.snapshot();
    expect(migrated.conversations[receiptConversation.id]!.generations.at(-1)).toMatchObject({
      path: receiptSharedPath,
      launchProfile: expect.objectContaining({ title: "Implement receipt backfill" }),
    });
    expect(migrated.conversations[receiptConversation.id]!.continuityPaths).toContain(receiptLegacyPath);
    expect(migrated.conversations[receiptConversation.id]!.generations.map((generation) => generation.path)).toEqual([
      olderReceiptSharedPath,
      receiptSharedPath,
    ]);
    expect(migrated.conversations[receiptConversation.id]!.continuityPaths).toContain(olderReceiptLegacyPath);
    expect(migrated.receipts[reserved.receipt.launchId]).toMatchObject({
      artifactPath: receiptSharedPath,
      resumeSourcePath: receiptSharedPath,
      identityWaveTitleBackfill: true,
      launchProfile: expect.objectContaining({ title: "Implement receipt backfill" }),
    });
    expect(migrated.conversations[receiptConversation.id]!.migration).toMatchObject({
      providerReceipt: { path: olderReceiptSharedPath, continuityPaths: [receiptSharedPath] },
      pendingContinuityPaths: [olderReceiptSharedPath],
    });
    expect(migrated.pendingSuccessorCleanups.operation_cleanup.receipt).toMatchObject({
      path: transcriptSharedPath,
      continuityPaths: [transcriptSharedPath],
    });
    expect(Object.values(migrated.entries)).toContainEqual(expect.objectContaining({ artifactPath: receiptSharedPath }));
    expect(migrated.conversations[transcriptConversation.id]!.generations.at(-1)).toMatchObject({
      path: transcriptSharedPath,
      launchProfile: expect.objectContaining({ title: "Transcript head title" }),
    });
    expect(migrated.conversations[transcriptConversation.id]!.continuityPaths).toContain(transcriptLegacyPath);
    expect(migrated.lineageEdges[transcriptConversation.id]).toMatchObject({
      childArtifactPath: transcriptSharedPath,
      parentArtifactPath: receiptSharedPath,
    });
    expect(migrated.legacyResumePanes.panes[receiptLegacyPath]).toBeUndefined();
    expect(migrated.legacyResumePanes.panes[receiptSharedPath]).toEqual({ paneId: "%1", windowName: "identity-wave" });
    expect(migrated.conversations[noEvidenceConversation.id]!.generations.at(-1)!.launchProfile.title).toBeNull();
    expect(migrated.conversations[orchestratorConversation.id]).toMatchObject({
      agentRole: "orchestrator",
      delegationDepth: 0,
    });
    expect(migrated.conversations[successorConversation.id]).toMatchObject({
      agentRole: "orchestrator",
      delegationDepth: 0,
    });
    expect(migrated.memberships[orchestratorConversation.id]).toContainEqual(expect.objectContaining({
      kind: "orchestrator",
      containerId: "viewer",
      role: "orchestrator",
      slot: "seat:7",
    }));
    expect(migrated.lineageEdges[successorConversation.id]).toMatchObject({
      childConversationId: successorConversation.id,
      parentConversationId: orchestratorConversation.id,
      role: "orchestrator",
      source: "viewer-spawn",
    });
    expect(migrated.identityMigrations[IDENTITY_WAVE_MIGRATION]).toEqual({
      completedAt: NOW,
      retitled: 2,
      rekeyed: 2,
      edgesStamped: 2,
    });

    expect(registry.runIdentityWaveMigration(input)).toEqual({
      dryRun: false,
      alreadyCompleted: true,
      retitled: 0,
      rekeyed: 0,
      edgesStamped: 0,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("identity evidence cleans receipt and transcript Markdown before durable persistence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-punctuation-"));
  try {
    const headPath = path.join(directory, "head.jsonl");
    fs.writeFileSync(headPath, `${JSON.stringify({ type: "ai-title", aiTitle: "Review issue #913\nsecondary detail" })}\n`);
    expect(titleFromTranscriptHead(headPath, "codex")).toBe("Review issue #913");
    const filename = path.join(directory, "agent-registry.json");
    const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const receiptConversation = seed.ensureConversation("codex", path.join(directory, "receipt.jsonl"), null);
    const transcriptConversation = seed.ensureConversation("codex", path.join(directory, "transcript.jsonl"), null);
    const receipt = seed.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      conversationId: receiptConversation.id,
      purpose: "resume-successor",
      launchProfile: { title: "Seed Markdown receipt evidence" },
      launchDisplay: {
        ["prompt"]: "Review [issue #913](https://example.invalid/issues/913)",
        echo: "Review [issue #913](https://example.invalid/issues/913)",
        images: 0,
      },
    });
    if (receipt.kind !== "created") throw new Error("expected receipt");
    const legacy = seed.snapshot();
    legacy.receipts[receipt.receipt.launchId]!.launchProfile.title = "Codex-session";
    legacy.conversations[receiptConversation.id]!.generations.at(-1)!.launchProfile.title = "Claude/session";
    legacy.conversations[transcriptConversation.id]!.generations.at(-1)!.launchProfile.title = "Codex · session";
    fs.writeFileSync(filename, `${JSON.stringify(legacy, null, 2)}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });

    expect(registry.runIdentityWaveMigration({
      now: NOW,
      transcriptTitle: (pathname) => pathname.endsWith("transcript.jsonl")
        ? "Audit *role* [issue #913](https://example.invalid/issues/913)"
        : null,
      sharedPathForLegacy: () => null,
      orchestratorSeats: [],
    })).toMatchObject({ retitled: 2 });
    expect(registry.conversation(receiptConversation.id)?.generations.at(-1)?.launchProfile.title).toBe("Review issue 913");
    expect(registry.conversation(transcriptConversation.id)?.generations.at(-1)?.launchProfile.title).toBe("Audit role issue 913");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the completed wave preserves an accepted orchestrator seat until its conversation settles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-deferred-seat-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      role: "orchestrator",
      launchProfile: { title: "Own the release board" },
    });
    if (begun.kind !== "created") throw new Error("expected receipt");
    const seat = {
      project: "viewer",
      seatEpoch: 7,
      conversationId: begun.receipt.conversationId,
      predecessorConversationId: null,
      designatedAt: NOW,
      activatedAt: NOW,
    };

    expect(registry.runIdentityWaveMigration({
      now: NOW,
      transcriptTitle: () => null,
      sharedPathForLegacy: () => null,
      orchestratorSeats: [seat],
    })).toEqual({
      dryRun: false,
      alreadyCompleted: false,
      retitled: 0,
      rekeyed: 0,
      edgesStamped: 1,
    });
    expect(registry.snapshot().conversations[begun.receipt.conversationId]).toBeUndefined();
    expect(registry.snapshot().receipts[begun.receipt.launchId]?.pendingOrchestratorSeatIdentity).toMatchObject(seat);
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]?.completedAt).toBe(NOW);
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: crypto.randomUUID() },
      artifactPath: path.join(directory, "settled.jsonl"),
      cwd: directory,
      accountId: null,
      launchProfile: begun.receipt.launchProfile,
      status: "live",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(settled.kind).toBe("settled");
    expect(registry.snapshot().memberships[begun.receipt.conversationId]).toContainEqual(expect.objectContaining({
      kind: "orchestrator",
      containerId: "viewer",
      slot: "seat:7",
    }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed sibling seat evidence leaves path rekey and the migration marker open", () => {
  type MutableSeatEvidence = Record<string, unknown> & {
    pending: Record<string, unknown>;
    revocations: unknown[];
    history: unknown[];
  };
  const corruptions = [
    { label: "pending", apply: (file: MutableSeatEvidence) => { file.pending.broken = {}; } },
    { label: "revocation", apply: (file: MutableSeatEvidence) => { file.revocations.push({}); } },
    { label: "history", apply: (file: MutableSeatEvidence) => { file.history.push({}); } },
  ];
  for (const corruption of corruptions) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-identity-wave-${corruption.label}-`));
    const previousStateDir = process.env.LLV_STATE_DIR;
    try {
      process.env.LLV_STATE_DIR = directory;
      const legacyPath = path.join(directory, "legacy.jsonl");
      const sharedPath = path.join(directory, "shared.jsonl");
      const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
      const conversation = registry.ensureConversation("claude", legacyPath, null);
      beginOrchestratorSeatIntent({
        project: "viewer",
        mandate: "own identity migration",
        clientRequestId: `req_${corruption.label}_0001`,
        mode: "existing",
        conversationId: conversation.id,
        now: NOW,
      });
      completeOrchestratorSeatIntent({
        project: "viewer",
        clientRequestId: `req_${corruption.label}_0001`,
        conversationId: conversation.id,
        path: legacyPath,
        now: NOW,
      });
      const seatsPath = path.join(directory, "orchestrator-seats.json");
      const seatFile = JSON.parse(fs.readFileSync(seatsPath, "utf8")) as MutableSeatEvidence;
      corruption.apply(seatFile);
      fs.writeFileSync(seatsPath, `${JSON.stringify(seatFile, null, 2)}\n`, "utf8");
      const corruptedSeatEvidence = fs.readFileSync(seatsPath, "utf8");

      expect(() => runIdentityWaveMigrationAtStartup({
        registry,
        now: () => NOW,
        transcriptTitle: () => null,
        sharedPath: (pathname) => pathname === legacyPath ? sharedPath : null,
        log: () => {},
        env: {},
      })).toThrow("orchestrator seat evidence is malformed");

      expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
      expect(registry.conversation(conversation.id)?.generations.at(-1)?.path).toBe(legacyPath);
      expect(fs.readFileSync(seatsPath, "utf8")).toBe(corruptedSeatEvidence);
    } finally {
      if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previousStateDir;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("orchestrator re-seating cannot create an A to B to A lineage cycle", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-lineage-cycle-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const conversationA = registry.ensureConversation("codex", path.join(directory, "a.jsonl"), null);
    const conversationB = registry.ensureConversation("codex", path.join(directory, "b.jsonl"), null);

    expect(registry.runIdentityWaveMigration({
      now: NOW,
      transcriptTitle: () => null,
      sharedPathForLegacy: () => null,
      orchestratorSeats: [{
        project: "viewer",
        seatEpoch: 1,
        conversationId: conversationA.id,
        predecessorConversationId: null,
        designatedAt: NOW,
        activatedAt: NOW,
      }, {
        project: "viewer",
        seatEpoch: 2,
        conversationId: conversationB.id,
        predecessorConversationId: conversationA.id,
        designatedAt: NOW,
        activatedAt: NOW,
      }, {
        project: "viewer",
        seatEpoch: 3,
        conversationId: conversationA.id,
        predecessorConversationId: conversationB.id,
        designatedAt: NOW,
        activatedAt: NOW,
      }],
    })).toMatchObject({ edgesStamped: 3 });

    const snapshot = registry.snapshot();
    expect(snapshot.lineageEdges[conversationB.id]).toMatchObject({ parentConversationId: conversationA.id });
    expect(snapshot.lineageEdges[conversationA.id]).toBeUndefined();
    expect(snapshot.memberships[conversationA.id]).toContainEqual(expect.objectContaining({
      slot: "seat:3",
      parentConversationId: null,
    }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("resolver failures leave the identity wave unmarked and a retry can complete", () => {
  for (const failingResolver of ["sharedPathForLegacy", "transcriptTitle"] as const) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-retry-"));
    try {
      const filename = path.join(directory, "agent-registry.json");
      const legacyPath = path.join(directory, "legacy", "conversation.jsonl");
      const sharedPath = path.join(directory, "shared", "conversation.jsonl");
      const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
      const conversation = seed.ensureConversation("claude", legacyPath, null);
      const legacy = seed.snapshot();
      legacy.conversations[conversation.id]!.generations.at(-1)!.launchProfile.title = "Claude session";
      fs.writeFileSync(filename, `${JSON.stringify(legacy, null, 2)}\n`);

      const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
      const beforeFailure = fs.readFileSync(filename, "utf8");
      let shouldFail = true;
      const input = {
        now: NOW,
        transcriptTitle: () => {
          if (shouldFail && failingResolver === "transcriptTitle") throw new Error("temporary transcript read failure");
          return "Recovered semantic title";
        },
        sharedPathForLegacy: () => {
          if (shouldFail && failingResolver === "sharedPathForLegacy") throw new Error("temporary shared-path read failure");
          return sharedPath;
        },
        orchestratorSeats: [],
      };

      expect(() => registry.runIdentityWaveMigration(input)).toThrow("temporary");
      const failed = registry.snapshot();
      expect(fs.readFileSync(filename, "utf8")).toBe(beforeFailure);
      expect(failed.identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
      expect(failed.conversations[conversation.id]!.generations.at(-1)).toMatchObject({
        path: legacyPath,
        launchProfile: expect.objectContaining({ title: "Claude session" }),
      });

      shouldFail = false;
      expect(registry.runIdentityWaveMigration(input)).toEqual({
        dryRun: false,
        alreadyCompleted: false,
        retitled: 1,
        rekeyed: 1,
        edgesStamped: 0,
      });
      const retried = registry.snapshot();
      expect(retried.identityMigrations[IDENTITY_WAVE_MIGRATION]?.completedAt).toBe(NOW);
      expect(retried.conversations[conversation.id]!.generations.at(-1)).toMatchObject({
        path: sharedPath,
        launchProfile: expect.objectContaining({ title: "Recovered semantic title" }),
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("an external path-authority write failure leaves the identity wave open for retry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-authority-retry-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const legacyPath = path.join(directory, "legacy.jsonl");
    const sharedPath = path.join(directory, "shared.jsonl");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const conversation = registry.ensureConversation("claude", legacyPath, null);
    let shouldFail = true;
    const input = {
      now: NOW,
      transcriptTitle: () => null,
      sharedPathForLegacy: () => sharedPath,
      orchestratorSeats: [],
      commitExternalPathRekeys: () => {
        if (shouldFail) throw new Error("temporary authority write failure");
      },
    };

    expect(() => registry.runIdentityWaveMigration(input)).toThrow("temporary authority write failure");
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
    expect(registry.conversation(conversation.id)?.generations.at(-1)?.path).toBe(legacyPath);

    shouldFail = false;
    expect(registry.runIdentityWaveMigration(input)).toMatchObject({ alreadyCompleted: false, rekeyed: 1 });
    expect(registry.conversation(conversation.id)?.generations.at(-1)?.path).toBe(sharedPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup retries a partial orchestrator-store rekey before completing the marker", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-store-retry-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  try {
    process.env.LLV_STATE_DIR = directory;
    const filename = path.join(directory, "agent-registry.json");
    const legacyPath = path.join(directory, "legacy.jsonl");
    const sharedPath = path.join(directory, "shared.jsonl");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const conversation = registry.ensureConversation("claude", legacyPath, null);
    beginOrchestratorSeatIntent({
      project: "viewer",
      mandate: "own migrations",
      clientRequestId: "req_00002001",
      mode: "spawn",
      now: NOW,
    });
    completeOrchestratorSeatIntent({
      project: "viewer",
      clientRequestId: "req_00002001",
      conversationId: conversation.id,
      path: legacyPath,
      now: NOW,
    });
    fs.writeFileSync(path.join(directory, "orchestrator.json"), "{", "utf8");
    const overrides = {
      registry,
      now: () => NOW,
      transcriptTitle: () => null,
      sharedPath: (pathname: string) => pathname === legacyPath ? sharedPath : null,
      log: () => {},
      env: {},
    };

    expect(() => runIdentityWaveMigrationAtStartup(overrides)).toThrow("orchestrator record evidence is malformed");
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
    expect(orchestratorSeatFor("viewer").active?.path).toBe(sharedPath);

    replaceOrchestratorIncumbent({
      conversationId: conversation.id,
      path: legacyPath,
      createdAt: NOW,
    });
    expect(runIdentityWaveMigrationAtStartup(overrides)).toMatchObject({ alreadyCompleted: false, rekeyed: 1 });
    expect(readOrchestratorRecord()?.path).toBe(sharedPath);
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]?.completedAt).toBe(NOW);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a concurrent orchestrator rotation cannot be overwritten by the startup wave", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-rotation-race-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  const ready = path.join(directory, "mutation-ready");
  const release = path.join(directory, "mutation-release");
  let holder: ReturnType<typeof Bun.spawn> | null = null;
  try {
    process.env.LLV_STATE_DIR = directory;
    const filename = path.join(directory, "agent-registry.json");
    const legacyPath = path.join(directory, "legacy.jsonl");
    const sharedPath = path.join(directory, "shared.jsonl");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const conversation = registry.ensureConversation("claude", legacyPath, null);
    beginOrchestratorSeatIntent({
      project: "viewer",
      mandate: "own migrations",
      clientRequestId: "req_00003001",
      mode: "spawn",
      now: NOW,
    });
    completeOrchestratorSeatIntent({
      project: "viewer",
      clientRequestId: "req_00003001",
      conversationId: conversation.id,
      path: legacyPath,
      now: NOW,
    });
    replaceOrchestratorIncumbent({ conversationId: conversation.id, path: legacyPath, createdAt: NOW });

    const mutationPath = path.join(import.meta.dir, "../accounts/accountMutation.ts");
    holder = Bun.spawn({
      cmd: [process.execPath, "-e", `
        const fs = await import("node:fs");
        const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
        await withAccountMutationLockAsync(async () => {
          fs.writeFileSync(${JSON.stringify(ready)}, "ready");
          while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
        });
      `],
      env: { ...process.env, LLV_STATE_DIR: directory },
      stdout: "ignore",
      stderr: "pipe",
    });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1) await Bun.sleep(10);
    expect(fs.existsSync(ready)).toBeTrue();

    const overrides = {
      registry,
      now: () => NOW,
      transcriptTitle: () => null,
      sharedPath: (pathname: string) => pathname === legacyPath ? sharedPath : null,
      log: () => {},
      env: {},
    };
    expect(() => runIdentityWaveMigrationAtStartup(overrides)).toThrow("account mutation is busy");
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
    expect(orchestratorSeatFor("viewer").active).toMatchObject({
      conversationId: conversation.id,
      seatEpoch: 1,
      path: legacyPath,
    });

    fs.writeFileSync(release, "release");
    const holderExit = await holder.exited;
    const holderError = await new Response(holder.stderr as ReadableStream<Uint8Array>).text();
    expect({ holderExit, holderError }).toEqual({ holderExit: 0, holderError: "" });
    holder = null;

    beginOrchestratorSeatIntent({
      project: "viewer",
      mandate: "own the newer rotation",
      clientRequestId: "req_00003002",
      mode: "spawn",
      now: NOW,
    });
    completeOrchestratorSeatIntent({
      project: "viewer",
      clientRequestId: "req_00003002",
      conversationId: "conversation_new",
      path: legacyPath,
      now: NOW,
    });
    replaceOrchestratorIncumbent({ conversationId: "conversation_new", path: legacyPath, createdAt: NOW });

    expect(runIdentityWaveMigrationAtStartup(overrides)).toMatchObject({ alreadyCompleted: false, rekeyed: 1 });
    expect(orchestratorSeatFor("viewer").active).toMatchObject({
      conversationId: "conversation_new",
      seatEpoch: 2,
      path: sharedPath,
    });
    expect(readOrchestratorRecord()).toMatchObject({ conversationId: "conversation_new", path: sharedPath });
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]?.completedAt).toBe(NOW);
  } finally {
    if (holder) {
      fs.writeFileSync(release, "release");
      await holder.exited;
    }
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a shared-path ownership collision aborts before mutation and leaves the marker open", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-collision-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const legacyPath = path.join(directory, "legacy.jsonl");
    const occupiedSharedPath = path.join(directory, "shared.jsonl");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const legacy = registry.ensureConversation("claude", legacyPath, null);
    registry.ensureConversation("claude", occupiedSharedPath, null);

    expect(() => registry.runIdentityWaveMigration({
      now: NOW,
      transcriptTitle: () => null,
      sharedPathForLegacy: (pathname) => pathname === legacyPath ? occupiedSharedPath : null,
      orchestratorSeats: [],
    })).toThrow("identity wave shared-path ownership collision");
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
    expect(registry.conversation(legacy.id)?.generations.at(-1)?.path).toBe(legacyPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("seat evidence failure leaves startup migration unmarked for retry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-seat-retry-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    let shouldFail = true;
    const dependencies = {
      registry,
      seats: () => {
        if (shouldFail) throw new Error("temporary seat evidence failure");
        return [];
      },
      now: () => NOW,
      transcriptTitle: () => null,
      sharedPath: () => null,
      log: () => {},
      env: {},
    };

    expect(() => runIdentityWaveMigrationAtStartup(dependencies)).toThrow("temporary seat evidence failure");
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();

    shouldFail = false;
    expect(runIdentityWaveMigrationAtStartup(dependencies)).toMatchObject({
      alreadyCompleted: false,
      retitled: 0,
      rekeyed: 0,
      edgesStamped: 0,
    });
    expect(registry.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]?.completedAt).toBe(NOW);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a dual-write publication failure restores an open marker and a retry converges both mirrors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-dual-write-retry-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const transcriptPath = path.join(directory, "legacy.jsonl");
    const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const conversation = seed.ensureConversation("codex", transcriptPath, null);
    const seeded = seed.snapshot();
    seeded.conversations[conversation.id]!.generations.at(-1)!.launchProfile.title = "Codex session";
    fs.writeFileSync(filename, `${JSON.stringify(seeded, null, 2)}\n`);

    let failPublication = true;
    const registry = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode: "dual-write",
      beforeDualWriteMutationReplace: () => {
        if (!failPublication) return;
        failPublication = false;
        throw new Error("injected SQLite publication failure");
      },
    });
    const input = {
      now: NOW,
      transcriptTitle: () => "Recover dual-write identity",
      sharedPathForLegacy: () => null,
      orchestratorSeats: [],
    };

    expect(() => registry.runIdentityWaveMigration(input)).toThrow("injected SQLite publication failure");
    const afterFailure = JSON.parse(fs.readFileSync(filename, "utf8")) as ReturnType<AgentRegistry["snapshot"]>;
    expect(afterFailure.identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
    expect(afterFailure.conversations[conversation.id]?.generations.at(-1)?.launchProfile.title).toBe("Codex session");

    expect(registry.runIdentityWaveMigration(input)).toMatchObject({
      alreadyCompleted: false,
      retitled: 1,
    });
    const jsonSnapshot = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" }).snapshot();
    const sqliteSnapshot = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
    expect(sqliteSnapshot).toEqual(jsonSnapshot);
    expect(jsonSnapshot.identityMigrations[IDENTITY_WAVE_MIGRATION]?.completedAt).toBe(NOW);
    expect(jsonSnapshot.conversations[conversation.id]?.generations.at(-1)?.launchProfile.title)
      .toBe("Recover dual-write identity");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the startup wrapper logs populated counters and persists migrated JSON and SQLite fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-parity-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const legacyFilename = `${crypto.randomUUID()}.jsonl`;
    const legacyPath = path.join(directory, "legacy-projects", "-repo", legacyFilename);
    const sharedPath = path.join(directory, "shared-projects", "-repo", legacyFilename);
    const successorPath = path.join(directory, "successor", `${crypto.randomUUID()}.jsonl`);
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    fs.writeFileSync(sharedPath, "{}\n");

    const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const legacyConversation = seed.ensureConversation("claude", legacyPath, null);
    const successorConversation = seed.ensureConversation("codex", successorPath, null);
    const legacyKey = sessionKeyFromTranscript("claude", legacyPath);
    if (!legacyKey) throw new Error("expected a parity transcript key");
    seed.upsert({
      key: legacyKey,
      artifactPath: legacyPath,
      cwd: directory,
      accountId: null,
      status: "dead",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    const reserved = seed.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      conversationId: legacyConversation.id,
      purpose: "resume-successor",
      expectedArtifactPath: legacyPath,
      launchProfile: { title: "Seed parity migration evidence" },
      launchDisplay: { ["prompt"]: "Parity migration title", echo: "Parity migration title", images: 0 },
    });
    if (reserved.kind !== "created") throw new Error("expected a parity receipt reservation");
    const seeded = seed.snapshot();
    seeded.receipts[reserved.receipt.launchId]!.launchProfile.title = "Claude session";
    seeded.conversations[legacyConversation.id]!.generations.at(-1)!.launchProfile.title = "Claude session";
    seeded.conversations[legacyConversation.id]!.agentRole = "worker";
    seeded.conversations[legacyConversation.id]!.delegationDepth = 2;
    fs.writeFileSync(filename, `${JSON.stringify(seeded, null, 2)}\n`);

    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
    const logs: unknown[][] = [];

    const result = runIdentityWaveMigrationAtStartup({
      registry,
      seats: () => [{
        project: "viewer",
        seatEpoch: 1,
        conversationId: legacyConversation.id,
        predecessorConversationId: null,
        designatedAt: NOW,
        activatedAt: NOW,
      }, {
        project: "viewer-successor",
        seatEpoch: 2,
        conversationId: successorConversation.id,
        predecessorConversationId: legacyConversation.id,
        designatedAt: NOW,
        activatedAt: NOW,
      }],
      now: () => NOW,
      transcriptTitle: () => null,
      sharedPath: (pathname) => pathname === legacyPath ? sharedPath : null,
      log: (...args) => { logs.push(args); },
      env: {},
    });

    expect(result).toMatchObject({ retitled: 1, rekeyed: 1, edgesStamped: 2 });
    expect(logs).toEqual([["[identity-wave] registry migration", {
      dryRun: false,
      alreadyCompleted: false,
      retitled: 1,
      rekeyed: 1,
      edgesStamped: 2,
    }]]);
    const jsonSnapshot = registry.snapshot();
    const parityReader = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
    const sqliteSnapshot = parityReader.snapshot();
    expect(sqliteSnapshot).toEqual(jsonSnapshot);
    expect(sqliteSnapshot.conversations[legacyConversation.id]!.generations.at(-1)).toMatchObject({
      path: sharedPath,
      launchProfile: expect.objectContaining({ title: "Parity migration title" }),
    });
    expect(Object.values(sqliteSnapshot.entries)).toContainEqual(expect.objectContaining({ artifactPath: sharedPath }));
    expect(sqliteSnapshot.receipts[reserved.receipt.launchId]).toMatchObject({
      artifactPath: sharedPath,
      resumeSourcePath: sharedPath,
      identityWaveTitleBackfill: true,
    });
    expect(sqliteSnapshot.memberships[legacyConversation.id]).toContainEqual(expect.objectContaining({
      kind: "orchestrator",
      containerId: "viewer",
    }));
    expect(sqliteSnapshot.lineageEdges[successorConversation.id]).toMatchObject({
      childConversationId: successorConversation.id,
      parentConversationId: legacyConversation.id,
      role: "orchestrator",
    });
    expect(sqliteSnapshot.identityMigrations[IDENTITY_WAVE_MIGRATION]).toEqual({
      completedAt: NOW,
      retitled: 1,
      rekeyed: 1,
      edgesStamped: 2,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
