import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-service-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { TelegramConnectionService } = await import("./service");
const { readTelegramSession, saveTelegramSession, telegramSessionPath } = await import("./sessionStore");

import type { TelegramAdapter, TelegramEnrollmentEvent, TelegramHealthResult } from "./adapter";
import type { TelegramErrorCode } from "./contracts";
import type { TelegramServicePorts } from "./service";

/* A placeholder with the string-session shape; never a real credential. */
const PLACEHOLDER_SESSION = "1ApWapzMBu4placeholder-not-a-real-session";
const HOSTS_REGISTERED = {
  ok: true,
  claude: { registered: 1, conflict: 0, unwritable: 0 },
  codex: { registered: 1, failed: 0 },
};

/** The fake Telegram: scripted events in, recorded calls out. No test in this
    repo ever reaches a real account. */
class FakeAdapter implements TelegramAdapter {
  emit: ((event: TelegramEnrollmentEvent) => void) | null = null;
  started = 0;
  canceled = 0;
  passwords: string[] = [];
  unavailable: TelegramErrorCode | null = null;
  health: TelegramHealthResult = { status: "connected", identity: { name: "Account A", username: "account_a" } };
  healthPromise: Promise<TelegramHealthResult> | null = null;
  logoutResult: { ok: boolean; code: TelegramErrorCode | null } = { ok: true, code: null };
  logoutCalls = 0;

  unavailableReason() { return this.unavailable; }
  startEnrollment(onEvent: (event: TelegramEnrollmentEvent) => void) {
    this.started += 1;
    this.emit = onEvent;
    return {
      submitPassword: (password: string) => { this.passwords.push(password); },
      cancel: () => { this.canceled += 1; },
    };
  }
  checkSession() { return this.healthPromise ?? Promise.resolve(this.health); }
  logout() { this.logoutCalls += 1; return Promise.resolve(this.logoutResult); }
}

function harness() {
  const adapter = new FakeAdapter();
  const calls = { ensure: [] as string[], stop: 0, register: 0, unregister: 0, order: [] as string[] };
  const ports: TelegramServicePorts = {
    adapter,
    ensureConnector: async (session) => {
      calls.ensure.push(session.sessionString);
      calls.order.push("ensure");
      return { ok: true, url: "http://127.0.0.1:8809/mcp" };
    },
    stopConnector: () => { calls.stop += 1; },
    registerHosts: () => { calls.register += 1; calls.order.push("register"); return HOSTS_REGISTERED; },
    unregisterHosts: () => { calls.unregister += 1; },
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  };
  return { adapter, calls, service: new TelegramConnectionService(ports) };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("the full QR login without 2FA: scan refresh, verify, connect", async () => {
  const { adapter, calls, service } = harness();
  expect(service.status().phase).toBe("disconnected");

  const started = service.startLogin();
  expect(started.phase).toBe("starting");
  expect(adapter.started).toBe(1);

  adapter.emit!({ type: "qr", url: "tg://login?token=first", expiresAt: "2026-08-20T12:00:30.000Z" });
  let status = service.status();
  expect(status.phase).toBe("awaiting_scan");
  expect(status.login?.qr?.url).toBe("tg://login?token=first");

  /* An expired token refreshes in place — same operation, new QR. */
  adapter.emit!({ type: "qr", url: "tg://login?token=second", expiresAt: "2026-08-20T12:01:00.000Z" });
  status = service.status();
  expect(status.login?.qr?.url).toBe("tg://login?token=second");

  adapter.emit!({ type: "verifying" });
  expect(service.status().phase).toBe("verifying");

  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: "account_a" } });
  /* Authorization alone does NOT publish connected — the operation stays in
     verifying until the connector's read-only surface stands verified. */
  expect(service.status().phase).toBe("verifying");
  await settle();
  status = service.status();
  expect(status.phase).toBe("connected");
  expect(status.identity?.name).toBe("Account A");
  expect(status.credentialRef).toMatch(/^[0-9a-f-]{36}$/);

  /* The credential landed owner-only; the connector was verified BEFORE any
     host registration happened. */
  expect(readTelegramSession()?.sessionString).toBe(PLACEHOLDER_SESSION);
  expect(fs.statSync(telegramSessionPath()).mode & 0o777).toBe(0o600);
  expect(calls.ensure).toEqual([PLACEHOLDER_SESSION]);
  expect(calls.order).toEqual(["ensure", "register"]);
});

