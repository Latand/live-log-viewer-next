import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeTranscriptPath, headCwd, headSessionStartedAt, slugifyCwd } from "./transcript";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llv-transcript-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, lines: string[]): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

describe("slugifyCwd", () => {
  test("replaces every non-alphanumeric with a dash", () => {
    expect(slugifyCwd("/home/user/my project.v2")).toBe("-home-user-my-project-v2");
  });
});

describe("claudeTranscriptPath", () => {
  test("builds the ~/.claude/projects path for a session id", () => {
    const expected = path.join(os.homedir(), ".claude", "projects", "-tmp-demo", "abc.jsonl");
    expect(claudeTranscriptPath("/tmp/demo", "abc")).toBe(expected);
  });
});

describe("headCwd", () => {
  test("reads a claude-style top-level cwd", () => {
    const file = write("claude.jsonl", [JSON.stringify({ type: "meta" }), JSON.stringify({ cwd: "/some/where" })]);
    expect(headCwd(file)).toBe("/some/where");
  });

  test("reads a codex-style payload.cwd", () => {
    const file = write("codex.jsonl", [JSON.stringify({ payload: { cwd: "/roll/out" } })]);
    expect(headCwd(file)).toBe("/roll/out");
  });

  test("skips malformed head rows", () => {
    const file = write("broken.jsonl", ["{not json", JSON.stringify({ cwd: "/after/noise" })]);
    expect(headCwd(file)).toBe("/after/noise");
  });

  test("requireDir skips a cwd that no longer exists", () => {
    const file = write("gone.jsonl", [
      JSON.stringify({ cwd: "/definitely/not/a/real/dir/llv" }),
      JSON.stringify({ cwd: tmp }),
    ]);
    expect(headCwd(file, { requireDir: true })).toBe(tmp);
    expect(headCwd(file)).toBe("/definitely/not/a/real/dir/llv");
  });

  test("returns null for an unreadable file or a headless transcript", () => {
    expect(headCwd(path.join(tmp, "missing.jsonl"))).toBeNull();
    const file = write("nocwd.jsonl", [JSON.stringify({ type: "meta" })]);
    expect(headCwd(file)).toBeNull();
  });

  test("maxLines caps how deep the head scan goes", () => {
    const file = write("deep.jsonl", [JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 }), JSON.stringify({ cwd: "/deep" })]);
    expect(headCwd(file, { maxLines: 2 })).toBeNull();
    expect(headCwd(file, { maxLines: 3 })).toBe("/deep");
  });
});

describe("headSessionStartedAt", () => {
  test("reads a Codex session timestamp from the transcript header", () => {
    const file = write("codex-started-at.jsonl", [
      JSON.stringify({ type: "session_meta", payload: { timestamp: "2026-07-12T12:34:56.789Z" } }),
    ]);
    expect(headSessionStartedAt(file)).toBe("2026-07-12T12:34:56.789Z");
  });

  test("returns null when the transcript header has no valid timestamp", () => {
    const file = write("invalid-started-at.jsonl", [JSON.stringify({ payload: { timestamp: "unknown" } })]);
    expect(headSessionStartedAt(file)).toBeNull();
  });
});
