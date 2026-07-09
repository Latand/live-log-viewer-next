import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-accounts-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");

const { GET } = await import("./route");
const { POST } = await import("./codex/active/route");
const { createManagedCodexAccount, listCodexAccounts, setCodexAccountLoginPane } = await import("@/lib/accounts/codex");

beforeEach(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function request(id: unknown, headers: HeadersInit = { host: "127.0.0.1" }): NextRequest {
  return new NextRequest("http://127.0.0.1/api/accounts/codex/active", { method: "POST", headers, body: JSON.stringify({ id }) });
}

test("accounts response is secret-free and clears a dead login pane", async () => {
  const account = createManagedCodexAccount("Work");
  setCodexAccountLoginPane(account.id, { paneId: "%does-not-exist", windowName: "codex-login", startedAt: 0 });

  const response = await GET();
  const body = await response.json() as { codex: { accounts: { id: string; loginPending: boolean; loginState: string; deviceAuth: unknown }[] } };

  expect(JSON.stringify(body)).not.toContain("token");
  expect(body.codex.accounts.find((item) => item.id === account.id)?.loginPending).toBe(false);
  expect(body.codex.accounts.find((item) => item.id === account.id)).toEqual(expect.objectContaining({ loginState: "idle", deviceAuth: null }));
  expect(listCodexAccounts().find((item) => item.id === account.id)?.loginPane).toBeNull();
});

test("authentication completion clears the tracked login pane", async () => {
  const account = createManagedCodexAccount("Done");
  fs.writeFileSync(path.join(account.home, "auth.json"), "credential sentinel");
  setCodexAccountLoginPane(account.id, { paneId: "%does-not-matter", windowName: "codex-login", startedAt: 0 });

  const response = await GET();
  const body = await response.json() as { codex: { accounts: { id: string; loginState: string; deviceAuth: unknown }[] } };

  expect(body.codex.accounts.find((item) => item.id === account.id)).toEqual(expect.objectContaining({ loginState: "authenticated", deviceAuth: null }));
  expect(listCodexAccounts().find((item) => item.id === account.id)?.loginPane).toBeNull();
});

test("GET stays readable for a partially corrupt registry and leaves its bytes untouched", async () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  // One retained valid account carrying a stale (dead-pane) login, plus one rejected
  // record that flips the store to mutation-locked. The GET must not attempt the
  // best-effort clear, so it neither 500s nor rewrites the file.
  const mixed = JSON.stringify({
    version: 1,
    active: "default",
    accounts: [
      { id: "work", label: "Work", kind: "managed", createdAt: 1, loginPane: { paneId: "%dead", windowName: "codex-login", startedAt: 0 } },
      { id: "../escape", label: "Escape", kind: "managed", createdAt: 2 },
    ],
  });
  fs.writeFileSync(registry, mixed);

  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json() as { codex: { active: string; accounts: { id: string }[] } };
  expect(body.codex.active).toBe("default");
  expect(body.codex.accounts.map((item) => item.id).sort()).toEqual(["default", "work"]);
  expect(fs.readFileSync(registry, "utf8")).toBe(mixed);
});

test("active mutation rejects cross-origin, unknown, and corrupt catalogs", async () => {
  expect((await POST(request("default", { host: "evil.example", origin: "https://evil.example" }))).status).toBe(403);
  expect((await POST(request("missing"))).status).toBe(400);

  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, "{ corrupt");
  const response = await POST(request("default"));
  expect(response.status).toBe(400);
  expect(fs.readFileSync(registry, "utf8")).toBe("{ corrupt");
});
