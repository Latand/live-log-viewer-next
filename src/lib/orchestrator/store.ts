import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { statePath } from "@/lib/configDir";
import type { IdentityWavePathRekey } from "@/lib/agent/identityWaveMigration";

/* The single-instance record for the built-in Orchestrator (issue #182), which
 * #691 promotes to THE MANAGER: the agent that owns the board — tasks,
 * pipelines, flows, PRs, workers, deploys — and never speaks to the user.
 *
 * It stays a record of its own, separate from the voice root's lineage, joined
 * to it only by the bridge channel (`src/lib/bridge/`). Collapsing the two would
 * make the gateway and the executor one identity, and the whole point is that
 * they are not: one may talk to the user, the other may touch the board.
 *
 * The record names the *incumbent* — which engine and model is currently sitting
 * in the manager's seat — so a model swap is retire, spawn, update this record.
 * The record itself survives, and so do the bridge cursors that reference it,
 * because they reference it by name and never by conversation id. */

export const ORCHESTRATOR_SCHEMA_VERSION = 2;

/** #691: Claude Opus 5 by default (`opus` is this repo's latest-Opus alias —
    see `src/lib/agent/models.ts`), swappable without reshaping anything. */
export const MANAGER_DEFAULT_ENGINE = "claude";
export const MANAGER_DEFAULT_MODEL = "opus";

export interface OrchestratorRecord {
  /** Stable viewer conversation id of the orchestrator session. */
  conversationId: string;
  /** Transcript path when the spawn settled one; null while path-pending. */
  path: string | null;
  /** ISO timestamp of the adopting spawn. */
  createdAt: string;
  /** The incumbent's engine (`claude`, `codex`, …). Descriptive, not a gate. */
  engine: string;
  /** The incumbent's model alias. */
  model: string;
}

/** What a caller may hand in: the incumbent fields default, so #182-era callers
    and the existing spawn path keep compiling and keep meaning the same thing. */
export type OrchestratorRecordInput =
  Omit<OrchestratorRecord, "engine" | "model">
  & Partial<Pick<OrchestratorRecord, "engine" | "model">>;

type OrchestratorFile = { schemaVersion: number; record: OrchestratorRecord };

const orchestratorFile = () => statePath("orchestrator.json");

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}

/**
 * Read one stored record, filling the incumbent fields when they are missing or
 * unusable.
 *
 * A #182-era file (schema 1) has no engine/model, and a partially written one may
 * have nonsense in them. Neither is a reason to report "no manager": that answer
 * would abandon a designation the operator already has and let a second manager
 * be spawned beside the live one. The identity fields are the ones worth
 * refusing over; the descriptive ones default.
 */
function normalizeRecord(value: unknown): OrchestratorRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<OrchestratorRecord>;
  if (typeof record.conversationId !== "string" || record.conversationId.length === 0) return null;
  if (record.path !== null && typeof record.path !== "string") return null;
  if (typeof record.createdAt !== "string") return null;
  const text = (candidate: unknown, fallback: string): string =>
    typeof candidate === "string" && candidate.trim() ? candidate : fallback;
  return {
    conversationId: record.conversationId,
    path: record.path ?? null,
    createdAt: record.createdAt,
    engine: text(record.engine, MANAGER_DEFAULT_ENGINE),
    model: text(record.model, MANAGER_DEFAULT_MODEL),
  };
}

/** The current record, or null when none was adopted yet. A malformed or
    future-schema file reads as absent — adoption then overwrites it, which is
    the recovery path for a corrupt state file. Every schema this app has ever
    written reads forward, because losing the designation is worse than reading
    an old shape. */
export function readOrchestratorRecord(): OrchestratorRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(orchestratorFile(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrchestratorFile>;
    const version = parsed.schemaVersion;
    if (typeof version !== "number" || version < 1 || version > ORCHESTRATOR_SCHEMA_VERSION) return null;
    return normalizeRecord(parsed.record);
  } catch {
    return null;
  }
}

function withIncumbent(candidate: OrchestratorRecordInput): OrchestratorRecord {
  return {
    conversationId: candidate.conversationId,
    path: candidate.path,
    createdAt: candidate.createdAt,
    engine: candidate.engine ?? MANAGER_DEFAULT_ENGINE,
    model: candidate.model ?? MANAGER_DEFAULT_MODEL,
  };
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
export function adoptOrchestratorRecord(candidate: OrchestratorRecordInput): { record: OrchestratorRecord; adopted: boolean } {
  return withAccountMutationLock(() => {
    const current = readOrchestratorRecord();
    if (current && orchestratorRecordExists(current) && current.conversationId !== candidate.conversationId) {
      return { record: current, adopted: false };
    }
    const record = withIncumbent(candidate);
    atomicWriteJson(orchestratorFile(), { schemaVersion: ORCHESTRATOR_SCHEMA_VERSION, record } satisfies OrchestratorFile);
    return { record, adopted: true };
  });
}

/**
 * Seat a new incumbent deliberately, replacing a live record (#691 §3, §7.3).
 *
 * Adoption cannot do this, and must not: refusing a second conversation while one
 * is live is the entire single-instance guarantee. Swapping the manager's model is
 * a different act with a different intent — the operator retired the incumbent on
 * purpose — so it gets its own entry point rather than a flag that weakens the
 * guard for everyone.
 *
 * Deliberately touches nothing but this file. The bridge channel references the
 * manager by record name, so its cursors stay exactly where they were and the
 * successor drains the directives its predecessor never read.
 */
export function replaceOrchestratorIncumbent(candidate: OrchestratorRecordInput): OrchestratorRecord {
  return withAccountMutationLock(() => {
    const record = withIncumbent(candidate);
    atomicWriteJson(orchestratorFile(), { schemaVersion: ORCHESTRATOR_SCHEMA_VERSION, record } satisfies OrchestratorFile);
    return record;
  });
}

/** Rekey the legacy manager pointer as part of the identity wave. Missing
 * state is valid; unreadable or malformed state keeps the registry marker open
 * so startup can retry after the evidence becomes available. */
export function rekeyOrchestratorRecordPath(rekeys: readonly IdentityWavePathRekey[]): void {
  if (rekeys.length === 0) return;
  withAccountMutationLock(() => {
    let raw: string;
    try {
      raw = fs.readFileSync(orchestratorFile(), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let parsed: Partial<OrchestratorFile>;
    try {
      parsed = JSON.parse(raw) as Partial<OrchestratorFile>;
    } catch (error) {
      throw new Error("orchestrator record evidence is malformed", { cause: error });
    }
    const version = parsed.schemaVersion;
    const record = normalizeRecord(parsed.record);
    if (typeof version !== "number" || version < 1 || version > ORCHESTRATOR_SCHEMA_VERSION || !record) {
      throw new Error("orchestrator record evidence is malformed");
    }
    const replacement = record.path
      ? rekeys.find((rekey) => rekey.legacyPath === record.path)?.sharedPath
      : null;
    if (!replacement) return;
    atomicWriteJson(orchestratorFile(), {
      schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
      record: { ...record, path: replacement },
    } satisfies OrchestratorFile);
  });
}
