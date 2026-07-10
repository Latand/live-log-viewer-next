import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cli-account-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");

const { freshSpecFor, resumeSpecFor } = await import("./cli");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("fresh Codex commands fix CODEX_HOME in the typed shell command", () => {
  const home = path.join(SANDBOX, "account with space");
  const spec = freshSpecFor("codex", "/repo", { codexHome: home });

  expect(spec.command).toStartWith(`CODEX_HOME='${home}' `);
  expect(spec.command).toContain("codex");
});

test("Claude commands do not gain Codex environment assignments", () => {
  const spec = freshSpecFor("claude", "/repo", { codexHome: path.join(SANDBOX, "unused") });

  expect(spec.command).not.toContain("CODEX_HOME=");
});

test("Codex resume derives its owning account home from the transcript path", () => {
  const transcript = path.join(SANDBOX, "legacy", "sessions", "2026", "07", "09", "rollout-019f423a-d6e9-7903-b597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: SANDBOX } }) + "\n");

  const spec = resumeSpecFor("codex-sessions", transcript);

  expect(spec?.command).toStartWith(`CODEX_HOME='${path.join(SANDBOX, "legacy")}' `);
  expect(spec?.command).toContain("resume 019f423a-d6e9-7903-b597-3e676b6ff3d4");
});

test("resume preserves the transcript model and reasoning effort for both engines", () => {
  const codexTranscript = path.join(SANDBOX, "legacy", "sessions", "2026", "07", "09", "rollout-019f423a-d6e9-7903-b597-3e676b6ff3d4.jsonl");
  const codex = resumeSpecFor("codex-sessions", codexTranscript, { model: "gpt-5.6-terra", effort: "xhigh" });
  const claude = resumeSpecFor("claude-projects", "/repo/.claude/projects/-repo/019f423a-d6e9-7903-b597-3e676b6ff3d4.jsonl", {
    model: "opus",
    effort: "max",
  });

  expect(codex?.command).toContain("-m 'gpt-5.6-terra'");
  expect(codex?.command).toContain("model_reasoning_effort=xhigh");
  expect(codex?.command).toContain("CODEX_HOME='");
  expect(claude?.command).toContain("--model 'opus'");
  expect(claude?.command).toContain("--effort 'max'");
});

test("managed Codex commands pin file-backed credential storage", () => {
  const account = createManagedCodexAccount("Review");
  const fresh = freshSpecFor("codex", "/repo", { codexHome: account.home, model: "gpt-5" });
  const transcript = path.join(account.sessionsDir, "2026", "07", "09", "rollout-019f423a-d6e9-7903-b597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: SANDBOX } }) + "\n");

  expect(fresh.command).toContain("cli_auth_credentials_store=file");
  expect(resumeSpecFor("codex-sessions", transcript)?.command).toContain("cli_auth_credentials_store=file");
  expect(fresh.command.indexOf("cli_auth_credentials_store=file")).toBeLessThan(fresh.command.indexOf("gpt-5"));
  const resumed = resumeSpecFor("codex-sessions", transcript)?.command ?? "";
  expect(resumed.indexOf("cli_auth_credentials_store=file")).toBeLessThan(resumed.indexOf("resume"));
});
