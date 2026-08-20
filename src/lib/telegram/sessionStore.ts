import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readValidatedTelegramSessionFiles } from "../../../bin/telegram-session-validator.mjs";

import { statePath } from "@/lib/configDir";

import type { TelegramErrorCode, TelegramIdentity } from "./contracts";

/**
 * Owner-only persistence for the Telegram credential (issue #1059).
 *
 * Three files under `<state>/telegram/`, all 0600 in a 0700 directory:
 *
 *  - `session.json` — the Telethon string session. The ONLY place the secret
 *    is at rest; nothing outside this module reads or writes it, and its value
 *    never appears in API JSON, logs, argv, or the registry.
 *  - `connector-token` — per-credential bearer capability for the local MCP
 *    endpoint. The session file stores only its digest.
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
const CONNECTOR_TOKEN_FILE = "connector-token";
const CONNECTION_FILE = "connection.json";
export const TELEGRAM_CONNECTOR_TOKEN_ENV = "LLV_TELEGRAM_MCP_TOKEN";

export type StoredTelegramSession = {
  version: 1;
  credentialRef: string;
  connectorToken: string;
  sessionString: string;
  savedAt: string;
};

type StoredTelegramSessionFile = Omit<StoredTelegramSession, "connectorToken"> & { connectorTokenSha256: string };

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

export function telegramConnectorTokenPath(): string {
  return path.join(telegramDir(), CONNECTOR_TOKEN_FILE);
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

/**
 * The same fence for the directory HOLDING the secrets — mkdir's mode applies
 * only on creation, so a pre-existing telegram dir is validated every time:
 * it must be a real directory (never a symlink pointing the secret write
 * elsewhere), owned by this uid, with no group/other bits. Every mismatch is
 * refused so reads and overwrites share the same fail-closed boundary. The
 * state-dir root above it stays the app-wide boundary it already is — this
 * fences the component this module creates.
 */
export function ensureTelegramStateDir(create = true): string | null {
  const dir = statePath(DIR_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(dir);
  }
  if (stat.isSymbolicLink()) throw new UnsafeTelegramSessionError("telegram directory is a symlink");
  if (!stat.isDirectory()) throw new UnsafeTelegramSessionError("telegram directory is not a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new UnsafeTelegramSessionError("telegram directory is not owned by this user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UnsafeTelegramSessionError("telegram directory permissions are wider than owner-only");
  }
  return dir;
}

function atomicSecretWrite(pathname: string, contents: string): void {
  ensureTelegramStateDir(true);
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

function readSafeJson(pathname: string, corruptIsUnsafe = false): unknown | null {
  if (ensureTelegramStateDir(false) === null) return null;
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
    if (corruptIsUnsafe) throw new UnsafeTelegramSessionError(`cannot read ${path.basename(pathname)}`);
    return null;
  }
}

function safeFileExists(pathname: string): boolean {
  try {
    assertSafeSecretFile(pathname);
    return true;
  } catch (error) {
    if (error instanceof UnsafeTelegramSessionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeSafeFile(pathname: string): void {
  if (ensureTelegramStateDir(false) === null || !safeFileExists(pathname)) return;
  fs.rmSync(pathname);
}

function existingSafeSecretContents(pathname: string): string | null {
  try {
    assertSafeSecretFile(pathname);
  } catch (error) {
    if (error instanceof UnsafeTelegramSessionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return fs.readFileSync(pathname, "utf8");
}

/** Persists the enrolled session and returns the opaque reference every other
    surface uses to talk about it. */
export function saveTelegramSession(sessionString: string): StoredTelegramSession {
  if (!sessionString) throw new Error("Telegram session string is empty");
  ensureTelegramStateDir(true);
  /* Validate and read BOTH existing files before committing either new value.
     A refused session overwrite therefore cannot rotate or delete the token
     that its preserved JSON still references. */
  const previousSession = existingSafeSecretContents(telegramSessionPath());
  const previousToken = existingSafeSecretContents(telegramConnectorTokenPath());
  if (previousSession !== null || previousToken !== null) {
    const existing = readValidatedTelegramSessionFiles(telegramDir());
    if (existing.status !== "valid") {
      throw new UnsafeTelegramSessionError(existing.status === "unsafe" ? existing.detail : "existing session pair is incomplete");
    }
  }
  const connectorToken = crypto.randomBytes(32).toString("base64url");
  const stored: StoredTelegramSession = {
    version: 1,
    credentialRef: crypto.randomUUID(),
    connectorToken,
    sessionString,
    savedAt: new Date().toISOString(),
  };
  const persisted: StoredTelegramSessionFile = {
    version: stored.version,
    credentialRef: stored.credentialRef,
    sessionString: stored.sessionString,
    savedAt: stored.savedAt,
    connectorTokenSha256: crypto.createHash("sha256").update(connectorToken).digest("hex"),
  };
  atomicSecretWrite(telegramConnectorTokenPath(), connectorToken + "\n");
  try {
    atomicSecretWrite(telegramSessionPath(), JSON.stringify(persisted));
  } catch (error) {
    try {
      if (previousToken === null) removeSafeFile(telegramConnectorTokenPath());
      else atomicSecretWrite(telegramConnectorTokenPath(), previousToken);
    } catch { /* preserve the original session error; storage remains fail-closed */ }
    throw error;
  }
  return stored;
}

function readTelegramSessionUnchecked(): StoredTelegramSession | null {
  const result = readValidatedTelegramSessionFiles(telegramDir());
  if (result.status === "missing") return null;
  if (result.status === "unsafe") throw new UnsafeTelegramSessionError(result.detail);
  const row = result.sessionFile;
  return { version: 1, credentialRef: row.credentialRef, connectorToken: result.connectorToken, sessionString: row.sessionString, savedAt: row.savedAt };
}

export function readTelegramSession(): StoredTelegramSession | null {
  try {
    return readTelegramSessionUnchecked();
  } catch (error) {
    if (error instanceof UnsafeTelegramSessionError) throw error;
    throw new UnsafeTelegramSessionError("cannot read session storage");
  }
}

export function deleteTelegramSession(): void {
  if (ensureTelegramStateDir(false) === null) return;
  const paths = [telegramSessionPath(), telegramConnectorTokenPath()];
  const existing = paths.filter((pathname) => safeFileExists(pathname));
  for (const pathname of existing) fs.rmSync(pathname);
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
  removeSafeFile(telegramConnectionPath());
}
