import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { TelegramErrorCode, TelegramIdentity } from "./contracts";

/**
 * Owner-only persistence for the Telegram credential (issue #1059).
 *
 * Two files under `<state>/telegram/`, both 0600 in a 0700 directory:
 *
 *  - `session.json` — the Telethon string session. The ONLY place the secret
 *    is at rest; nothing outside this module reads or writes it, and its value
 *    never appears in API JSON, logs, argv, or the registry.
 *  - `connection.json` — secret-free durable status (phase, opaque
 *    credentialRef, sanitized identity, last health check), which is what the
 *    status API projects from.
 *
 * Reads and writes both go through the same safety fence: the path must be a
 * regular, non-symlinked file with no group/other permission bits, and writes
 * land atomically (tmp + fsync + rename) so a crash never leaves a partial
 * secret or a widened mode on disk.
 */

const DIR_NAME = "telegram";
const SESSION_FILE = "session.json";
const CONNECTION_FILE = "connection.json";

export type StoredTelegramSession = {
  version: 1;
  credentialRef: string;
  sessionString: string;
  savedAt: string;
};

export type TelegramConnectionStatus = "disconnected" | "connected" | "expired" | "error";

export type StoredTelegramConnection = {
  version: 1;
  status: TelegramConnectionStatus;
  credentialRef: string | null;
  identity: TelegramIdentity | null;
  lastHealthCheckAt: string | null;
  errorCode: TelegramErrorCode | null;
};

export class UnsafeTelegramSessionError extends Error {
  constructor(detail: string) {
    super(`Telegram session storage is unsafe: ${detail}`);
    this.name = "UnsafeTelegramSessionError";
  }
}

function telegramDir(): string {
  return statePath(DIR_NAME);
}

export function telegramSessionPath(): string {
  return path.join(telegramDir(), SESSION_FILE);
}

export function telegramConnectionPath(): string {
  return path.join(telegramDir(), CONNECTION_FILE);
}

/** The fence every read and overwrite passes: regular file, not a symlink, no
    group/other bits, owned by this process's uid. Anything else is treated as
    tampering, never silently accepted. */
function assertSafeSecretFile(pathname: string): void {
  const stat = fs.lstatSync(pathname);
  if (stat.isSymbolicLink()) throw new UnsafeTelegramSessionError("symlink");
  if (!stat.isFile()) throw new UnsafeTelegramSessionError("not a regular file");
  if ((stat.mode & 0o077) !== 0) throw new UnsafeTelegramSessionError("permissions are wider than owner-only");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new UnsafeTelegramSessionError("not owned by this user");
  }
}

function atomicSecretWrite(pathname: string, contents: string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  try {
    assertSafeSecretFile(pathname);
  } catch (error) {
    if (error instanceof UnsafeTelegramSessionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tmp = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    const fd = fs.openSync(tmp, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, pathname);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readSafeJson(pathname: string): unknown | null {
  try {
    assertSafeSecretFile(pathname);
  } catch (error) {
    if (error instanceof UnsafeTelegramSessionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

/** Persists the enrolled session and returns the opaque reference every other
    surface uses to talk about it. */
export function saveTelegramSession(sessionString: string): StoredTelegramSession {
  if (!sessionString) throw new Error("Telegram session string is empty");
  const stored: StoredTelegramSession = {
    version: 1,
    credentialRef: crypto.randomUUID(),
    sessionString,
    savedAt: new Date().toISOString(),
  };
  atomicSecretWrite(telegramSessionPath(), JSON.stringify(stored));
  return stored;
}

export function readTelegramSession(): StoredTelegramSession | null {
  const parsed = readSafeJson(telegramSessionPath());
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Partial<StoredTelegramSession>;
  if (row.version !== 1 || typeof row.credentialRef !== "string" || typeof row.sessionString !== "string" || !row.sessionString) return null;
  return row as StoredTelegramSession;
}

export function deleteTelegramSession(): void {
  fs.rmSync(telegramSessionPath(), { force: true });
}

const DISCONNECTED: StoredTelegramConnection = {
  version: 1,
  status: "disconnected",
  credentialRef: null,
  identity: null,
  lastHealthCheckAt: null,
  errorCode: null,
};

export function readTelegramConnection(): StoredTelegramConnection {
  const parsed = readSafeJson(telegramConnectionPath());
  if (!parsed || typeof parsed !== "object") return { ...DISCONNECTED };
  const row = parsed as Partial<StoredTelegramConnection>;
  if (row.version !== 1 || typeof row.status !== "string") return { ...DISCONNECTED };
  return {
    version: 1,
    status: row.status as TelegramConnectionStatus,
    credentialRef: typeof row.credentialRef === "string" ? row.credentialRef : null,
    identity: row.identity && typeof row.identity === "object" && typeof (row.identity as TelegramIdentity).name === "string"
      ? { name: (row.identity as TelegramIdentity).name, username: (row.identity as TelegramIdentity).username ?? null }
      : null,
    lastHealthCheckAt: typeof row.lastHealthCheckAt === "string" ? row.lastHealthCheckAt : null,
    errorCode: typeof row.errorCode === "string" ? row.errorCode as TelegramErrorCode : null,
  };
}

export function writeTelegramConnection(connection: StoredTelegramConnection): void {
  atomicSecretWrite(telegramConnectionPath(), JSON.stringify(connection));
}

export function clearTelegramConnection(): void {
  fs.rmSync(telegramConnectionPath(), { force: true });
}