test("the session string never appears in any status payload", async () => {
  const { adapter, service } = harness();
  service.startLogin();
  adapter.emit!({ type: "qr", url: "tg://login?token=x", expiresAt: "2026-08-20T12:00:30.000Z" });
  expect(JSON.stringify(service.status())).not.toContain(PLACEHOLDER_SESSION);
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  await settle();
  expect(JSON.stringify(service.status())).not.toContain(PLACEHOLDER_SESSION);
});

test("2FA: password phase, invalid retry, then success", async () => {
  const { adapter, service } = harness();
  const { login } = service.startLogin();
  adapter.emit!({ type: "qr", url: "tg://login?token=x", expiresAt: "2026-08-20T12:00:30.000Z" });
  adapter.emit!({ type: "password_required" });
  let status = service.status();
  expect(status.phase).toBe("awaiting_password");
  expect(status.login?.qr).toBeNull();

  service.submitPassword(login!.operationId, "first-guess");
  expect(service.status().phase).toBe("verifying");
  expect(adapter.passwords).toEqual(["first-guess"]);

  /* Telegram rejects it: explicit invalid-password state, still in the op. */
  adapter.emit!({ type: "password_invalid" });
  status = service.status();
  expect(status.phase).toBe("awaiting_password");
  expect(status.login?.passwordError).toBe(true);

  service.submitPassword(login!.operationId, "correct");
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  await settle();
  expect(service.status().phase).toBe("connected");
});

test("one login operation at a time", () => {
  const { adapter, service } = harness();
  service.startLogin();
  expect(() => service.startLogin()).toThrow("already running");
  expect(adapter.started).toBe(1);
});

test("cancel terminates the enrollment and clears temporary state", () => {
  const { adapter, service } = harness();
  const { login } = service.startLogin();
  adapter.emit!({ type: "qr", url: "tg://login?token=x", expiresAt: "2026-08-20T12:00:30.000Z" });
  const status = service.cancelLogin(login!.operationId);
  expect(adapter.canceled).toBe(1);
  expect(status.phase).toBe("disconnected");
  expect(status.login).toBeNull();
  /* Canceled is not an error: a retry starts clean. */
  expect(service.startLogin().phase).toBe("starting");
});

test("a network failure lands in an explicit error state with a sanitized code", () => {
  const { adapter, service } = harness();
  service.startLogin();
  adapter.emit!({ type: "failed", code: "network_failed" });
  const status = service.status();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("network_failed");
  /* Retry is a fresh start. */
  expect(service.startLogin().phase).toBe("starting");
});

test("unconfigured host credentials refuse the login with an explicit code", () => {
  const { adapter, service } = harness();
  adapter.unavailable = "credentials_missing";
  const status = service.startLogin();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("credentials_missing");
});

test("health: connected refreshes identity and re-ensures the connector", async () => {
  const { calls, service } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  const status = await service.checkHealth();
  expect(status.phase).toBe("connected");
  expect(status.identity?.username).toBe("account_a");
  expect(status.lastHealthCheckAt).toBe("2026-08-20T12:00:00.000Z");
  await settle();
  expect(calls.ensure).toEqual([PLACEHOLDER_SESSION]);
});

test("health recovery registers hosts after a prior connector failure", async () => {
  const { adapter } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  let attempts = 0;
  let registrations = 0;
  const recovering = new TelegramConnectionService({
    adapter,
    ensureConnector: async () => (++attempts === 1
      ? { ok: false, code: "connector_failed" }
      : { ok: true, url: "http://127.0.0.1:8809/mcp" }),
    stopConnector: () => {},
    registerHosts: () => { registrations += 1; return HOSTS_REGISTERED; },
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });

  expect((await recovering.checkHealth()).phase).toBe("error");
  expect(registrations).toBe(0);
  expect((await recovering.checkHealth()).phase).toBe("connected");
  expect(registrations).toBe(1);
});

