import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-active-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
const OLD_SQLITE = process.env.LLV_AGENT_REGISTRY_SQLITE;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");
process.env.LLV_AGENT_REGISTRY_SQLITE = "sqlite";

// Production incident regression (2026-07-23, prod 5a5fbaee): the select route
// lazily constructs the AgentRegistry, and a JSON mirror without a
// `_sqliteRevision` stamp made that constructor throw RegistryParityError —
// every account switch failed with an opaque 500 and the UI reverted. Seed
// exactly that state BEFORE the route (and its registry singleton) loads.
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.LLV_STATE_DIR, "agent-registry.json"), JSON.stringify({
  version: 1, entries: {}, receipts: { stale: { launchId: "stale" } }, conversations: {},
}) + "\n");
fs.mkdirSync(process.env.LLV_CODEX_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.LLV_CODEX_HOME, "auth.json"), "{}");

const { POST } = await import("./route");
const { setAgentRegistryForTests } = await import("@/lib/agent/registry");
// The registry singleton is process-global across test files: drop whatever an
// earlier file memoized so this file's env (and its markerless mirror) applies,
// and drop ours afterwards so later files construct from their own env.
setAgentRegistryForTests(null);

afterAll(() => {
  setAgentRegistryForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  if (OLD_SQLITE === undefined) delete process.env.LLV_AGENT_REGISTRY_SQLITE;
  else process.env.LLV_AGENT_REGISTRY_SQLITE = OLD_SQLITE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function select(id: string) {
  return POST(new NextRequest("http://127.0.0.1/api/accounts/codex/active", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id, mode: "select" }),
  }));
}

test("selecting the default account succeeds over a markerless JSON mirror in sqlite mode", async () => {
  const response = await select("default");
  expect(response.status).toBe(200);
  const body = await response.json() as { active: string; revision: number };
  expect(body.active).toBe("default");
  expect(body.revision).toBeGreaterThan(0);
  // The authoritative-SQLite startup stamped and repaired the mirror.
  const mirror = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"), "utf8")) as { _sqliteRevision?: number };
  expect(typeof mirror._sqliteRevision).toBe("number");
});

test("an unknown account stays a 400 with its own message", async () => {
  const response = await select("ghost");
  expect(response.status).toBe(400);
  const body = await response.json() as { error: string };
  expect(body.error).toContain("ghost");
});

test("an unexpected selection failure surfaces its real message as detail", async () => {
  const queue = path.join(process.env.LLV_STATE_DIR!, "account-selection.lock.queue");
  // Force the mutation lock to fail with a real fs error: the queue path
  // becomes a plain file, so enqueueing a lock ticket throws ENOTDIR.
  fs.rmSync(queue, { recursive: true, force: true });
  fs.writeFileSync(queue, "not a directory");
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const response = await select("default");
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string; detail?: string; code?: string };
    expect(body.error).toBe("Codex account selection failed");
    expect(body.code).toBe("selection_failed");
    expect(typeof body.detail).toBe("string");
    expect(body.detail!.length).toBeGreaterThan(0);
    expect(errors.some((args) => typeof args[0] === "string" && args[0].includes("codex selection failed"))).toBe(true);
  } finally {
    console.error = original;
    fs.rmSync(queue, { force: true });
  }
});
