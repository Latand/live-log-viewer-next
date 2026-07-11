import { describe, expect, test } from "bun:test";

import { createLegacyMigration, runLegacyCutover, type MigrationActions } from "@/lib/agent/migration";

const ROOT = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" };

function actions(overrides: Partial<MigrationActions> = {}): MigrationActions {
  return {
    checkpoint: async () => true,
    freezeViewer: async () => {},
    stopOldRoot: async () => {},
    startSuccessor: async () => true,
    verifySuccessor: async () => true,
    verifyCompletion: async () => ({ supervisorReachable: true, sessionsMoved: true }),
    commitCompletionMarker: async () => {},
    rollbackCompletionMarker: async () => {},
    rollback: async () => {},
    ...overrides,
  };
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
    let markerRolledBack = false;
    const result = await runLegacyCutover(migration, migration.approvalToken, actions({
      verifySuccessor: async () => false,
      rollbackCompletionMarker: async () => { markerRolledBack = true; },
      rollback: async () => { rolledBack = true; },
    }), () => {});
    expect(result.phase).toBe("rolled-back");
    expect(rolledBack).toBe(true);
    expect(markerRolledBack).toBe(true);
  });

  test("commits the completion marker only after the supervisor and moved sessions are verified", async () => {
    const migration = createLegacyMigration(ROOT, "/root.jsonl");
    const calls: string[] = [];
    const result = await runLegacyCutover(migration, migration.approvalToken, actions({
      verifySuccessor: async () => { calls.push("successor"); return true; },
      verifyCompletion: async () => { calls.push("migration"); return { supervisorReachable: true, sessionsMoved: true }; },
      commitCompletionMarker: async () => { calls.push("marker"); },
    }), () => {});

    expect(result.phase).toBe("successor-confirmed");
    expect(calls).toEqual(["successor", "migration", "marker"]);
  });

  test("rejects incomplete migration evidence and removes any stale marker during rollback", async () => {
    const migration = createLegacyMigration(ROOT, "/root.jsonl");
    const calls: string[] = [];
    const result = await runLegacyCutover(migration, migration.approvalToken, actions({
      verifyCompletion: async () => ({ supervisorReachable: true, sessionsMoved: false }),
      commitCompletionMarker: async () => { calls.push("marker"); },
      rollbackCompletionMarker: async () => { calls.push("marker-rollback"); },
      rollback: async () => { calls.push("migration-rollback"); },
    }), () => {});

    expect(result.phase).toBe("rolled-back");
    expect(result.error).toContain("migration completion verification failed");
    expect(calls).toEqual(["marker-rollback", "migration-rollback"]);
  });

  test("recovers an interrupted root-ready migration and records rollback failure", async () => {
    const migration = { ...createLegacyMigration(ROOT, "/root.jsonl"), phase: "root-ready" as const };
    const resumed = await runLegacyCutover(migration, migration.approvalToken, actions(), () => {});
    expect(resumed.phase).toBe("successor-confirmed");
    const failed = await runLegacyCutover(migration, migration.approvalToken, actions({ startSuccessor: async () => false, rollback: async () => { throw new Error("network unavailable"); } }), () => {});
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("rollback failed");
  });
});
