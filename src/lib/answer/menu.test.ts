import { describe, expect, test } from "bun:test";

import { composerReady, normalizeText, optionMatches, parseAllOptions, parseOptions, planOption, screenHasFragment } from "./menu";

const QUESTION_SCREEN = [
  "│ Which library should we use for date formatting?",
  "│",
  "│ ❯ 1. date-fns",
  "│   2. dayjs",
  "│   3. Luxon",
  "",
  "  Enter to confirm · Esc to cancel",
].join("\n");

const PLAN_SCREEN = [
  "│ Ready to code?",
  "│",
  "│ ❯ 1. Yes, and auto-accept edits",
  "│   2. Yes, and manually approve edits",
  "│   3. No, keep planning",
].join("\n");

describe("parseOptions", () => {
  test("reads the highlighted option and its run", () => {
    const options = parseOptions(QUESTION_SCREEN);
    expect(options.map((option) => option.label)).toEqual(["date-fns", "dayjs", "Luxon"]);
    expect(options.find((option) => option.highlighted)?.label).toBe("date-fns");
  });

  test("keeps only the contiguous run around the cursor", () => {
    const screen = ["1. stray numbered prose line", "", "│ ❯ 1. Real option", "│   2. Other option"].join("\n");
    const options = parseOptions(screen);
    expect(options.map((option) => option.label)).toEqual(["Real option", "Other option"]);
  });

  test("returns every option line when nothing is highlighted", () => {
    const options = parseAllOptions("1. one\n2. two");
    expect(options).toHaveLength(2);
    expect(options.every((option) => !option.highlighted)).toBe(true);
  });
});

describe("planOption", () => {
  test("prefers plain accept over auto-accept", () => {
    expect(planOption(PLAN_SCREEN, true)?.label).toBe("Yes, and manually approve edits");
  });

  test("finds the reject option", () => {
    expect(planOption(PLAN_SCREEN, false)?.label).toBe("No, keep planning");
  });

  test("returns null when no option fits", () => {
    expect(planOption("│ ❯ 1. Something unrelated", false)).toBeNull();
  });
});

describe("screenHasFragment", () => {
  test("matches a question rendered with box-drawing noise", () => {
    expect(screenHasFragment(QUESTION_SCREEN, "Which library should we use for date formatting?")).toBe(true);
  });

  test("rejects a screen showing a different question", () => {
    expect(screenHasFragment(QUESTION_SCREEN, "Deploy the release to production now?")).toBe(false);
  });
});

describe("optionMatches", () => {
  test("tolerates partial containment in either direction", () => {
    const [option] = parseAllOptions("❯ 1. Yes, approve the plan");
    expect(option).toBeDefined();
    expect(optionMatches(option!, "approve the plan")).toBe(true);
    expect(optionMatches(option!, "reject")).toBe(false);
  });
});

describe("composerReady", () => {
  test("sees the composer prompt in the tail", () => {
    expect(composerReady("some output\n❯ ")).toBe(true);
    expect(composerReady("still working…")).toBe(false);
  });
});

describe("normalizeText", () => {
  test("strips ansi and box glyphs", () => {
    expect(normalizeText("\x1b[1m│ Hello “World”\x1b[0m")).toBe('hello "world"');
  });
});
