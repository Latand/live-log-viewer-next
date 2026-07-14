import { expect, test } from "bun:test";

import { accountIdFromPath, DEFAULT_ACCOUNT_ID } from "./badge";

test("reads the managed Claude account id from a transcript path", () => {
  expect(
    accountIdFromPath("/home/u/.config/agent-log-viewer/accounts/claude/botfatherdev-2/projects/-x/session.jsonl"),
  ).toBe("botfatherdev-2");
});

test("reads the managed Codex account id from a session path", () => {
  expect(
    accountIdFromPath("/home/u/.config/agent-log-viewer/accounts/codex/terra/sessions/2026/07/x.jsonl"),
  ).toBe("terra");
});

test("the legacy home (no accounts segment) maps to the default account", () => {
  expect(accountIdFromPath("/home/u/.claude/projects/-x/session.jsonl")).toBe(DEFAULT_ACCOUNT_ID);
  expect(accountIdFromPath("/home/u/.codex/sessions/2026/07/x.jsonl")).toBe(DEFAULT_ACCOUNT_ID);
});

test("missing/empty path falls back to the default account", () => {
  expect(accountIdFromPath(null)).toBe(DEFAULT_ACCOUNT_ID);
  expect(accountIdFromPath(undefined)).toBe(DEFAULT_ACCOUNT_ID);
  expect(accountIdFromPath("")).toBe(DEFAULT_ACCOUNT_ID);
});

test("a foreign engine folder under accounts is not matched", () => {
  expect(accountIdFromPath("/x/accounts/gemini/acct/projects/s.jsonl")).toBe(DEFAULT_ACCOUNT_ID);
});
