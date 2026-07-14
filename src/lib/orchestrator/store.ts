import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

/* The single-instance record for the built-in Orchestrator (issue #182).
 * One conversation is THE orchestrator; the chat button resolves it here and
 * only spawns a fresh one when no live record exists. */

export const ORCHESTRATOR_SCHEMA_VERSION = 1;

export interface OrchestratorRecord {
  /** Stable viewer conversation id of the orchestrator session. */
  conversationId: string;
  /** Transcript path when the spawn settled one; null while path-pending. */
  path: string | null;
  /** ISO timestamp of the adopting spawn. */
  createdAt: string;
}

type OrchestratorFile = { schemaVersion: number; record: OrchestratorRecord };

const orchestratorFile = () => statePath("orchestrator.json");

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}

function isRecord(value: unknown): value is OrchestratorRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<OrchestratorRecord>;
  return (
    typeof record.conversationId === "string" && record.conversationId.length > 0 &&
    (record.path === null || typeof record.path === "string") &&
    typeof record.createdAt === "string"
  );
}

/** The current record, or null when none was adopted yet. A malformed or
    future-schema file reads as absent — adoption then overwrites it, which is
    the recovery path for a corrupt state file. */
export function readOrchestratorRecord(): OrchestratorRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(orchestratorFile(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrchestratorFile>;
    if (parsed.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION || !isRecord(parsed.record)) return null;
    return parsed.record;
  } catch {
    return null;
  }
}

/** Whether the recorded conversation still exists on disk. A record without a
    settled transcript path cannot be checked and counts as live. */
export function orchestratorRecordExists(record: OrchestratorRecord): boolean {
  return record.path === null || fs.existsSync(record.path);
}

/**
 * First-write-wins adoption: the candidate becomes THE orchestrator only when
 * no live record exists (none yet, or the recorded transcript was deleted).
 * Losers get the canonical record back and navigate to it instead — the
 * one-instance invariant lives here, not in the button.
 */
export function adoptOrchestratorRecord(candidate: OrchestratorRecord): { record: OrchestratorRecord; adopted: boolean } {
  const current = readOrchestratorRecord();
  if (current && orchestratorRecordExists(current) && current.conversationId !== candidate.conversationId) {
    return { record: current, adopted: false };
  }
  atomicWriteJson(orchestratorFile(), { schemaVersion: ORCHESTRATOR_SCHEMA_VERSION, record: candidate } satisfies OrchestratorFile);
  return { record: candidate, adopted: true };
}
