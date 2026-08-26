import { expect, test } from "bun:test";

import { accountMigrationHostArgv, structuredHostEngine } from "./process";

const CLAUDE_BROKER = [
  "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
  "--verbose", "--include-partial-messages", "--replay-user-messages",
  "--permission-prompt-tool", "stdio", "--permission-mode", "bypassPermissions",
];

const CODEX_APP_SERVER = ["codex", "app-server", "--enable", "realtime_conversation"];

test("the claude broker and the codex app server are the two structured host shapes", () => {
  expect(structuredHostEngine(CLAUDE_BROKER)).toBe("claude");
  expect(structuredHostEngine(CODEX_APP_SERVER)).toBe("codex");
  expect(structuredHostEngine(["/usr/bin/node", "/home/user/.bun/bin/codex", "app-server"])).toBe("codex");
});

test("an operator's own CLI is not a structured host", () => {
  expect(structuredHostEngine(["claude"])).toBeNull();
  expect(structuredHostEngine(["claude", "--continue"])).toBeNull();
  /* `claude -p "summarise this"` is a one-shot print run from a shell, not a
     broker: without the stream-json input channel nothing can address it. */
  expect(structuredHostEngine(["claude", "-p", "summarise this"])).toBeNull();
  expect(structuredHostEngine(["codex", "resume", "--last"])).toBeNull();
  expect(structuredHostEngine(["codex-telegram-mcp", "app-server"])).toBeNull();
  expect(structuredHostEngine(["bash", "-lc", "claude -p --input-format stream-json"])).toBeNull();
});

test("an account-migration successor is recognised so bulk kills leave it alone", () => {
  expect(accountMigrationHostArgv([...CLAUDE_BROKER, "--resume", "/t.jsonl", "--fork-session"])).toBe(true);
  expect(accountMigrationHostArgv(CLAUDE_BROKER)).toBe(false);
  expect(accountMigrationHostArgv(CODEX_APP_SERVER)).toBe(false);
});
