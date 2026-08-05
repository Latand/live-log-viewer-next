import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { AgentRegistry } from "./registry";
import { IDENTITY_WAVE_MIGRATION } from "./identityWaveMigration";
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
    const receiptLegacyPath = path.join(legacyRoot, "-repo", "receipt.jsonl");
    const receiptSharedPath = path.join(sharedRoot, "-repo", "receipt.jsonl");
    const transcriptLegacyPath = path.join(legacyRoot, "-repo", "transcript.jsonl");
    const transcriptSharedPath = path.join(sharedRoot, "-repo", "transcript.jsonl");
    const noEvidencePath = path.join(directory, "no-evidence.jsonl");
    const orchestratorPath = path.join(directory, "orchestrator.jsonl");
    const successorPath = path.join(directory, "orchestrator-successor.jsonl");
    for (const pathname of [receiptSharedPath, transcriptSharedPath, orchestratorPath, successorPath]) {
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
    }
    fs.writeFileSync(receiptSharedPath, `${JSON.stringify({ type: "ai-title", aiTitle: "Lower-priority transcript title" })}\n`);
    fs.writeFileSync(transcriptSharedPath, `${JSON.stringify({ type: "ai-title", aiTitle: "Transcript head title" })}\n`);
    fs.writeFileSync(orchestratorPath, "{}\n");
    fs.writeFileSync(successorPath, "{}\n");

    const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const receiptConversation = seed.ensureConversation("claude", receiptLegacyPath, null);
    const transcriptConversation = seed.ensureConversation("claude", transcriptLegacyPath, null);
    const noEvidenceConversation = seed.ensureConversation("codex", noEvidencePath, null);
    const orchestratorConversation = seed.ensureConversation("codex", orchestratorPath, null);
    const successorConversation = seed.ensureConversation("codex", successorPath, null);
    seed.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      conversationId: receiptConversation.id,
      launchProfile: { title: "Claude session" },
      launchDisplay: {
        ["prompt"]: "Implement receipt backfill\nAcceptance evidence follows",
        echo: "Implement receipt backfill\nAcceptance evidence follows",
        images: 0,
      },
    });
    const legacy = seed.snapshot();
    for (const conversationId of [receiptConversation.id, transcriptConversation.id, noEvidenceConversation.id]) {
      legacy.conversations[conversationId]!.generations.at(-1)!.launchProfile.title = conversationId === noEvidenceConversation.id
        ? "Codex session"
        : "Claude session";
    }
    legacy.conversations[orchestratorConversation.id]!.generations.at(-1)!.launchProfile.title = "Own identity migrations";
    legacy.conversations[successorConversation.id]!.generations.at(-1)!.launchProfile.title = "Continue identity migrations";
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
    expect(migrated.conversations[transcriptConversation.id]!.generations.at(-1)).toMatchObject({
      path: transcriptSharedPath,
      launchProfile: expect.objectContaining({ title: "Transcript head title" }),
    });
    expect(migrated.conversations[transcriptConversation.id]!.continuityPaths).toContain(transcriptLegacyPath);
    expect(migrated.conversations[noEvidenceConversation.id]!.generations.at(-1)!.launchProfile.title).toBeNull();
    expect(migrated.conversations[orchestratorConversation.id]).toMatchObject({
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

test("the startup wrapper logs all counters and persists its marker through JSON and SQLite", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-wave-parity-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
    const logs: unknown[][] = [];

    const result = runIdentityWaveMigrationAtStartup({
      registry,
      seats: () => [],
      now: () => NOW,
      transcriptTitle: () => null,
      sharedPath: () => null,
      log: (...args) => { logs.push(args); },
      env: {},
    });

    expect(result).toMatchObject({ retitled: 0, rekeyed: 0, edgesStamped: 0 });
    expect(logs).toEqual([["[identity-wave] registry migration", {
      dryRun: false,
      alreadyCompleted: false,
      retitled: 0,
      rekeyed: 0,
      edgesStamped: 0,
    }]]);
    const parityReader = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
    expect(parityReader.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]?.completedAt).toBe(NOW);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
