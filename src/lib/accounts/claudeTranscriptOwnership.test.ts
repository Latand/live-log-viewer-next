import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Ownership of a Claude transcript under the SHARED transcript store (#891),
 * the layout every cut-over machine runs: `<home>/projects` is a symlink into
 * one shared root, so containment names no owner and the path-layout answer is
 * null for every transcript there. Issue #935: that null reached
 * `resumeSpecFor`, which returned null, and the viewer refused every Claude
 * conversation on the machine with a generic "this conversation cannot be
 * resumed".
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-ownership-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const mod = await import("./claude");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(process.env.LLV_CLAUDE_HOME!, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "shared"), { recursive: true, force: true });
});

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** The production layout: legacy home plus two managed homes, every `projects`
    entry a symlink into the one shared root, and a stray `*.lock` directory in
    the accounts root left behind by account mutation. */
function sharedStoreMachine(): { shared: string; transcript: string } {
  const shared = mod.sharedClaudeProjectsRoot();
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const legacy = process.env.LLV_CLAUDE_HOME!;
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  fs.symlinkSync(shared, path.join(legacy, "projects"));
  for (const label of ["Account A", "Account B"]) {
    const account = mod.createManagedClaudeAccount(label);
    fs.rmSync(account.home + "/projects", { recursive: true, force: true });
    fs.symlinkSync(shared, path.join(account.home, "projects"));
  }
  fs.mkdirSync(path.join(mod.claudeAccountsRoot(), "account-a.lock"), { recursive: true, mode: 0o700 });
  const project = path.join(shared, "-repo");
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  const transcript = path.join(project, "12345678-1234-1234-1234-123456789abc.jsonl");
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
  return { shared, transcript };
}

test("shared-store ownership follows recorded provenance, not iteration order", () => {
  const { transcript } = sharedStoreMachine();
  const accounts = mod.listClaudeAccounts();
  const last = accounts.at(-1)!;
  expect(accounts.length).toBeGreaterThan(2);
  // Every account resolves to the same root, so containment can only guess.
  expect(new Set(accounts.map((item) => item.projectsDir)).size).toBe(1);

  const ownership = mod.claudeTranscriptOwnership(transcript, last.id);

  expect(ownership).toEqual({ kind: "owned", accountId: last.id, home: last.home, source: "recorded" });
  expect(ownership.kind === "owned" && ownership.home).not.toBe(accounts[0]!.home);
});

test("a shared-store transcript with no recorded account resolves to the routed account", () => {
  const { transcript } = sharedStoreMachine();
  const routed = mod.listClaudeAccounts().at(-1)!;
  mod.setActiveClaudeAccount(routed.id);

  expect(mod.claudeTranscriptOwnership(transcript)).toEqual({
    kind: "owned",
    accountId: routed.id,
    home: routed.home,
    source: "shared-store",
  });
});

test("a home that never cut over still owns its own transcripts by path", () => {
  const legacy = process.env.LLV_CLAUDE_HOME!;
  fs.mkdirSync(path.join(legacy, "projects", "-repo"), { recursive: true, mode: 0o700 });
  const cutOver = mod.createManagedClaudeAccount("Cut over");
  const shared = mod.sharedClaudeProjectsRoot();
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(cutOver.home, "projects"), { recursive: true, force: true });
  fs.symlinkSync(shared, path.join(cutOver.home, "projects"));
  const transcript = path.join(legacy, "projects", "-repo", "12345678-1234-1234-1234-123456789abc.jsonl");
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });

  expect(mod.claudeTranscriptOwnership(transcript)).toEqual({
    kind: "owned",
    accountId: "default",
    home: legacy,
    source: "path",
  });
  // The unchanged path-layout resolver keeps answering exactly this case.
  expect(mod.claudeHomeOwningTranscript(transcript)).toBe(legacy);
});

test("a home that physically holds the transcript outranks a conflicting recorded account", () => {
  const legacy = process.env.LLV_CLAUDE_HOME!;
  fs.mkdirSync(path.join(legacy, "projects", "-repo"), { recursive: true, mode: 0o700 });
  const other = mod.createManagedClaudeAccount("Other");
  const transcript = path.join(legacy, "projects", "-repo", "12345678-1234-1234-1234-123456789abc.jsonl");
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });

  /* `claude --resume <id>` reads the session out of the home's own projects
     dir, so where the bytes sit decides whenever the layout still says. */
  expect(mod.claudeTranscriptOwnership(transcript, other.id)).toEqual({
    kind: "owned",
    accountId: "default",
    home: legacy,
    source: "path",
  });
});

test("a missing transcript and a foreign path name their own refusal", () => {
  const { shared } = sharedStoreMachine();

  expect(mod.claudeTranscriptOwnership(path.join(shared, "-repo", "gone.jsonl"))).toEqual({ kind: "unreadable" });
  const outside = path.join(SANDBOX, "elsewhere.jsonl");
  fs.writeFileSync(outside, "{}\n", { mode: 0o600 });
  expect(mod.claudeTranscriptOwnership(outside)).toEqual({ kind: "foreign" });
});
