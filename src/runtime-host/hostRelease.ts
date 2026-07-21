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

export function runtimeHostReleaseFile(): string {
  return process.env.LLV_RUNTIME_HOST_RELEASE_TARGET || statePath("runtime-host-release.json");
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
  const directory = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function writeRuntimeHostRelease(record: RuntimeHostReleaseRecord, filename = runtimeHostReleaseFile()): void {
  writeDurableJson(filename, record);
}

/** PR #521: the durable intermediate identity of an in-flight successor
    handoff. Written only after the successor container is observably stable,
    before the predecessor's restart policy is disabled, and cleared only
    after the release record is published. A staging retry that finds this
    intent must resume from it instead of rediscovering a predecessor through
    the singleton-fence owner — after the crash boundary the fence may already
    belong to the successor, and fence-owner discovery would select, disable,
    and exit the successor itself. */
export interface RuntimeHostHandoffIntent {
  revision: string;
  image: string;
  successorContainer: string;
  predecessorId: string;
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
  return value as unknown as RuntimeHostHandoffIntent;
}

export function writeRuntimeHostHandoffIntent(intent: RuntimeHostHandoffIntent, filename = runtimeHostHandoffIntentFile()): void {
  writeDurableJson(filename, intent);
}

export function clearRuntimeHostHandoffIntent(filename = runtimeHostHandoffIntentFile()): void {
  fs.rmSync(filename, { force: true });
  let directory: number;
  try {
    directory = fs.openSync(path.dirname(filename), "r");
  } catch {
    return;
  }
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
