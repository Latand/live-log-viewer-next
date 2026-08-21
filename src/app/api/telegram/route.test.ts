import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-route-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
/* #1070: credentials writes resolve through XDG config; point them at the
   sandbox so the test never touches (or reads) the operator's telegram.json. */
const OLD_XDG = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");

/* Env credentials would take precedence over the sandbox file; scrub them so
   the file-backed path is the one under test. */
const OLD_API_ID = process.env.LLV_TELEGRAM_API_ID;
const OLD_API_HASH = process.env.LLV_TELEGRAM_API_HASH;
delete process.env.LLV_TELEGRAM_API_ID;
delete process.env.LLV_TELEGRAM_API_HASH;

const { GET, POST } = await import("./route");
const { TelegramConnectionService, setTelegramServiceForTests } = await import("@/lib/telegram/service");
const { readTelegramSession, writeTelegramConnection } = await import("@/lib/telegram/sessionStore");
const { confirmConnectorRestart, recordConnectorCrash } = await import("@/lib/telegram/connectorRestarts");

/* A completed restart: a detected death whose replacement then verified. The
   two-step API is what the supervisor drives; tests that only need the settled
   result say it in one line. */
function recordCompletedRestart(crash: { exitCode: number | null; signal: string | null }, at: number): void {
  recordConnectorCrash(crash, at);
  confirmConnectorRestart();
}

const { telegramApiCredentials } = await import("@/lib/telegram/packaging");

import type { TelegramAdapter, TelegramEnrollmentEvent, TelegramHealthResult } from "@/lib/telegram/adapter";
import type { TelegramErrorCode } from "@/lib/telegram/contracts";

/* A placeholder with the string-session shape; never a real credential. */
const PLACEHOLDER_SESSION = "1ApWapzMBu4placeholder-not-a-real-session";

class FakeAdapter implements TelegramAdapter {
  emit: ((event: TelegramEnrollmentEvent) => void) | null = null;
  canceled = 0;
  passwords: string[] = [];
  health: TelegramHealthResult = { status: "connected", identity: { name: "Account A", username: "account_a" } };
  healthCalls = 0;
  logoutResult: { ok: boolean; code: TelegramErrorCode | null } = { ok: true, code: null };
  unavailableReason() { return null; }
  startEnrollment(onEvent: (event: TelegramEnrollmentEvent) => void) {
    this.emit = onEvent;
    return {
      submitPassword: (password: string) => { this.passwords.push(password); },
      cancel: () => { this.canceled += 1; },
    };
  }
  checkSession() { this.healthCalls += 1; return Promise.resolve(this.health); }
  logout() { return Promise.resolve(this.logoutResult); }
}

let adapter = new FakeAdapter();

function installService() {
  adapter = new FakeAdapter();
  setTelegramServiceForTests(new TelegramConnectionService({
    adapter,
    ensureConnector: async () => ({ ok: true, url: "http://127.0.0.1:8809/mcp" }),
    stopConnector: () => {},
    registerHosts: () => ({
      ok: true,
      claude: { registered: 1, conflict: 0, unwritable: 0 },
      codex: { registered: 1, failed: 0 },
    }),
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    /* The sandboxed real resolver: env is scrubbed below, so this reflects the
       sandbox telegram.json exactly — what the credentials tests assert on. */
    credentialsConfigured: () => telegramApiCredentials() !== null,
  }));
}

