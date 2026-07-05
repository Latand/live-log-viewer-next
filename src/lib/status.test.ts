import { expect, test } from "bun:test";

import { screenAtIdleComposer } from "./status";

const IDLE_CLAUDE = ["● Done. The tests pass.", "", "❯ ", "  ? for shortcuts"].join("\n");

const BUSY_CLAUDE = ["● Running bun test…", "", "❯ ", "✳ Deliberating… (esc to interrupt)"].join("\n");

/* A long quiet command: streamed output, no composer, no menu, no hints. */
const QUIET_OUTPUT = ["compiling module 1442/9000…", "compiling module 1443/9000…", "compiling module 1444/9000…"].join("\n");

const MENU_SCREEN = ["Do you want to proceed?", " 1. Yes", " 2. No", ""].join("\n");

test("an idle composer with ready hints is positively detected", () => {
  expect(screenAtIdleComposer(IDLE_CLAUDE)).toBe(true);
});

test("a busy turn with the interrupt hint never reads as at-composer", () => {
  expect(screenAtIdleComposer(BUSY_CLAUDE)).toBe(false);
});

test("quiet streamed output without a composer never reads as at-composer", () => {
  expect(screenAtIdleComposer(QUIET_OUTPUT)).toBe(false);
});

test("a waiting menu is a dialog, never an idle composer", () => {
  expect(screenAtIdleComposer(MENU_SCREEN)).toBe(false);
});
