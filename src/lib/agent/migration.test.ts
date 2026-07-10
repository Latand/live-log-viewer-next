import { describe, expect, test } from "bun:test";

import { createLegacyMigration, runLegacyCutover, type MigrationActions } from "@/lib/agent/migration";

const ROOT = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" };

function actions(overrides: Partial<MigrationActions> = {}): MigrationActions {
  return { checkpoint: async () => true, freezeViewer: async () => {}, stopOldRoot: async () => {}, startSuccessor: async () => true, verifySuccessor: async () => true, rollback: async () => {}, ...overrides };
}

describe("legacy migration phase machine", () => {
  test("requires a matching approval and confirms a verified successor", async () => {
    const migration = createLegacyMigration(ROOT, "/root.jsonl");
    const phases: string[] = [];
    const result = await runLegacyCutover(migration, migration.approvalToken, actions(), (next) => phases.push(next.phase));
    expect(result.phase).toBe("successor-confirmed");
    expect(phases).toEqual(["root-ready", "successor-started", "successor-confirmed"]);
  });

  test("rolls back if successor verification fails", async () => {
    const migration = createLegacyMigration(ROOT, "/root.jsonl");
    let rolledBack = false;
    const result = await runLegacyCutover(migration, migration.approvalToken, actions({ verifySuccessor: async () => false, rollback: async () => { rolledBack = true; } }), () => {});
    expect(result.phase).toBe("rolled-back");
    expect(rolledBack).toBe(true);
  });
});
