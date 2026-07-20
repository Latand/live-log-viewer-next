import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { procBackend } from "@/lib/proc";

export interface WakatimeSchedulerLease {
  isHeld(): boolean;
  release(): void;
}

interface LeaseOwner {
  pid: number;
  startIdentity: string | null;
  token: string;
}

const INVALID_OWNER_STALE_MS = 30_000;

function readOwner(filename: string): LeaseOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<LeaseOwner>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0
      || !(value.startIdentity === null || typeof value.startIdentity === "string")
      || typeof value.token !== "string" || value.token.length === 0) return null;
    return value as LeaseOwner;
  } catch {
    return null;
  }
}

function ownerIsStale(filename: string): boolean {
  const owner = readOwner(filename);
  if (!owner) {
    try { return Date.now() - fs.statSync(filename).mtimeMs > INVALID_OWNER_STALE_MS; }
    catch { return false; }
  }
  if (!procBackend.pidAlive(owner.pid)) return true;
  if (owner.startIdentity === null) return false;
  const currentIdentity = procBackend.processIdentity(owner.pid);
  return currentIdentity !== null && currentIdentity !== owner.startIdentity;
}

function writeOwner(filename: string, owner: LeaseOwner): boolean {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filename, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(filename, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  return true;
}

function removeOwnedFile(filename: string, token: string): void {
  if (readOwner(filename)?.token === token) fs.rmSync(filename, { force: true });
}

function recoveryIsStale(directory: string): boolean {
  const ownerFile = path.join(directory, "owner.json");
  if (readOwner(ownerFile)) return ownerIsStale(ownerFile);
  try { return Date.now() - fs.statSync(directory).mtimeMs > INVALID_OWNER_STALE_MS; }
  catch { return false; }
}

function claimRecoveryDirectory(directory: string, owner: LeaseOwner): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      if (!writeOwner(path.join(directory, "owner.json"), owner)) throw new Error("scheduler recovery owner already exists");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!recoveryIsStale(directory)) return false;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  return false;
}

function releaseRecoveryDirectory(directory: string, token: string): void {
  if (readOwner(path.join(directory, "owner.json"))?.token === token) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function acquireWakatimeSchedulerLease(filename: string): WakatimeSchedulerLease | null {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const recoveryDirectory = `${filename}.recovery`;
  const owner: LeaseOwner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  if (!claimRecoveryDirectory(recoveryDirectory, owner)) return null;
  let acquired = false;
  try {
    acquired = writeOwner(filename, owner);
    if (!acquired && ownerIsStale(filename)) {
      fs.rmSync(filename, { force: true });
      acquired = writeOwner(filename, owner);
    }
  } finally {
    releaseRecoveryDirectory(recoveryDirectory, owner.token);
  }
  if (!acquired) return null;

  let held = true;
  return {
    isHeld() {
      if (!held || readOwner(filename)?.token !== owner.token) held = false;
      return held;
    },
    release() {
      if (held) removeOwnedFile(filename, owner.token);
      held = false;
    },
  };
}
