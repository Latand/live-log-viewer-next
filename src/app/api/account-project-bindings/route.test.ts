import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* Everything the route touches — the binding record, the registry it reads
   carriers from — resolves inside this sandbox. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-binding-route-"));
const STATE = path.join(SANDBOX, "state");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const ORIGINAL_HOME = process.env.HOME;
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "home"), { recursive: true });
process.env.LLV_STATE_DIR = STATE;
process.env.HOME = path.join(SANDBOX, "home");

const { GET, POST } = await import("./route");
const { accountProjectBindings, resetAccountProjectBindingsForTests } = await import("@/lib/accounts/projectBindings");

const ATLAS = "project-atlas";

/** The default legacy Claude account, the one every state directory has. */
const MAIN = "default";

beforeEach(() => {
  fs.rmSync(path.join(STATE, "account-project-bindings.json"), { force: true });
  resetAccountProjectBindingsForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  resetAccountProjectBindingsForTests();
});

async function read(project?: string): Promise<Record<string, unknown>> {
  const url = project
    ? `http://127.0.0.1/api/account-project-bindings?project=${encodeURIComponent(project)}`
    : "http://127.0.0.1/api/account-project-bindings";
  return await (await GET(new NextRequest(url))).json() as Record<string, unknown>;
}

async function mutate(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await POST(new NextRequest("http://127.0.0.1/api/account-project-bindings", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:8898" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, payload: await response.json() as Record<string, unknown> };
}

test("an unconfigured project reads as allowing every account", async () => {
  const view = await read(ATLAS) as { engines: Record<string, { restricted: boolean; allowed: { accountId: string }[] }> };
  expect(view.engines.claude?.restricted).toBe(false);
  expect(view.engines.claude?.allowed.map((account) => account.accountId)).toContain(MAIN);
  expect(view.engines.codex?.restricted).toBe(false);
});

test("an added binding is visible from both directions, and survives a fresh read", async () => {
  const added = await mutate({ action: "add", engine: "claude", accountId: MAIN, project: ATLAS });
  expect(added.status).toBe(200);
  expect(added.payload).toMatchObject({
    ok: true,
    changed: true,
    bindings: [{ engine: "claude", accountId: MAIN, project: ATLAS }],
    project: { engines: { claude: { restricted: true, allowed: [{ accountId: MAIN }] } } },
  });

  /* The record, not the response: an independent process-level read finds it. */
  resetAccountProjectBindingsForTests();
  expect(accountProjectBindings()).toMatchObject([{ engine: "claude", accountId: MAIN, project: ATLAS }]);

  const accountsSide = await read() as { accounts: Record<string, { accountId: string; projects: { project: string; displayName: string }[] }[]> };
  expect(accountsSide.accounts.claude?.find((account) => account.accountId === MAIN)?.projects)
    .toEqual([{ project: ATLAS, displayName: ATLAS }]);
});

test("a removal is confirmed by the record read back, and restores the unbound answer", async () => {
  await mutate({ action: "add", engine: "claude", accountId: MAIN, project: ATLAS });
  const removed = await mutate({ action: "remove", engine: "claude", accountId: MAIN, project: ATLAS });
  expect(removed.payload).toMatchObject({ ok: true, changed: true, bindings: [] });
  const view = await read(ATLAS) as { engines: Record<string, { restricted: boolean }> };
  expect(view.engines.claude?.restricted).toBe(false);
});

test("a malformed mutation is refused and writes nothing", async () => {
  expect((await mutate({ action: "toggle", engine: "claude", accountId: MAIN, project: ATLAS })).status).toBe(400);
  expect((await mutate({ action: "add", engine: "gemini", accountId: MAIN, project: ATLAS })).status).toBe(400);
  expect((await mutate({ action: "add", engine: "claude", accountId: MAIN })).status).toBe(400);
  resetAccountProjectBindingsForTests();
  expect(accountProjectBindings()).toEqual([]);
});