test("health releases the shared connector before the session bridge connects", async () => {
  const adapter = new FakeAdapter();
  const order: string[] = [];
  adapter.checkSession = async () => {
    order.push("health");
    return { status: "connected", identity: { name: "Account A", username: null } };
  };
  saveTelegramSession(PLACEHOLDER_SESSION);
  const service = new TelegramConnectionService({
    adapter,
    stopConnector: () => { order.push("stop"); },
    ensureConnector: async () => { order.push("ensure"); return { ok: true, url: "http://127.0.0.1:8809/mcp" }; },
    registerHosts: () => { order.push("register"); return HOSTS_REGISTERED; },
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });

  expect((await service.checkHealth()).phase).toBe("connected");
  expect(order).toEqual(["stop", "health", "ensure", "register"]);
});

test("health: a session Telegram revoked reads as expired and stops the connector", async () => {
  const { adapter, calls, service } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  adapter.health = { status: "expired" };
  const status = await service.checkHealth();
  expect(status.phase).toBe("expired");
  expect(calls.stop).toBe(1);
  /* The stored session survives — Reconnect and local deletion stay offered. */
  expect(readTelegramSession()).not.toBeNull();
});

test("health: a probe failure is an explicit error, not a silent disconnect", async () => {
  const { adapter, service } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  adapter.health = { status: "error", code: "network_failed" };
  const status = await service.checkHealth();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("network_failed");
  expect(readTelegramSession()).not.toBeNull();
});

test("remote logout removes the local session, stops the connector, unregisters hosts", async () => {
  const { adapter, calls, service } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  const status = await service.logout();
  expect(adapter.logoutCalls).toBe(1);
  expect(status.phase).toBe("disconnected");
  expect(readTelegramSession()).toBeNull();
  expect(calls.stop).toBe(2);
  expect(calls.unregister).toBe(1);
});

test("remote logout releases the shared connector before the session bridge connects", async () => {
  const adapter = new FakeAdapter();
  const order: string[] = [];
  adapter.logout = async () => { order.push("logout"); return { ok: true, code: null }; };
  saveTelegramSession(PLACEHOLDER_SESSION);
  const service = new TelegramConnectionService({
    adapter,
    stopConnector: () => { order.push("stop"); },
    ensureConnector: async () => ({ ok: true, url: "http://127.0.0.1:8809/mcp" }),
    registerHosts: () => HOSTS_REGISTERED,
    unregisterHosts: () => { order.push("unregister"); },
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });

  expect((await service.logout()).phase).toBe("disconnected");
  expect(order[0]).toBe("stop");
  expect(order.indexOf("stop")).toBeLessThan(order.indexOf("logout"));
});

test("a health check started during logout cannot overwrite completed deletion", async () => {
  const { adapter, service } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  let resolveLogout!: (result: { ok: boolean; code: TelegramErrorCode | null }) => void;
  let resolveHealth!: (result: TelegramHealthResult) => void;
  adapter.logout = async () => await new Promise((resolve) => { resolveLogout = resolve; });
  adapter.checkSession = async () => await new Promise((resolve) => { resolveHealth = resolve; });

  const logout = service.logout();
  const health = service.checkHealth();
  resolveLogout({ ok: true, code: null });
  expect((await logout).phase).toBe("disconnected");
  expect(readTelegramSession()).toBeNull();

  resolveHealth({ status: "expired" });
  expect((await health).phase).toBe("disconnected");
  expect(service.status().phase).toBe("disconnected");
});

test("successful logout stops a connector that health restarted during revocation", async () => {
  const adapter = new FakeAdapter();
  let resolveLogout!: (result: { ok: boolean; code: TelegramErrorCode | null }) => void;
  adapter.logout = async () => await new Promise((resolve) => { resolveLogout = resolve; });
  let connectorRunning = true;
  const service = new TelegramConnectionService({
    adapter,
    stopConnector: () => { connectorRunning = false; },
    ensureConnector: async () => {
      connectorRunning = true;
      return { ok: true, url: "http://127.0.0.1:8809/mcp" };
    },
    registerHosts: () => HOSTS_REGISTERED,
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });
  saveTelegramSession(PLACEHOLDER_SESSION);

  const logout = service.logout();
  expect(connectorRunning).toBe(false);
  expect((await service.checkHealth()).phase).toBe("connected");
  expect(connectorRunning).toBe(true);

  resolveLogout({ ok: true, code: null });
  expect((await logout).phase).toBe("disconnected");
  expect(connectorRunning).toBe(false);
  expect(readTelegramSession()).toBeNull();
});

