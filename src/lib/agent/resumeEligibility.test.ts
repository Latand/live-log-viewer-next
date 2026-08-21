import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Issue #935: on a machine cut over to the shared transcript store (#891) the
 * path-layout answer for "which account owns this transcript" is null for
 * EVERY Claude transcript, so `resumeSpecFor` returned null and resume refused
 * every Claude conversation on the machine. These cases pin the resolution
 * order (recorded provenance → path layout → routed account) and the named
 * refusals that replaced one generic message.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-resume-eligibility-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const { resumeEligibility, resumeSpecFor } = await import("./cli");
const claude = await import("@/lib/accounts/claude");

const SESSION_ID = "12345678-1234-1234-1234-123456789abc";

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_CLAUDE_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_CLAUDE_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** Legacy home plus two managed homes, every `projects` a symlink into the one
    shared root — the layout the operator's machine actually runs. */
function sharedStoreMachine(): { transcript: string; accounts: ReturnType<typeof claude.listClaudeAccounts> } {
  const shared = claude.sharedClaudeProjectsRoot();
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const legacy = process.env.LLV_CLAUDE_HOME!;
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(legacy, "projects"))) fs.symlinkSync(shared, path.join(legacy, "projects"));
  if (claude.listClaudeAccounts().length < 3) {
    for (const label of ["Account A", "Account B"]) {
      const account = claude.createManagedClaudeAccount(label);
      fs.rmSync(path.join(account.home, "projects"), { recursive: true, force: true });
      fs.symlinkSync(shared, path.join(account.home, "projects"));
    }
  }
  const project = path.join(shared, "-repo");
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  const transcript = path.join(project, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
  return { transcript, accounts: claude.listClaudeAccounts() };
}

test("a shared-store transcript resumes under its recorded account", () => {
  const { transcript, accounts } = sharedStoreMachine();
  const recorded = accounts.at(-1)!;

  const eligibility = resumeEligibility("claude-projects", transcript, { accountId: recorded.id, cwd: SANDBOX });
  const spec = resumeSpecFor("claude-projects", transcript, { accountId: recorded.id, cwd: SANDBOX });

  expect(eligibility).toEqual({ ok: true, engine: "claude", sessionId: SESSION_ID, home: recorded.home, cwd: SANDBOX });
  expect(spec?.command).toContain(`'--resume' '${SESSION_ID}'`);
  expect(spec?.command).toContain(recorded.home);
  expect(spec?.command).not.toContain(accounts[0]!.home);
});

test("a shared-store transcript with no recorded account still resumes, under the routed one", () => {
  const { transcript, accounts } = sharedStoreMachine();
  claude.setActiveClaudeAccount(accounts[1]!.id);

  const spec = resumeSpecFor("claude-projects", transcript, { cwd: SANDBOX });

  expect(spec).not.toBeNull();
  expect(spec?.command).toContain(`'--resume' '${SESSION_ID}'`);
  expect(spec?.command).toContain(accounts[1]!.home);
});

test("each refusal names the one condition that failed", () => {
  const { transcript } = sharedStoreMachine();
  const subagent = path.join(path.dirname(transcript), "subagents", `${SESSION_ID}.jsonl`);
  const missing = path.join(path.dirname(transcript), "aaaaaaaa-1234-1234-1234-123456789abc.jsonl");
  const outside = path.join(SANDBOX, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(outside, "{}\n", { mode: 0o600 });

  expect(resumeEligibility("claude-projects", subagent)).toEqual({
    ok: false,
    reason: "a Claude subagent transcript has no session of its own to resume",
  });
  expect(resumeEligibility("claude-projects", path.join(path.dirname(transcript), "notes.jsonl"))).toEqual({
    ok: false,
    reason: "the transcript filename carries no Claude session id",
  });
  expect(resumeEligibility("claude-projects", missing)).toEqual({
    ok: false,
    reason: "the conversation transcript cannot be read from disk",
  });
  expect(resumeEligibility("claude-projects", outside)).toEqual({
    ok: false,
    reason: "the transcript is outside every Claude account transcript root the viewer knows",
  });
  expect(resumeEligibility("claude-tasks", transcript)).toEqual({
    ok: false,
    reason: "this transcript belongs to no resumable agent session",
  });
  // Every refusal above is a spec of `null`, which is exactly what the generic
  // message used to hide.
  for (const pathname of [subagent, missing, outside]) {
    expect(resumeSpecFor("claude-projects", pathname)).toBeNull();
  }
});
