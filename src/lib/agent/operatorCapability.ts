import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

const OPERATOR_SPAWN_CAPABILITY_FILE = "operator-spawn-capability";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class OperatorSpawnCapabilityError extends Error {
  constructor(operation: "read" | "write", filename: string, cause: unknown) {
    const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? ` (${cause.code})`
      : "";
    super(`Viewer operator spawn capability ${operation} failed at ${filename}${code}`);
    this.name = "OperatorSpawnCapabilityError";
  }
}

export function operatorSpawnCapabilityPath(): string {
  return statePath(OPERATOR_SPAWN_CAPABILITY_FILE);
}

function writeOperatorSpawnCapability(capability: string): void {
  const filename = operatorSpawnCapabilityPath();
  const directory = path.dirname(filename);
  let temporary: string | null = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${capability}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filename);
  } catch (error) {
    throw new OperatorSpawnCapabilityError("write", filename, error);
  } finally {
    if (temporary) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch (error) {
        throw new OperatorSpawnCapabilityError("write", filename, error);
      }
    }
  }
}

function readOperatorSpawnCapability(): string | null {
  const filename = operatorSpawnCapabilityPath();
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const capability = fs.readFileSync(filename, "utf8").trim();
    if (!CAPABILITY_PATTERN.test(capability)) return null;
    if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(filename, 0o600);
    return capability;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw new OperatorSpawnCapabilityError("read", filename, error);
  }
}

export function rotateOperatorSpawnCapability(): string {
  const capability = crypto.randomBytes(32).toString("base64url");
  writeOperatorSpawnCapability(capability);
  return capability;
}

export function ensureOperatorSpawnCapability(): string {
  return readOperatorSpawnCapability() ?? rotateOperatorSpawnCapability();
}

export function matchesOperatorSpawnCapability(candidate: string): boolean {
  if (!CAPABILITY_PATTERN.test(candidate)) return false;
  const expected = readOperatorSpawnCapability();
  if (!expected) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
