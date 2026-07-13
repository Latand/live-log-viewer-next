import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-list-files-pin-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const previousClaudeHome = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");

const { DEFAULT_SCHEME_CARDS_PER_PROJECT } = await import("./schemeWindow");
const { listFiles } = await import("./index");
const { POST: preflightDeletion } = await import("@/app/api/log/preflight/route");
const { NextRequest } = await import("next/server");

const sessions = path.join(process.env.LLV_CODEX_HOME!, "sessions");
fs.mkdirSync(sessions, { recursive: true });
const paths: string[] = [];
for (let index = 0; index <= DEFAULT_SCHEME_CARDS_PER_PROJECT; index += 1) {
  const pathname = path.join(sessions, `session-${String(index).padStart(3, "0")}.jsonl`);
  fs.writeFileSync(pathname, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n");
  const time = new Date(Date.now() - 10_000 + index);
  fs.utimesSync(pathname, time, time);
  paths.push(pathname);
}
const cappedOut = paths[0];

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  if (previousClaudeHome === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = previousClaudeHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("plain file scans hydrate a pinned transcript beyond the scheme card cap", async () => {
  expect((await listFiles()).some((entry) => entry.path === cappedOut)).toBe(false);
  expect((await listFiles({ pin: cappedOut })).some((entry) => entry.path === cappedOut)).toBe(true);
});

test("project preflight refuses a live transcript beyond the scheme card cap", async () => {
  const response = await preflightDeletion(new NextRequest("http://127.0.0.1/api/log/preflight", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ paths: [cappedOut] }),
  }));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "agent is still running — stop the process first" });
});
