import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-route-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { GET, POST } = await import("./route");
const { TelegramConnectionService, setTelegramServiceForTests } = await import("@/lib/telegram/service");
const { readTelegramSession } = await import("@/lib/telegram/sessionStore");

import type { TelegramAdapter, TelegramEnrollmentEvent, TelegramHealthResult } from "@/lib/telegram/adapter";
import type { TelegramErrorCode } from "@/lib/telegram/contracts";

/* A placeholder with the string-session shape; never a real credential. */
const PLACEHOLDER_SESSION = "1ApWapzMBu4placeholder-not-a-real-session";

class FakeAdapter implements TelegramAdapter {
  emit: ((event: TelegramEnrollmentEvent) => void) | null = null;
  canceled = 0;
  passwords: string[] = [];
  health: TelegramHealthResult = { status: "connected", identity: { name: "Account A", username: "account_a" } };
  logoutResult: { ok: boolean; code: TelegramErrorCode | null } = { ok: true, code: null };
  unavailableReason() { return null; }
  startEnrollment(onEvent: (event: TelegramEnrollmentEvent) => void) {
    this.emit = onEvent;
    return {
      submitPassword: (password: string) => { this.passwords.push(password); },
      cancel: () => { this.canceled += 1; },
    };
  }
  checkSession() { return Promise.resolve(this.health); }
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
  }));
}

function getRequest(query = ""): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/telegram${query}`, { headers: { host: "127.0.0.1" } });
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

test("cross-origin mutation attempts are rejected", async () => {
  const response = await POST(postRequest({ action: "start" }, { origin: "https://evil.example" }));
  expect(response.status).toBe(403);
});
