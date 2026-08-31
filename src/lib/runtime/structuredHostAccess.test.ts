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
import { claudeSuccessorSpecFor } from "@/lib/agent/cli";

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
