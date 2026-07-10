import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-roots-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR; const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state"); process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy");
const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
const { claudeProjectRootFor, scanRootEntries } = await import("./roots");

afterAll(() => { if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE; if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME; fs.rmSync(SANDBOX, { recursive: true, force: true }); });

test("scanner adds every Claude account projects root once and preserves its root type", () => {
  const a = createManagedClaudeAccount("A"); const b = createManagedClaudeAccount("B");
  const pathA = path.join(a.projectsDir, "repo", "a.jsonl"); fs.mkdirSync(path.dirname(pathA), { recursive: true }); fs.writeFileSync(pathA, "{}");
  const roots = scanRootEntries().filter(([kind]) => kind === "claude-projects").map(([, root]) => root);
  expect(roots).toContain(a.projectsDir); expect(roots).toContain(b.projectsDir);
  expect(new Set(roots.map((root) => fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root))).size).toBe(roots.length);
  expect(claudeProjectRootFor(pathA)).toBe(a.projectsDir);
});
