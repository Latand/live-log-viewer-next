import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cutover-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const { mergeRoot, rewriteStateFiles, scanRoot, transcriptRoots } = await import("./cutover-shared-claude-projects");
const { sharedClaudeProjectsRoot } = await import("../src/lib/accounts/claude");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function seedRoot(root: string, project: string, file: string, content: string): string {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const transcript = path.join(dir, file);
  fs.writeFileSync(transcript, content, { mode: 0o600 });
  return transcript;
}

test("cutover merges disjoint roots, symlinks them, and rewrites state paths", () => {
  const legacyRoot = path.join(process.env.LLV_CLAUDE_HOME!, "projects");
  const managedRoot = path.join(SANDBOX, "accounts", "claude", "work", "projects");
  seedRoot(legacyRoot, "-repo-a", "one.jsonl", "legacy\n");
  seedRoot(managedRoot, "-repo-a", "two.jsonl", "managed\n");
  seedRoot(managedRoot, "-repo-b", "three.jsonl", "managed-b\n");

  const roots = transcriptRoots();
  expect(roots.sort()).toEqual([legacyRoot, managedRoot].sort());

  const seen = new Map<string, string>();
  const collisions = roots.flatMap((root) => scanRoot(root, seen).collisions);
  expect(collisions).toEqual([]);

  const stateFile = path.join(process.env.LLV_STATE_DIR!, "agent-registry.json");
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify({ path: path.join(managedRoot, "-repo-a", "two.jsonl") }), { mode: 0o600 });

  const shared = sharedClaudeProjectsRoot();
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  for (const root of roots) mergeRoot(root, shared);
  const rewrites = rewriteStateFiles(roots, shared, true);

  // Both roots are now symlinks to the shared store.
  for (const root of roots) {
    expect(fs.lstatSync(root).isSymbolicLink()).toBeTrue();
    expect(fs.realpathSync(root)).toBe(fs.realpathSync(shared));
  }
  // Every transcript arrived, same-named projects merged without loss.
  expect(fs.readFileSync(path.join(shared, "-repo-a", "one.jsonl"), "utf8")).toBe("legacy\n");
  expect(fs.readFileSync(path.join(shared, "-repo-a", "two.jsonl"), "utf8")).toBe("managed\n");
  expect(fs.readFileSync(path.join(shared, "-repo-b", "three.jsonl"), "utf8")).toBe("managed-b\n");
  // Old absolute paths still resolve through the symlink.
  expect(fs.readFileSync(path.join(managedRoot, "-repo-b", "three.jsonl"), "utf8")).toBe("managed-b\n");
  // State file now carries the canonical prefix.
  expect(rewrites).toEqual([{ file: stateFile, replaced: 1 }]);
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).path).toBe(path.join(shared, "-repo-a", "two.jsonl"));
});

test("a collision aborts the plan before anything moves", () => {
  const rootA = path.join(SANDBOX, "collide", "a", "projects");
  const rootB = path.join(SANDBOX, "collide", "b", "projects");
  seedRoot(rootA, "-repo", "same.jsonl", "a\n");
  seedRoot(rootB, "-repo", "same.jsonl", "b\n");
  const seen = new Map<string, string>();
  const collisions = [rootA, rootB].flatMap((root) => scanRoot(root, seen).collisions);
  expect(collisions).toHaveLength(1);
  expect(collisions[0]).toContain(path.join("-repo", "same.jsonl"));
});
