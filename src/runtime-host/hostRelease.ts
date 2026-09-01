import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

export const RUNTIME_HOST_IMAGE_ENV = "LLV_RUNTIME_HOST_IMAGE";
export const RUNTIME_HOST_REVISION_ENV = "LLV_RUNTIME_HOST_REVISION";
export const RUNTIME_HOST_CONTAINER_ENV = "LLV_RUNTIME_HOST_CONTAINER";

/** The durable runtime-host generation record (#518). Staging a successor
    writes it before any handoff, and the next runtime-host boot reads it to
    learn which deployed revision it is expected to be running. A missing
    record means the legacy fixed-tag image: never provably current. */
export interface RuntimeHostReleaseRecord extends ViewerReleaseIdentity {
  stagedAt: string;
}

export interface RuntimeHostRollbackTarget {
  version: 1;
  active: RuntimeHostReleaseRecord;
  previous: RuntimeHostReleaseRecord;
  predecessorId: string;
  recordedAt: string;
}

export interface RuntimeHostRollbackIntent extends RuntimeHostRollbackTarget {
  phase: "requested";
  requestedAt: string;
}

export function runtimeHostReleaseFile(): string {
  return process.env.LLV_RUNTIME_HOST_RELEASE_TARGET || statePath("runtime-host-release.json");
}

export function runtimeHostRollbackTargetFile(): string {
  return process.env.LLV_RUNTIME_HOST_ROLLBACK_TARGET || statePath("runtime-host-rollback-target.json");
}

export function runtimeHostRollbackIntentFile(): string {
  return process.env.LLV_RUNTIME_HOST_ROLLBACK_INTENT_TARGET || statePath("runtime-host-rollback-intent.json");
}

