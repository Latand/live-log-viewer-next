import { describe, expect, test } from "bun:test";

import { decodeTerminalText, formatStdinKeys, stripAnsi } from "./ansi";

const ESC = "\x1b";

describe("stripAnsi", () => {
  test("removes SGR color, cursor, and erase-line sequences", () => {
    expect(stripAnsi(`${ESC}[32mgreen${ESC}[0m`)).toBe("green");
    expect(stripAnsi(`done${ESC}[?25h`)).toBe("done");
    expect(stripAnsi(`x${ESC}[Ky`)).toBe("xy");
  });

  test("removes OSC title sequences terminated by BEL", () => {
    expect(stripAnsi(`${ESC}]0;my title\x07text`)).toBe("text");
  });

  test("plain text passes through untouched", () => {
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip");
  });
});

describe("decodeTerminalText", () => {
  test("folds \\r\\n into real newlines (no lost lines)", () => {
    expect(decodeTerminalText("foo\r\nbar\r\n")).toBe("foo\nbar\n");
  });

  test("resolves a carriage-return progress redraw to the last write", () => {
    const raw = "Generating (1/4) \rGenerating (2/4) \rGenerating (3/4) ";
    expect(decodeTerminalText(raw)).toBe("Generating (3/4) ");
  });

  test("strips ANSI while keeping the visible vertical text", () => {
    const raw = `${ESC}[32m#16 building${ESC}[0m\r\n${ESC}[32m#16 done${ESC}[0m\r\n`;
    expect(decodeTerminalText(raw)).toBe("#16 building\n#16 done\n");
  });
});

describe("formatStdinKeys", () => {
  test("empty input renders empty — the caller decides poll from chars.length", () => {
    expect(formatStdinKeys("")).toBe("");
  });

  test("whitespace-only input is preserved visibly, never dropped (finding 2)", () => {
    expect(formatStdinKeys(" ")).toBe("␠");
    expect(formatStdinKeys("  ")).toBe("␠␠");
  });

  test("spaces inside a payload are shown as ␠, none are trimmed away (finding 2)", () => {
    expect(formatStdinKeys(" git push ")).toBe("␠git␠push␠");
  });

  test("an explicit Enter keystroke renders ⏎", () => {
    expect(formatStdinKeys("\n")).toBe("⏎");
    expect(formatStdinKeys("\r")).toBe("⏎");
  });

  test("control bytes render as caret notation", () => {
    expect(formatStdinKeys("\x03")).toBe("^C");
    expect(formatStdinKeys("\x04")).toBe("^D");
  });

  test("newlines and tabs render as glyphs; plain text passes through", () => {
    expect(formatStdinKeys("yes\n")).toBe("yes⏎");
    expect(formatStdinKeys("a\tb")).toBe("a⇥b");
  });
});
