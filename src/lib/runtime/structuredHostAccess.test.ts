import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import {
  emptyLaunchProfile,
  launchProfileCodexSandbox,
  launchProfileEngineReadOnly,
} from "@/lib/accounts/migration/contracts";
import { reconcileMigrationInventory } from "@/lib/accounts/migration/coordinator";
import { claudeSuccessorSpecFor } from "@/lib/agent/cli";
import { AgentRegistry } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import {
  materializeStructuredHostAccess,
  structuredHostAccessPolicy,
} from "./structuredSpawn";

test.each([
  { readOnly: false, sandbox: "full", codexSandbox: "danger-full-access" },
  { readOnly: false, sandbox: "restricted", codexSandbox: "workspace-write" },
  { readOnly: true, sandbox: "full", codexSandbox: "danger-full-access" },
  { readOnly: true, sandbox: "restricted", codexSandbox: "workspace-write" },
] as const)(
  "materializes repository readOnly=$readOnly independently from sandbox=$sandbox",
  ({ readOnly, sandbox, codexSandbox }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-access-profile-"));
    const sourceEnv = {
      NODE_ENV: "test" as const,
      HOME: path.join(directory, "home"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      TMPDIR: path.join(directory, "caller-tmp"),
    };
    try {
      expect(structuredHostAccessPolicy({ readOnly, sandbox })).toEqual({ readOnly, sandbox });
      expect(launchProfileEngineReadOnly({ readOnly, sandbox })).toBeFalse();
      expect(launchProfileCodexSandbox({ readOnly, sandbox })).toBe(codexSandbox);
      const materialized = materializeStructuredHostAccess(
        { readOnly, sandbox },
        sourceEnv,
        "capability",
        directory,
      );
      expect(materialized.codex).toEqual({ sandbox: codexSandbox });
      expect(materialized.scratchDirectory === null).toBe(sandbox === "full");
      if (sandbox === "restricted") {
        expect(materialized.env.TMPDIR).toBe(path.join(materialized.scratchDirectory!, "tmp"));
      } else {
        expect(materialized.env.TMPDIR).toBe(sourceEnv.TMPDIR);
      }
      materialized.cleanup();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("legacy read-only launch profiles retain their pre-axis engine sandbox on adoption", () => {
  expect(structuredHostAccessPolicy({ readOnly: true, sandbox: null })).toBeTrue();
  expect(launchProfileEngineReadOnly({ readOnly: true, sandbox: null })).toBeTrue();
  expect(launchProfileCodexSandbox({ readOnly: true, sandbox: null })).toBe("read-only");
});

test("resume successors preserve both explicit pipeline access axes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-access-resume-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
      sqliteMode: "off",
    });
    const sourcePath = path.join(directory, "source.jsonl");
    const snapshot = registry.reconcileConversations([{
      engine: "codex",
      path: sourcePath,
      accountId: "account-a",
      launchProfile: emptyLaunchProfile({
        cwd: directory,
        title: "Preserve pipeline runtime profile",
        readOnly: true,
        sandbox: "restricted",
      }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-08-31T00:00:00.000Z",
    }]);
    const conversation = Object.values(snapshot.conversations)[0];
    if (!conversation) throw new Error("source conversation was not reconciled");

    const resumed = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      conversationId: conversation.id,
      purpose: "resume-successor",
      origin: { kind: "successor" },
      launchProfile: {},
    });
    if (resumed.kind !== "created") throw new Error("resume successor was not created");
    expect(resumed.receipt.launchProfile).toMatchObject({
      readOnly: true,
      sandbox: "restricted",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("inventory preserves both access axes from a pending structured launch receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-access-inventory-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
      sqliteMode: "off",
    });
    const pathname = path.join(directory, "pending-stage.jsonl");
    fs.writeFileSync(pathname, "{}\n");
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: pathname,
      launchProfile: emptyLaunchProfile({
        cwd: directory,
        title: "Recover pending pipeline stage",
        readOnly: false,
        sandbox: "restricted",
      }),
    });
    if (begun.kind !== "created") throw new Error("pending stage receipt was not created");
    const stat = fs.statSync(pathname);
    const entry: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: "Pending pipeline stage",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "recent",
      activityReason: "jsonl_turn_completed",
      derivationComplete: true,
      proc: null,
      pid: null,
      model: "gpt-5.6-sol",
      pendingQuestion: null,
      waitingInput: null,
    };

    await reconcileMigrationInventory(registry, [entry], { deferBoardRepair: true });

    expect(registry.conversationForPath(pathname)?.generations.at(-1)?.launchProfile).toMatchObject({
      readOnly: false,
      sandbox: "restricted",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { readOnly: false, sandbox: "full", permissionMode: "bypassPermissions" },
  { readOnly: false, sandbox: "restricted", permissionMode: "auto" },
  { readOnly: true, sandbox: "full", permissionMode: "bypassPermissions" },
  { readOnly: true, sandbox: "restricted", permissionMode: "auto" },
] as const)(
  "Claude successor keeps repository readOnly=$readOnly independent from sandbox=$sandbox",
  ({ readOnly, sandbox, permissionMode }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-stage-access-"));
    try {
      const targetHome = path.join(directory, "claude");
      const targetProjectsDir = path.join(targetHome, "projects");
      fs.mkdirSync(targetProjectsDir, { recursive: true, mode: 0o700 });
      const spec = claudeSuccessorSpecFor({
        sourcePath: path.join(directory, "source.jsonl"),
        candidateId: crypto.randomUUID(),
        targetHome,
        targetProjectsDir,
        profile: emptyLaunchProfile({ cwd: directory, readOnly, sandbox, permissionMode }),
      });
      if (sandbox === "restricted") {
        expect(spec.command).toContain("'--permission-mode' 'auto'");
        expect(spec.command).toContain("'--restricted'");
      } else {
        expect(spec.command).toContain("'--dangerously-skip-permissions'");
        expect(spec.command).not.toContain("'--restricted'");
      }
      expect(spec.command).not.toContain("Edit,Write,NotebookEdit");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