test("a failed remote logout PRESERVES the local session and reports why", async () => {
  const { adapter, calls, service } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  adapter.logoutResult = { ok: false, code: "network_failed" };
  const status = await service.logout();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("network_failed");
  expect(readTelegramSession()).not.toBeNull();
  expect(calls.unregister).toBe(0);

  /* Local deletion remains available and works without the remote side. */
  const deleted = service.deleteLocalSession();
  expect(deleted.phase).toBe("disconnected");
  expect(readTelegramSession()).toBeNull();
  expect(calls.stop).toBe(2);
  expect(calls.unregister).toBe(1);
});

test("local deletion works directly from connected", async () => {
  const { adapter, calls, service } = harness();
  service.startLogin();
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  await settle();
  const status = service.deleteLocalSession();
  expect(status.phase).toBe("disconnected");
  expect(status.credentialRef).toBeNull();
  expect(readTelegramSession()).toBeNull();
  expect(calls.unregister).toBe(1);
});

test("a connector refusing the read-only bound blocks connected and never registers hosts", async () => {
  const { adapter } = harness();
  let registered = 0;
  const refusing = new TelegramConnectionService({
    adapter,
    ensureConnector: async () => ({ ok: false, code: "not_read_only" }),
    stopConnector: () => {},
    registerHosts: () => { registered += 1; return HOSTS_REGISTERED; },
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });
  refusing.startLogin();
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  await settle();
  const status = refusing.status();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("not_read_only");
  expect(registered).toBe(0);
  /* The authorized credential survives the refusal. */
  expect(readTelegramSession()?.sessionString).toBe(PLACEHOLDER_SESSION);
});

test("a connector bring-up that THROWS surfaces too, instead of leaving connected published", async () => {
  const { adapter } = harness();
  let registered = 0;
  const throwing = new TelegramConnectionService({
    adapter,
    ensureConnector: async () => { throw new Error("boom"); },
    stopConnector: () => {},
    registerHosts: () => { registered += 1; return HOSTS_REGISTERED; },
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });
  throwing.startLogin();
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  await settle();
  const status = throwing.status();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("connector_failed");
  expect(registered).toBe(0);
  expect(readTelegramSession()?.sessionString).toBe(PLACEHOLDER_SESSION);
});

test("host registration failure blocks connected after connector verification", async () => {
  const adapter = new FakeAdapter();
  let stopped = 0;
  const service = new TelegramConnectionService({
    adapter,
    ensureConnector: async () => ({ ok: true, url: "http://127.0.0.1:8809/mcp" }),
    stopConnector: () => { stopped += 1; },
    registerHosts: () => ({
      ok: false,
      claude: { registered: 0, conflict: 1, unwritable: 0 },
      codex: { registered: 0, failed: 1 },
    }),
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });
  service.startLogin();
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  await settle();

  expect(service.status().phase).toBe("error");
  expect(service.status().error?.code).toBe("host_registration_failed");
  expect(stopped).toBe(1);
});

test("health over a healthy account still refuses connected when the connector fails", async () => {
  const { adapter } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  const failing = new TelegramConnectionService({
    adapter,
    ensureConnector: async () => ({ ok: false, code: "connector_failed" }),
    stopConnector: () => {},
    registerHosts: () => HOSTS_REGISTERED,
    unregisterHosts: () => {},
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });
  const status = await failing.checkHealth();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("connector_failed");
  /* The account is fine, so its identity and session survive for the retry. */
  expect(status.identity?.username).toBe("account_a");
  expect(readTelegramSession()).not.toBeNull();
});

