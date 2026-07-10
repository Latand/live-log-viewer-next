import { describe, expect, test } from "bun:test";

import {
  DIFF_CAPS,
  diffFromApplyPatch,
  diffFromClaudeEdit,
  normalizeEdit,
  type FileDiff,
} from "./diff";

function only(files: FileDiff[]): FileDiff {
  expect(files).toHaveLength(1);
  return files[0];
}

describe("Claude Edit / MultiEdit / Write normalization", () => {
  test("Edit becomes an update with removed then added lines and true counts", () => {
    const model = normalizeEdit("Edit", { file_path: "/repo/src/route.ts", old_string: "a\nb", new_string: "a\nB\nc" });
    const file = only(model.files);
    expect(file.op).toBe("update");
    expect(file.path).toBe("/repo/src/route.ts");
    expect(file.added).toBe(3);
    expect(file.removed).toBe(2);
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    const kinds = file.hunks.flatMap((h) => h.lines.map((l) => l.t + l.text));
    expect(kinds).toEqual(["-a", "-b", "+a", "+B", "+c"]);
  });

  test("Edit without old_string becomes an all-added file safely", () => {
    const model = normalizeEdit("Edit", { file_path: "/repo/new.ts", new_string: "line1\nline2" });
    const file = only(model.files);
    expect(file.op).toBe("add");
    expect(file.removed).toBe(0);
    expect(file.added).toBe(2);
    expect(file.hunks[0].lines.every((l) => l.t === "+")).toBe(true);
  });

  test("Write is a pure all-added file", () => {
    const model = normalizeEdit("Write", { file_path: "/repo/a.txt", content: "x\ny\nz" });
    const file = only(model.files);
    expect(file.op).toBe("add");
    expect(file.added).toBe(3);
    expect(file.removed).toBe(0);
  });

  test("MultiEdit collapses several edits into one file with multiple hunks", () => {
    const model = normalizeEdit("MultiEdit", {
      file_path: "/repo/m.ts",
      edits: [{ old_string: "one", new_string: "ONE" }, { old_string: "two", new_string: "TWO" }],
    });
    const file = only(model.files);
    expect(file.op).toBe("update");
    expect(file.hunks).toHaveLength(2);
    expect(file.added).toBe(2);
    expect(file.removed).toBe(2);
  });

  test("empty edit yields no files", () => {
    expect(normalizeEdit("Edit", { file_path: "/repo/x.ts", old_string: "", new_string: "" }).files).toHaveLength(0);
  });

  test("malformed/unknown args never throw and produce no files", () => {
    expect(() => normalizeEdit("Edit", {})).not.toThrow();
    expect(normalizeEdit("Edit", {}).files).toHaveLength(0);
    expect(normalizeEdit("Write", { file_path: 42 as unknown as string }).files).toHaveLength(0);
    expect(diffFromClaudeEdit({ edits: "not-an-array" }).files).toHaveLength(0);
  });
});

describe("Codex apply_patch grammar", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "+hello",
    "+world",
    "*** Update File: b.ts",
    "@@ ctx",
    " keep",
    "-old",
    "+new",
    "*** Delete File: gone.md",
    "*** End Patch",
  ].join("\n");

  test("parses add, update, and delete files with counts and ops", () => {
    const model = diffFromApplyPatch(patch);
    expect(model.files.map((f) => [f.path, f.op])).toEqual([
      ["a.txt", "add"],
      ["b.ts", "update"],
      ["gone.md", "delete"],
    ]);
    const add = model.files[0];
    expect(add.added).toBe(2);
    expect(add.removed).toBe(0);
    const update = model.files[1];
    expect(update.added).toBe(1);
    expect(update.removed).toBe(1);
    expect(update.hunks[0].lines).toEqual([
      { t: " ", text: "keep" },
      { t: "-", text: "old" },
      { t: "+", text: "new" },
    ]);
  });

  test("Move to sets op move and the destination path", () => {
    const moved = diffFromApplyPatch(["*** Begin Patch", "*** Update File: old/p.ts", "*** Move to: new/p.ts", "@@", "-a", "+b", "*** End Patch"].join("\n"));
    expect(moved.files[0].op).toBe("move");
    expect(moved.files[0].path).toBe("new/p.ts");
  });

  test("+++-looking content inside a hunk stays a single added line", () => {
    const model = diffFromApplyPatch(["*** Begin Patch", "*** Update File: c.ts", "@@", "+++weird", "*** End Patch"].join("\n"));
    expect(model.files[0].hunks[0].lines).toEqual([{ t: "+", text: "++weird" }]);
    expect(model.files[0].added).toBe(1);
  });

  test("missing terminator still parses the open file", () => {
    const model = diffFromApplyPatch(["*** Begin Patch", "*** Add File: t.txt", "+only"].join("\n"));
    expect(model.files).toHaveLength(1);
    expect(model.files[0].added).toBe(1);
  });

  test("no recognizable files yields an empty model without throwing", () => {
    expect(diffFromApplyPatch("garbage\nnot a patch").files).toHaveLength(0);
    expect(diffFromApplyPatch("").files).toHaveLength(0);
  });
});

