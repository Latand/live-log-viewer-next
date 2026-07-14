import { expect, test } from "bun:test";

import { detectLaunchFailure, detectLiveRateLimit, launchPromptLanded, screenAtIdleComposer } from "./status";

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

test("a current Codex usage wall exposes its reset timestamp", () => {
  const now = new Date(2026, 6, 10, 18, 0, 0).getTime() / 1000;
  const resetAt = new Date(2026, 6, 10, 19, 55, 0).getTime() / 1000;
  const screen = [
    "You've hit your usage limit",
    "You can keep using Codex when your limit resets. Try again at 7:55 PM.",
  ].join("\n");

  expect(detectLiveRateLimit(screen, now)).toEqual({ resetAt });
});

test("historical usage prose above a ready composer stays clear", () => {
  const screen = [
    "You've hit your usage limit. Try again at 7:55 PM.",
    "The previous attempt was rate-limited, so I resumed later.",
    "",
    "› ",
    "  Context 37% used",
  ].join("\n");

  expect(detectLiveRateLimit(screen, Date.now() / 1000)).toBeNull();
});

test("Claude login and bypass-acceptance screens fail launch with teaching errors", () => {
  expect(detectLaunchFailure("claude", [
    "Welcome to Claude Code",
    "Select login method",
    "1. Claude account with subscription",
  ].join("\n"))).toEqual({
    code: "authentication_required",
    message: "Claude needs account re-login. Open Accounts, sign in, and retry the launch.",
  });
  expect(detectLaunchFailure("claude", [
    "Bypass Permissions mode",
    "By proceeding, you accept all responsibility",
    "No, exit",
  ].join("\n"))).toEqual({
    code: "bypass_acceptance_required",
    message: "Claude bypass-permissions acceptance was not prepared. Retry the launch after refreshing the account.",
  });
});

test("launch prompt verification accepts a submitted turn and rejects a login screen", () => {
  const busy = [
    "❯ Implement issue 178",
    "✳ Deliberating… (esc to interrupt)",
  ].join("\n");
  expect(launchPromptLanded("claude", busy, "Implement issue 178")).toBe(true);
  expect(launchPromptLanded("claude", "Select login method\n1. Claude account", "Implement issue 178")).toBe(false);
  expect(launchPromptLanded("claude", "❯ Implement issue 178\n? for shortcuts", "Implement issue 178")).toBe(false);
});

test("login wording inside a live prompt or transcript never becomes a startup failure", () => {
  const busy = [
    "❯ Render the exact text Select login method",
    "✳ Deliberating… (esc to interrupt)",
  ].join("\n");
  expect(detectLaunchFailure("claude", busy)).toBeNull();

  const ready = [
    "● The page now renders Select login method.",
    "",
    "❯ ",
    "  ? for shortcuts",
  ].join("\n");
  expect(detectLaunchFailure("claude", ready)).toBeNull();
});