function getRequest(query = "", headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/telegram${query}`, { headers: { host: "127.0.0.1", ...headers } });
}

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1/api/telegram", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  installService();
});
afterAll(() => {
  setTelegramServiceForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = OLD_XDG;
  if (OLD_API_ID !== undefined) process.env.LLV_TELEGRAM_API_ID = OLD_API_ID;
  if (OLD_API_HASH !== undefined) process.env.LLV_TELEGRAM_API_HASH = OLD_API_HASH;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("GET reports the disconnected baseline", async () => {
  const response = await GET(getRequest());
  expect(response.status).toBe(200);
  const { telegram } = await payload(response) as { telegram: { phase: string } };
  expect(telegram.phase).toBe("disconnected");
});

test("the login round trip over the narrow API, without a session string ever crossing", async () => {
  const started = await POST(postRequest({ action: "start" }));
  expect(started.status).toBe(202);
  const body = await payload(started) as { telegram: { phase: string; login: { operationId: string } } };
  expect(body.telegram.phase).toBe("starting");
  const operationId = body.telegram.login.operationId;

  adapter.emit!({ type: "qr", url: "tg://login?token=abc", expiresAt: "2026-08-20T12:00:30.000Z" });
  const scanning = await GET(getRequest());
  const scanBody = await payload(scanning);
  expect((scanBody as { telegram: { phase: string } }).telegram.phase).toBe("awaiting_scan");
  expect(JSON.stringify(scanBody)).toContain("tg://login?token=abc");

  adapter.emit!({ type: "password_required" });
  const submitted = await POST(postRequest({ action: "password", operationId, password: "2fa-pw" }));
  expect(submitted.status).toBe(200);
  expect(adapter.passwords).toEqual(["2fa-pw"]);

  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: "account_a" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const connected = await GET(getRequest());
  const connectedBody = await payload(connected);
  const text = JSON.stringify(connectedBody);
  expect((connectedBody as { telegram: { phase: string } }).telegram.phase).toBe("connected");
  /* The secret-leak assertion: the session reached the store, and NOTHING the
     API returned along the way carried it. */
  const stored = readTelegramSession();
  expect(stored?.sessionString).toBe(PLACEHOLDER_SESSION);
  expect(text).not.toContain(PLACEHOLDER_SESSION);
  expect(text).not.toContain(stored!.connectorToken);
  /* The password is spent, not echoed. */
  expect(text).not.toContain("2fa-pw");
});

test("cancel and delete round-trip; delete works with no remote logout", async () => {
  const started = await POST(postRequest({ action: "start" }));
  const { telegram } = await payload(started) as { telegram: { login: { operationId: string } } };
  const canceled = await POST(postRequest({ action: "cancel", operationId: telegram.login.operationId }));
  expect((await payload(canceled) as { telegram: { phase: string } }).telegram.phase).toBe("disconnected");
  expect(adapter.canceled).toBe(1);

  const deleted = await POST(postRequest({ action: "delete" }));
  expect((await payload(deleted) as { telegram: { phase: string } }).telegram.phase).toBe("disconnected");
});

test("a failed remote logout keeps the local session and says so", async () => {
  adapter.logoutResult = { ok: false, code: "network_failed" };
  await POST(postRequest({ action: "start" }));
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = await POST(postRequest({ action: "logout" }));
  const { telegram } = await payload(response) as { telegram: { phase: string; error: { code: string } } };
  expect(telegram.phase).toBe("error");
  expect(telegram.error.code).toBe("network_failed");
  expect(readTelegramSession()).not.toBeNull();
});

test("the API is narrow: unknown actions and malformed bodies are rejected", async () => {
  expect((await POST(postRequest({ action: "export_history" }))).status).toBe(400);
  expect((await POST(postRequest({ action: "password" }))).status).toBe(400);
  expect((await POST(postRequest({ action: "cancel" }))).status).toBe(400);
  const second = await POST(postRequest({ action: "start" }));
  expect(second.status).toBe(202);
  expect((await POST(postRequest({ action: "start" }))).status).toBe(409);
});

const CREDS_FILE = path.join(SANDBOX, "config", "agent-log-viewer", "telegram.json");
/* Placeholder shapes only — a real api_hash never appears in this repo. */
const PLACEHOLDER_API_ID = "1234567";
const PLACEHOLDER_API_HASH = "0123456789abcdef0123456789abcdef";

test("#1070: valid credentials persist owner-only into telegram.json and the payload stays hash-free", async () => {
  fs.rmSync(CREDS_FILE, { force: true });
  const response = await POST(postRequest({ action: "credentials", apiId: PLACEHOLDER_API_ID, apiHash: PLACEHOLDER_API_HASH }));
  expect(response.status).toBe(200);
  const body = await payload(response);
  expect(JSON.stringify(body)).not.toContain(PLACEHOLDER_API_HASH);
  const telegram = body.telegram as { credentialsConfigured: boolean };
  expect(telegram.credentialsConfigured).toBe(true);
  const stat = fs.statSync(CREDS_FILE);
  expect(stat.mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"))).toEqual({ apiId: PLACEHOLDER_API_ID, apiHash: PLACEHOLDER_API_HASH });
  const fresh = await payload(await GET(getRequest()));
  expect(JSON.stringify(fresh)).not.toContain(PLACEHOLDER_API_HASH);
  expect((fresh.telegram as { credentialsConfigured: boolean }).credentialsConfigured).toBe(true);
});

test("#1070: a save clears a stale credentials_missing error and leaves no temp files or log leaks", async () => {
  fs.rmSync(CREDS_FILE, { force: true });
  /* The durable connection says the world lacks credentials. */
  const { writeTelegramConnection } = await import("@/lib/telegram/sessionStore");
  writeTelegramConnection({ version: 1, status: "error", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: "credentials_missing" });
  const logged: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error } as const;
  console.log = console.warn = console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let telegram: { phase: string; error: unknown };
  try {
    const response = await POST(postRequest({ action: "credentials", apiId: PLACEHOLDER_API_ID, apiHash: PLACEHOLDER_API_HASH }));
    telegram = (await payload(response)).telegram as typeof telegram;
  } finally {
    console.log = originals.log; console.warn = originals.warn; console.error = originals.error;
  }
  /* The stale error yields to the normal Connect state. */
  expect(telegram.phase).toBe("disconnected");
  expect(telegram.error).toBeNull();
  /* Nothing logged the hash, and no temp sibling survived the write. */
  expect(logged.join("\n")).not.toContain(PLACEHOLDER_API_HASH);
  const siblings = fs.readdirSync(path.dirname(CREDS_FILE)).filter((name) => name !== "telegram.json");
  expect(siblings).toEqual([]);
});

test("#1070: a symlinked telegram.json is replaced, never written through", async () => {
  fs.rmSync(CREDS_FILE, { force: true });
  const outside = path.join(SANDBOX, "outside-target.json");
  fs.writeFileSync(outside, "untouched");
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.symlinkSync(outside, CREDS_FILE);
  const response = await POST(postRequest({ action: "credentials", apiId: PLACEHOLDER_API_ID, apiHash: PLACEHOLDER_API_HASH }));
  expect(response.status).toBe(200);
  /* The rename replaced the symlink with a regular owner-only file; the
     symlink's target never received a byte. */
  expect(fs.lstatSync(CREDS_FILE).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
  expect(fs.statSync(CREDS_FILE).mode & 0o777).toBe(0o600);
});

test("#1070: invalid credentials are rejected before any byte is written", async () => {
  fs.rmSync(CREDS_FILE, { force: true });
  for (const attempt of [
    { apiId: "not-a-number", apiHash: PLACEHOLDER_API_HASH },
    { apiId: PLACEHOLDER_API_ID, apiHash: "too-short" },
    { apiId: PLACEHOLDER_API_ID },
    { apiHash: PLACEHOLDER_API_HASH },
  ]) {
    const response = await POST(postRequest({ action: "credentials", ...attempt }));
    expect(response.status).toBe(400);
    expect((await payload(response)).code).toBe("invalid_credentials");
  }
  expect(fs.existsSync(CREDS_FILE)).toBe(false);
  const status = await payload(await GET(getRequest()));
  expect((status.telegram as { credentialsConfigured: boolean }).credentialsConfigured).toBe(false);
});

test("cross-origin mutation attempts are rejected", async () => {
  const response = await POST(postRequest({ action: "start" }, { origin: "https://evil.example" }));
  expect(response.status).toBe(403);
});

test("cross-origin fresh health is rejected before Telegram state changes", async () => {
  const response = await GET(getRequest("?fresh=1", { origin: "https://example.test" }));
  expect(response.status).toBe(403);
  expect(adapter.healthCalls).toBe(0);
});

test("#1087: the status payload carries the restart row and the transient restarting phase", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  writeTelegramConnection({
    version: 1,
    status: "connected",
    credentialRef: "credential-generation-a",
    identity: { name: "Account A", username: "account_a" },
    lastHealthCheckAt: new Date(now).toISOString(),
    errorCode: null,
  });
  recordCompletedRestart({ exitCode: null, signal: "SIGKILL" }, now - 5_000);
  const { telegram } = await payload(await GET(getRequest())) as {
    telegram: { phase: string; restartsLast24h: number; lastRestartAt: string };
  };
  expect(telegram.phase).toBe("restarting");
  expect(telegram.restartsLast24h).toBe(1);
  expect(telegram.lastRestartAt).toBe(new Date(now - 5_000).toISOString());
  /* Counts and a timestamp only: the crash record itself stays server-side. */
  expect(JSON.stringify(telegram)).not.toContain("exitCode");
  expect(JSON.stringify(telegram)).not.toContain("signal");
});
