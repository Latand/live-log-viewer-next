import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { adoptRootSession, mintRootId } from "./lineage";
import { ROOT_LINEAGE_SCHEMA_VERSION, type RootAdoption, type RootLineageV1, type RootRolloverReason, type RootSessionV1 } from "./types";

/**
 * Durable home of the root conversation's identity and rollover chain (#688 D5).
 *
 * Resolved lazily rather than as a module constant, so a sandboxed
 * `LLV_STATE_DIR` set after import still redirects the file — the same reason
 * the orchestrator record resolves its path per call.
 */
export function rootLineageFile(): string {
  return statePath("root-lineage.json");
}

export class RootLineageStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RootLineageStoreError";
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, filePath);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}

function isRolloverReason(value: unknown): value is RootRolloverReason {
  return value === "crash" || value === "reboot" || value === "rollover" || value === "fresh";
}

function isSession(value: unknown): value is RootSessionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<RootSessionV1>;
  return (
    typeof session.conversationId === "string" && session.conversationId.length > 0
    && (session.path === null || typeof session.path === "string")
    && typeof session.startedAt === "string"
    && (session.endedAt === undefined || typeof session.endedAt === "string")
    && (session.seededFrom === undefined || typeof session.seededFrom === "string")
    && (session.reason === undefined || isRolloverReason(session.reason))
  );
}

function isLineage(value: unknown): value is RootLineageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lineage = value as Partial<RootLineageV1>;
  return (
    lineage.schemaVersion === ROOT_LINEAGE_SCHEMA_VERSION
    && typeof lineage.rootId === "string" && lineage.rootId.length > 0
    && Number.isInteger(lineage.revision) && lineage.revision! >= 0
    && typeof lineage.updatedAt === "string"
    && Array.isArray(lineage.sessions) && lineage.sessions.every(isSession)
  );
}

/**
 * The persisted lineage, or null when no root session has ever been adopted.
 *
 * A malformed file throws rather than reading as absent: the root id is the
 * identity that in-flight attention requests were written against, so silently
 * minting a replacement would orphan them exactly the way keying on a session
 * path would.
 */
export function readRootLineage(filePath = rootLineageFile()): RootLineageV1 | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RootLineageStoreError("could not read the root lineage", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new RootLineageStoreError("root lineage contains malformed JSON", { cause: error });
  }
  if (!isLineage(parsed)) throw new RootLineageStoreError("root lineage is not a valid record");
  return parsed;
}

/**
 * Record the live root session, creating the root identity on first sight and
 * appending a rollover link whenever the session id changes. Serialized through
 * the shared file transaction so two tabs reporting the same rollover cannot
 * both append a successor.
 */
export function recordRootSession(
  candidate: { conversationId: string; path?: string | null },
  options: { now?: Date; reason?: RootRolloverReason; filePath?: string } = {},
): RootAdoption {
  const filePath = options.filePath ?? rootLineageFile();
  return withFileTransactionSync(filePath, "root lineage is busy", () => {
    const current = readRootLineage(filePath);
    const adoption = adoptRootSession(current, candidate, {
      now: options.now,
      reason: options.reason,
      rootId: current?.rootId ?? mintRootId(),
    });
    if (adoption.outcome !== "current") atomicWriteJson(filePath, adoption.lineage);
    return adoption;
  });
}

/** The stable root identity, minting one if the operator has never had a root
    session. Callers that must reference the root durably use this and nothing
    else — never a conversation id, never a transcript path (D5). */
export function rootIdentity(filePath = rootLineageFile()): string {
  const existing = readRootLineage(filePath);
  if (existing) return existing.rootId;
  return withFileTransactionSync(filePath, "root lineage is busy", () => {
    const current = readRootLineage(filePath);
    if (current) return current.rootId;
    const lineage: RootLineageV1 = {
      schemaVersion: ROOT_LINEAGE_SCHEMA_VERSION,
      rootId: mintRootId(),
      revision: 0,
      updatedAt: new Date().toISOString(),
      sessions: [],
    };
    atomicWriteJson(filePath, lineage);
    return lineage.rootId;
  });
}
