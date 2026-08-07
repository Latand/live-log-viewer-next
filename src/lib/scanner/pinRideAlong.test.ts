import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pin-ride-along-unit-"));
const previous = {
  state: process.env.LLV_STATE_DIR,
  codex: process.env.LLV_CODEX_HOME,
  claude: process.env.LLV_CLAUDE_HOME,
};
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");

const { pinnedIdentityEntries } = await import("./pinRideAlong");

const sessions = path.join(process.env.LLV_CODEX_HOME, "sessions", "2026", "07", "16");
fs.mkdirSync(sessions, { recursive: true });

/** An oversized synthetic rollout — larger than every read window the scanner
    applies, so nothing about it can be derived from a single head read alone. */
const oversized = path.join(sessions, "rollout-oversized.jsonl");
fs.writeFileSync(oversized, [
  JSON.stringify({ type: "session_meta", payload: { id: "oversized", cwd: "/repo/quiet-project", timestamp: "2026-07-16T00:00:00.000Z" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "the first prompt" }] } }),
].join("\n") + "\n" + "x".repeat(2 * 1024 * 1024) + "\n");
const aged = new Date(Date.now() - 21 * 86_400_000);
fs.utimesSync(oversized, aged, aged);

const empty = path.join(sessions, "rollout-empty.jsonl");
fs.writeFileSync(empty, "");

const foreign = path.join(sandbox, "outside-every-root.jsonl");
fs.writeFileSync(foreign, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`);

afterAll(() => {
  for (const [key, value] of [["LLV_STATE_DIR", previous.state], ["LLV_CODEX_HOME", previous.codex], ["LLV_CLAUDE_HOME", previous.claude]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("an oversized, weeks-old transcript still yields identity", () => {
  const [row] = pinnedIdentityEntries([oversized], new Set());

  expect(row).toBeDefined();
  expect(row!.path).toBe(oversized);
  expect(row!.engine).toBe("codex");
  expect(row!.root).toBe("codex-sessions");
  expect(row!.size).toBe(fs.statSync(oversized).size);
  expect(row!.project).not.toBe("other");
  expect(row!.title).toBeTruthy();
  expect(row!.activity).toBe("idle");
  expect(row!.parent).toBeNull();
});

test("a path already carried by the scan is never duplicated", () => {
  expect(pinnedIdentityEntries([oversized], new Set([oversized]))).toEqual([]);
  expect(pinnedIdentityEntries([oversized, oversized], new Set())).toHaveLength(1);
});

test("the ride-along refuses what discovery itself refuses", () => {
  /* Outside every scan root — the same containment gate `pathAllowed` applies,
     so a pin can never name an arbitrary file on the host. */
  expect(pinnedIdentityEntries([foreign], new Set())).toEqual([]);
  /* Empty transcripts and paths that are simply gone are not conversations. */
  expect(pinnedIdentityEntries([empty], new Set())).toEqual([]);
  expect(pinnedIdentityEntries([path.join(sessions, "rollout-deleted.jsonl")], new Set())).toEqual([]);
});