function readDurableJson(filename: string, label: string): unknown | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${label} is unreadable`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
}

function durableRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function readRuntimeHostRelease(filename = runtimeHostReleaseFile()): RuntimeHostReleaseRecord | null {
  const raw = readDurableJson(filename, "runtime-host release");
  if (raw === undefined) return null;
  const value = durableRecord(raw, "runtime-host release");
  if (typeof value.image !== "string"
    || typeof value.container !== "string"
    || typeof value.endpoint !== "string"
    || typeof value.revision !== "string"
    || typeof value.stagedAt !== "string") throw new Error("runtime-host release is invalid");
  return value as unknown as RuntimeHostReleaseRecord;
}

function releaseRecord(value: unknown, label: string): RuntimeHostReleaseRecord {
  const item = durableRecord(value, label);
  if (typeof item.image !== "string"
    || typeof item.container !== "string"
    || typeof item.endpoint !== "string"
    || typeof item.revision !== "string"
    || typeof item.stagedAt !== "string") throw new Error(`${label} is invalid`);
  return item as unknown as RuntimeHostReleaseRecord;
}

function rollbackTarget(value: unknown, label: string): RuntimeHostRollbackTarget {
  const item = durableRecord(value, label);
  if (item.version !== 1
    || typeof item.predecessorId !== "string"
    || !item.predecessorId
    || typeof item.recordedAt !== "string") throw new Error(`${label} is invalid`);
  return {
    version: 1,
    active: releaseRecord(item.active, label),
    previous: releaseRecord(item.previous, label),
    predecessorId: item.predecessorId,
    recordedAt: item.recordedAt,
  };
}

export function readRuntimeHostRollbackTarget(
  filename = runtimeHostRollbackTargetFile(),
): RuntimeHostRollbackTarget | null {
  const value = readDurableJson(filename, "runtime-host rollback target");
  return value === undefined ? null : rollbackTarget(value, "runtime-host rollback target");
}

export function writeRuntimeHostRollbackTarget(
  target: RuntimeHostRollbackTarget,
  filename = runtimeHostRollbackTargetFile(),
): void {
  writeDurableJson(filename, target);
}

export function clearRuntimeHostRollbackTarget(filename = runtimeHostRollbackTargetFile()): void {
  clearDurableFile(filename);
}

export function readRuntimeHostRollbackIntent(
  filename = runtimeHostRollbackIntentFile(),
): RuntimeHostRollbackIntent | null {
  const value = readDurableJson(filename, "runtime-host rollback intent");
  if (value === undefined) return null;
  const target = rollbackTarget(value, "runtime-host rollback intent");
  const item = value as Record<string, unknown>;
  if (item.phase !== "requested" || typeof item.requestedAt !== "string") {
    throw new Error("runtime-host rollback intent is invalid");
  }
  return { ...target, phase: "requested", requestedAt: item.requestedAt };
}

export function writeRuntimeHostRollbackIntent(
  intent: RuntimeHostRollbackIntent,
  filename = runtimeHostRollbackIntentFile(),
): void {
  writeDurableJson(filename, intent);
}

export function clearRuntimeHostRollbackIntent(filename = runtimeHostRollbackIntentFile()): void {
  clearDurableFile(filename);
}

/** A shared release record proves the current process generation only when
    dockerd injected the same immutable identity into this container. Legacy
    predecessors carry none of these values and therefore cannot claim a
    successor record written while they were still serving. */
export function currentRuntimeHostGeneration(
  environment: NodeJS.ProcessEnv = process.env,
  record: RuntimeHostReleaseRecord | null = readRuntimeHostRelease(),
): { image: string | null; revision: string | null } {
  if (!record
    || environment[RUNTIME_HOST_IMAGE_ENV] !== record.image
    || environment[RUNTIME_HOST_REVISION_ENV] !== record.revision
    || environment[RUNTIME_HOST_CONTAINER_ENV] !== record.container) {
    return { image: null, revision: null };
  }
  return { image: record.image, revision: record.revision };
}

function writeDurableJson(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  fsyncDirectory(path.dirname(filename));
}

export function writeRuntimeHostRelease(record: RuntimeHostReleaseRecord, filename = runtimeHostReleaseFile()): void {
  writeDurableJson(filename, record);
}

/** PR #521: the durable intermediate identity of an in-flight successor
    handoff. Written only after the successor container is observably stable,
    before the predecessor's restart policy is disabled. The fenced successor
    converts it into the bounded rollback target and clears it. A staging retry
    that finds this intent must resume from it instead of rediscovering a
    predecessor through the singleton-fence owner — after the crash boundary
    the fence may already belong to the successor, and fence-owner discovery
    would select, disable, and exit the successor itself. */
export interface RuntimeHostHandoffIntent {
  revision: string;
  image: string;
  successorContainer: string;
  predecessorId: string;
  /** Present for managed predecessors. The successor retains this stopped
      generation as the listener-independent rollback target (#1270). */
  previousRelease?: RuntimeHostReleaseRecord;
  successorRelease?: RuntimeHostReleaseRecord;
  recordedAt: string;
}

export function runtimeHostHandoffIntentFile(): string {
  return process.env.LLV_RUNTIME_HOST_HANDOFF_INTENT_TARGET || statePath("runtime-host-handoff-intent.json");
}

export function readRuntimeHostHandoffIntent(filename = runtimeHostHandoffIntentFile()): RuntimeHostHandoffIntent | null {
  const raw = readDurableJson(filename, "runtime-host handoff intent");
  if (raw === undefined) return null;
  const value = durableRecord(raw, "runtime-host handoff intent");
  if (typeof value.revision !== "string"
    || typeof value.image !== "string"
    || typeof value.successorContainer !== "string"
    || typeof value.predecessorId !== "string"
    || typeof value.recordedAt !== "string") throw new Error("runtime-host handoff intent is invalid");
  const previousRelease = value.previousRelease === undefined
    ? undefined
    : releaseRecord(value.previousRelease, "runtime-host handoff intent");
  const successorRelease = value.successorRelease === undefined
    ? undefined
    : releaseRecord(value.successorRelease, "runtime-host handoff intent");
  if ((previousRelease === undefined) !== (successorRelease === undefined)) {
    throw new Error("runtime-host handoff intent is invalid");
  }
  return {
    revision: value.revision,
    image: value.image,
    successorContainer: value.successorContainer,
    predecessorId: value.predecessorId,
    ...(previousRelease && successorRelease ? { previousRelease, successorRelease } : {}),
    recordedAt: value.recordedAt,
  };
}

export function writeRuntimeHostHandoffIntent(intent: RuntimeHostHandoffIntent, filename = runtimeHostHandoffIntentFile()): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(intent));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temporary, filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("runtime-host handoff intent is already owned by another generation", { cause: error });
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  fsyncDirectory(path.dirname(filename));
}

export function clearRuntimeHostHandoffIntent(filename = runtimeHostHandoffIntentFile()): void {
  clearDurableFile(filename);
}

function sameRuntimeHostRelease(
  left: RuntimeHostReleaseRecord,
  right: RuntimeHostReleaseRecord,
): boolean {
  return left.image === right.image
    && left.revision === right.revision
    && left.container === right.container
    && left.endpoint === right.endpoint
    && left.stagedAt === right.stagedAt;
}

function sameRuntimeHostHandoffIntent(
  left: RuntimeHostHandoffIntent,
  right: RuntimeHostHandoffIntent,
): boolean {
  return left.image === right.image
    && left.revision === right.revision
    && left.successorContainer === right.successorContainer
    && left.predecessorId === right.predecessorId
    && left.recordedAt === right.recordedAt
    && (left.previousRelease === undefined) === (right.previousRelease === undefined)
    && (left.successorRelease === undefined) === (right.successorRelease === undefined)
    && (!left.previousRelease || !right.previousRelease || sameRuntimeHostRelease(left.previousRelease, right.previousRelease))
    && (!left.successorRelease || !right.successorRelease || sameRuntimeHostRelease(left.successorRelease, right.successorRelease));
}

/** Handoff publication is no-clobber, so the identity read here cannot be
    replaced before this synchronous unlink. A writer that publishes after the
    unlink creates a new canonical file and survives this cleanup. */
export function clearRuntimeHostHandoffIntentIfMatches(
  expected: RuntimeHostHandoffIntent,
  filename = runtimeHostHandoffIntentFile(),
): boolean {
  const current = readRuntimeHostHandoffIntent(filename);
  if (!current || !sameRuntimeHostHandoffIntent(current, expected)) return false;
  clearDurableFile(filename);
  return true;
}

function clearDurableFile(filename: string): void {
  fs.rmSync(filename, { force: true });
  fsyncDirectory(path.dirname(filename));
}

function fsyncDirectory(directoryPath: string): void {
  let directory: number;
  try {
    directory = fs.openSync(directoryPath, "r");
  } catch {
    return;
  }
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