describe("caps and safety", () => {
  test("more than the file cap flags filesTruncated and drops the rest", () => {
    const parts = ["*** Begin Patch"];
    for (let i = 0; i < DIFF_CAPS.files + 4; i += 1) parts.push(`*** Add File: f${i}.txt`, "+x");
    parts.push("*** End Patch");
    const model = diffFromApplyPatch(parts.join("\n"));
    expect(model.files).toHaveLength(DIFF_CAPS.files);
    expect(model.filesTruncated).toBe(true);
  });

  test("more than the per-file line cap truncates and flags", () => {
    const big = Array.from({ length: DIFF_CAPS.linesPerFile + 50 }, (_, i) => `line ${i}`).join("\n");
    const file = only(normalizeEdit("Write", { file_path: "/repo/big.ts", content: big }).files);
    const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(total).toBe(DIFF_CAPS.linesPerFile);
    expect(file.truncated).toBe(true);
    // true count is pre-cap
    expect(file.added).toBe(DIFF_CAPS.linesPerFile + 50);
  });

  test("an over-long line is sliced and the file flagged truncated", () => {
    const line = "z".repeat(DIFF_CAPS.charsPerLine + 500);
    const file = only(normalizeEdit("Write", { file_path: "/repo/l.ts", content: line }).files);
    expect(file.hunks[0].lines[0].text.length).toBe(DIFF_CAPS.charsPerLine);
    expect(file.truncated).toBe(true);
  });

  test("binary-ish content renders as binary with no lines", () => {
    const blob = "A".repeat(30_000);
    const file = only(normalizeEdit("Write", { file_path: "/repo/b.bin", content: blob }).files);
    expect(file.binary).toBe(true);
    expect(file.hunks).toHaveLength(0);
  });

  test("total diff text cap stops parsing and flags file truncation", () => {
    // Spaces keep the content out of the binary heuristic; the total-char
    // budget is what must trip here.
    const line = Array.from({ length: 190 }, () => "yyyyyyyyy").join(" ");
    const many = Array.from({ length: 60 }, () => line).join("\n");
    const file = only(normalizeEdit("Write", { file_path: "/repo/tot.ts", content: many }).files);
    const kept = file.hunks.reduce((n, h) => n + h.lines.reduce((s, l) => s + l.text.length, 0), 0);
    expect(kept).toBeLessThanOrEqual(DIFF_CAPS.totalChars);
    expect(file.truncated).toBe(true);
  });
});

describe("redaction runs before slicing", () => {
  test("a secret in an added line is redacted and cannot straddle the cap boundary", () => {
    const prefix = "q".repeat(DIFF_CAPS.charsPerLine - 60);
    const content = `${prefix} api_key=SUPERSECRETVALUE trailing`;
    const file = only(normalizeEdit("Write", { file_path: "/repo/s.ts", content }).files);
    const text = file.hunks[0].lines.map((l) => l.text).join("\n");
    expect(text).not.toContain("SUPERSECRETVALUE");
    expect(text).toContain("[redacted]");
  });

  test("a secret in an old_string (context) is redacted", () => {
    const file = only(
      normalizeEdit("Edit", { file_path: "/repo/e.ts", old_string: "password=hunter2", new_string: "password=[env]" }).files,
    );
    const joined = file.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(joined).not.toContain("hunter2");
  });
});