test("health recovery reports host registration failure instead of connected", async () => {
  const adapter = new FakeAdapter();
  saveTelegramSession(PLACEHOLDER_SESSION);
  let unregistered = 0;
  const service = new TelegramConnectionService({
    adapter,
    ensureConnector: async () => ({ ok: true, url: "http://127.0.0.1:8809/mcp" }),
    stopConnector: () => {},
    registerHosts: () => ({
      ok: false,
      claude: { registered: 0, conflict: 0, unwritable: 1 },
      codex: { registered: 1, failed: 0 },
    }),
    unregisterHosts: () => { unregistered += 1; },
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });

  const status = await service.checkHealth();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("host_registration_failed");
  expect(unregistered).toBe(1);
});

test("an unsafe session file (symlink) reads as an explicit session_unsafe error", async () => {
  const { service } = harness();
  const outside = path.join(SANDBOX, "planted.json");
  fs.writeFileSync(outside, JSON.stringify({ version: 1, credentialRef: "x", sessionString: "planted" }));
  fs.mkdirSync(path.dirname(telegramSessionPath()), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, telegramSessionPath());
  const status = await service.checkHealth();
  expect(status.phase).toBe("error");
  expect(status.error?.code).toBe("session_unsafe");
});

test("local deletion invalidates an in-flight health result", async () => {
  const { adapter, calls, service } = harness();
  saveTelegramSession(PLACEHOLDER_SESSION);
  let resolveHealth!: (value: TelegramHealthResult) => void;
  adapter.healthPromise = new Promise((resolve) => { resolveHealth = resolve; });

  const pending = service.checkHealth();
  expect(service.deleteLocalSession().phase).toBe("disconnected");
  resolveHealth({ status: "connected", identity: { name: "Account A", username: "account_a" } });
  expect((await pending).phase).toBe("disconnected");
  expect(readTelegramSession()).toBeNull();
  expect(calls.ensure).toEqual([]);
  expect(calls.register).toBe(0);
});

test("cancel during connector verification cannot publish the authorized session", async () => {
  const adapter = new FakeAdapter();
  let resolveConnector!: (value: { ok: true; url: string }) => void;
  const connector = new Promise<{ ok: true; url: string }>((resolve) => { resolveConnector = resolve; });
  const calls = { register: 0, stop: 0, unregister: 0 };
  const service = new TelegramConnectionService({
    adapter,
    ensureConnector: async () => await connector,
    stopConnector: () => { calls.stop += 1; },
    registerHosts: () => { calls.register += 1; return HOSTS_REGISTERED; },
    unregisterHosts: () => { calls.unregister += 1; },
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
  });
  const started = service.startLogin();
  adapter.emit!({ type: "authorized", sessionString: PLACEHOLDER_SESSION, identity: { name: "Account A", username: null } });
  expect(service.cancelLogin(started.login!.operationId).phase).toBe("disconnected");
  resolveConnector({ ok: true, url: "http://127.0.0.1:8809/mcp" });
  await settle();

  expect(service.status().phase).toBe("disconnected");
  expect(readTelegramSession()).toBeNull();
  expect(calls.register).toBe(0);
  expect(calls.stop).toBeGreaterThanOrEqual(1);
  expect(calls.unregister).toBeGreaterThanOrEqual(1);
});

test("corrupt session blocks remote logout and health without deleting credentials", async () => {
  const { adapter, calls, service } = harness();
  fs.mkdirSync(path.dirname(telegramSessionPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(telegramSessionPath(), "{broken", { mode: 0o600 });

  const logout = await service.logout();
  expect(logout.phase).toBe("error");
  expect(logout.error?.code).toBe("session_unsafe");
  expect(adapter.logoutCalls).toBe(0);
  expect(fs.existsSync(telegramSessionPath())).toBe(true);

  const health = await service.checkHealth();
  expect(health.phase).toBe("error");
  expect(health.error?.code).toBe("session_unsafe");
  expect(fs.existsSync(telegramSessionPath())).toBe(true);
  expect(calls.stop).toBeGreaterThanOrEqual(1);
  expect(calls.unregister).toBeGreaterThanOrEqual(1);

  expect(service.deleteLocalSession().phase).toBe("disconnected");
  expect(fs.existsSync(telegramSessionPath())).toBe(false);
});
