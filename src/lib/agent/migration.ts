import crypto from "node:crypto";

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

/** The side-effect adapter is deliberately injected. Production execution is
    gated by a separate operator-only script; tests exercise every branch with
    fakes and no pane receives a signal during ordinary Viewer operation. */
export async function runLegacyCutover(
  migration: LegacyMigration,
  approvalToken: string,
  actions: MigrationActions,
  persist: (next: LegacyMigration) => void,
): Promise<LegacyMigration> {
  if (migration.phase !== "preflight") throw new Error(`migration is already ${migration.phase}`);
  if (!crypto.timingSafeEqual(Buffer.from(migration.approvalToken), Buffer.from(approvalToken))) {
    throw new Error("migration approval token is invalid");
  }
  try {
    if (!(await actions.checkpoint(migration.nonce))) throw new Error("root checkpoint was not observed");
    let next = transition(migration, "root-ready");
    persist(next);
    await actions.freezeViewer();
    await actions.stopOldRoot();
    if (!(await actions.startSuccessor())) throw new Error("successor root did not start");
    next = transition(next, "successor-started");
    persist(next);
    if (!(await actions.verifySuccessor(migration.nonce))) throw new Error("successor root verification failed");
    next = transition(next, "successor-confirmed");
    persist(next);
    return next;
  } catch (error) {
    await actions.rollback();
    const rolledBack = transition(migration, "rolled-back", error instanceof Error ? error.message : String(error));
    persist(rolledBack);
    return rolledBack;
  }
}
