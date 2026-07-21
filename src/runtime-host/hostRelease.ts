import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

/** The durable runtime-host generation record (#518). Staging a successor
    writes it before any handoff, and the next runtime-host boot reads it to
    learn which deployed revision it is expected to be running. A missing or
    invalid record means the legacy fixed-tag image: never provably current. */
export interface RuntimeHostReleaseRecord extends ViewerReleaseIdentity {
  stagedAt: string;
}

export function runtimeHostReleaseFile(): string {
  return process.env.LLV_RUNTIME_HOST_RELEASE_TARGET || statePath("runtime-host-release.json");
}

export function readRuntimeHostRelease(filename = runtimeHostReleaseFile()): RuntimeHostReleaseRecord | null {
  let value: Partial<RuntimeHostReleaseRecord>;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<RuntimeHostReleaseRecord>;
  } catch {
    return null;
  }
  if (typeof value.image !== "string"
    || typeof value.container !== "string"
    || typeof value.endpoint !== "string"
    || typeof value.revision !== "string"
    || typeof value.stagedAt !== "string") return null;
  return value as RuntimeHostReleaseRecord;
}

export function writeRuntimeHostRelease(record: RuntimeHostReleaseRecord, filename = runtimeHostReleaseFile()): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
