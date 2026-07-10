import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SessionKey } from "./sessionKey";
import { sessionKeyId } from "./sessionKey";

export type MigrationPhase = "preflight" | "root-ready" | "successor-started" | "successor-confirmed" | "rolled-back" | "failed";

export interface LegacyMigration {
  id: string;
  root: SessionKey;
  rootPath: string;
  nonce: string;
  approvalToken: string;
  phase: MigrationPhase;
  updatedAt: string;
  error: string | null;
}

export interface MigrationActions {
  checkpoint(nonce: string): Promise<boolean>;
  freezeViewer(): Promise<void>;
  stopOldRoot(): Promise<void>;
  startSuccessor(): Promise<boolean>;
  verifySuccessor(nonce: string): Promise<boolean>;
  rollback(): Promise<void>;
}

function stamp(): string { return new Date().toISOString(); }

function token(id: string, root: SessionKey, nonce: string): string {
  return crypto.createHash("sha256").update(`${id}:${sessionKeyId(root)}:${nonce}`).digest("hex").slice(0, 32);
}

export function createLegacyMigration(root: SessionKey, rootPath: string): LegacyMigration {
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  return { id, root, rootPath, nonce, approvalToken: token(id, root, nonce), phase: "preflight", updatedAt: stamp(), error: null };
}

function transition(migration: LegacyMigration, phase: MigrationPhase, error: string | null = null): LegacyMigration {
  return { ...migration, phase, error, updatedAt: stamp() };
}

export function persistLegacyMigration(filename: string, migration: LegacyMigration): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(migration, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* rename completed */ }
  }
}

/** The side-effect adapter is deliberately injected. Production execution is
    gated by a separate operator-only script; tests exercise every branch with
    fakes and no pane receives a signal during ordinary Viewer operation. */
export async function runLegacyCutover(
  migration: LegacyMigration,
  approvalToken: string,
  actions: MigrationActions,
  persist: (next: LegacyMigration) => void,
): Promise<LegacyMigration> {
  if (migration.phase === "successor-confirmed" || migration.phase === "rolled-back" || migration.phase === "failed") return migration;
  if (!crypto.timingSafeEqual(Buffer.from(migration.approvalToken), Buffer.from(approvalToken))) {
    throw new Error("migration approval token is invalid");
  }
  try {
    let next = migration;
    if (next.phase === "preflight") {
      if (!(await actions.checkpoint(next.nonce))) throw new Error("root checkpoint was not observed");
      next = transition(next, "root-ready");
      persist(next);
      await actions.freezeViewer();
      await actions.stopOldRoot();
    }
    if (next.phase === "root-ready") {
      if (!(await actions.startSuccessor())) throw new Error("successor root did not start");
      next = transition(next, "successor-started");
      persist(next);
    }
    if (next.phase !== "successor-started" || !(await actions.verifySuccessor(next.nonce))) throw new Error("successor root verification failed");
    next = transition(next, "successor-confirmed");
    persist(next);
    return next;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await actions.rollback();
      const rolledBack = transition(migration, "rolled-back", detail);
      persist(rolledBack);
      return rolledBack;
    } catch (rollbackError) {
      const failed = transition(migration, "failed", `${detail}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      persist(failed);
      return failed;
    }
  }
}
