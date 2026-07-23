import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminal-launch-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_CODEX_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "codex-legacy");

const { accountTerminalCommand, resolveAccountTerminalCommand, TerminalAccountUnavailableError } = await import("./terminalLaunch");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_CODEX_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_CODEX_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("terminal commands bind the CLI to the account home", () => {
  expect(accountTerminalCommand("codex", { kind: "legacy", home: "/srv/op/.codex" })).toBe(
    "env -u LLV_TOKEN CODEX_HOME='/srv/op/.codex' codex",
  );
  expect(accountTerminalCommand("codex", { kind: "managed", home: "/x/it's" })).toBe(
    "env -u LLV_TOKEN CODEX_HOME='/x/it'\\''s' codex -c cli_auth_credentials_store=file",
  );
  expect(accountTerminalCommand("claude", { kind: "legacy", home: "/srv/op/.claude" })).toBe("claude");
  const managedClaude = accountTerminalCommand("claude", { kind: "managed", home: "/homes/work" });
  expect(managedClaude).toContain("CLAUDE_CONFIG_DIR='/homes/work'");
  expect(managedClaude.endsWith(" claude")).toBe(true);
  expect(managedClaude).toContain("-u ANTHROPIC_API_KEY");
});

test("resolution rejects unknown and unauthenticated accounts", () => {
  try {
    resolveAccountTerminalCommand("codex", "nope");
    throw new Error("expected an unknown-account rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalAccountUnavailableError);
    expect((error as { status: number }).status).toBe(404);
  }
  // The legacy codex home has no auth.json in this sandbox.
  try {
    resolveAccountTerminalCommand("codex", "default");
    throw new Error("expected an authentication rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalAccountUnavailableError);
    expect((error as { status: number }).status).toBe(409);
  }
});

test("resolution returns the account-bound command for an authenticated account", () => {
  fs.mkdirSync(process.env.LLV_CODEX_HOME!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_CODEX_HOME!, "auth.json"), "{}");
  expect(resolveAccountTerminalCommand("codex", "default")).toEqual({
    command: `env -u LLV_TOKEN CODEX_HOME='${path.resolve(process.env.LLV_CODEX_HOME!)}' codex`,
  });
});
