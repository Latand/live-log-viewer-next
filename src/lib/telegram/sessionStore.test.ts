import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-store-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const {
  deleteTelegramSession,
  readTelegramConnection,
  readTelegramSession,
  saveTelegramSession,
  telegramConnectionPath,
  telegramSessionPath,
  writeTelegramConnection,
  UnsafeTelegramSessionError,
} = await import("./sessionStore");

/* A placeholder with the string-session shape; never a real credential. */
const PLACEHOLDER_SESSION = "1ApWapzMBu4placeholder-not-a-real-session";

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("saves the session owner-only, atomically, and reads it back", () => {
  const stored = saveTelegramSession(PLACEHOLDER_SESSION);
  expect(stored.credentialRef).toMatch(/^[0-9a-f-]{36}$/);

  const file = telegramSessionPath();
  const stat = fs.statSync(file);
  expect(stat.isFile()).toBe(true);
  expect(stat.mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  /* Atomic: no temp sibling survives the write. */
  expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp"))).toEqual([]);

  const read = readTelegramSession();
  expect(read?.sessionString).toBe(PLACEHOLDER_SESSION);
  expect(read?.credentialRef).toBe(stored.credentialRef);
});

test("a fresh save rotates the opaque credentialRef", () => {
  const first = saveTelegramSession(PLACEHOLDER_SESSION);
  const second = saveTelegramSession(PLACEHOLDER_SESSION + "-again");
  expect(second.credentialRef).not.toBe(first.credentialRef);
  expect(readTelegramSession()?.sessionString).toBe(PLACEHOLDER_SESSION + "-again");
});

test("refuses a symlinked session file instead of following it", () => {
  const target = path.join(SANDBOX, "outside.json");
  fs.writeFileSync(target, JSON.stringify({ version: 1, credentialRef: "x", sessionString: "y" }));
  fs.mkdirSync(path.dirname(telegramSessionPath()), { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, telegramSessionPath());
  expect(() => readTelegramSession()).toThrow(UnsafeTelegramSessionError);
  /* And refuses to overwrite through it. */
  expect(() => saveTelegramSession(PLACEHOLDER_SESSION)).toThrow(UnsafeTelegramSessionError);
  expect(() => deleteTelegramSession()).toThrow(UnsafeTelegramSessionError);
  expect(fs.existsSync(target)).toBe(true);
});

test("refuses a session file with group/other permission bits", () => {
  saveTelegramSession(PLACEHOLDER_SESSION);
  fs.chmodSync(telegramSessionPath(), 0o644);
  expect(() => readTelegramSession()).toThrow(UnsafeTelegramSessionError);
});

test("a symlinked telegram DIRECTORY is refused for reads and writes alike", () => {
  const outside = path.join(SANDBOX, "outside-dir");
  fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outside, "session.json"), JSON.stringify({ version: 1, credentialRef: "x", sessionString: "planted" }), { mode: 0o600 });
  const dir = path.dirname(telegramSessionPath());
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.symlinkSync(outside, dir);
  /* Read, write, and deletion all refuse the redirected directory. */
  expect(() => saveTelegramSession(PLACEHOLDER_SESSION)).toThrow(UnsafeTelegramSessionError);
  expect(() => readTelegramSession()).toThrow(UnsafeTelegramSessionError);
  expect(() => deleteTelegramSession()).toThrow(UnsafeTelegramSessionError);
  expect(fs.readdirSync(outside)).toEqual(["session.json"]);
});

test("a pre-existing group-readable telegram directory is refused", () => {
  const dir = path.dirname(telegramSessionPath());
  /* mkdir mode only applies on creation — a pre-existing 0755 boundary must
     fail closed instead of being silently accepted or rewritten. */
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  expect(() => saveTelegramSession(PLACEHOLDER_SESSION)).toThrow(UnsafeTelegramSessionError);
  expect(() => readTelegramSession()).toThrow(UnsafeTelegramSessionError);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
});

test("deletion is idempotent and leaves nothing behind", () => {
  saveTelegramSession(PLACEHOLDER_SESSION);
  deleteTelegramSession();
  deleteTelegramSession();
  expect(fs.existsSync(telegramSessionPath())).toBe(false);
  expect(readTelegramSession()).toBeNull();
});

test("connection status round-trips and never carries the session string", () => {
  writeTelegramConnection({
    version: 1,
    status: "connected",
    credentialRef: "ref-1",
    identity: { name: "Account A", username: "account_a" },
    lastHealthCheckAt: "2026-08-20T10:00:00.000Z",
    errorCode: null,
  });
  const read = readTelegramConnection();
  expect(read.status).toBe("connected");
  expect(read.identity?.name).toBe("Account A");
  expect(fs.readFileSync(telegramConnectionPath(), "utf8")).not.toContain("sessionString");
});

test("a missing or corrupt connection file reads as disconnected", () => {
  expect(readTelegramConnection().status).toBe("disconnected");
  fs.mkdirSync(path.dirname(telegramConnectionPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(telegramConnectionPath(), "{not json", { mode: 0o600 });
  expect(readTelegramConnection().status).toBe("disconnected");
});
