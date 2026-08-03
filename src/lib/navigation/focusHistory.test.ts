import { describe, expect, test } from "bun:test";

import {
  decideFocusAction,
  decideProjectAction,
  FOCUS_HISTORY_STATE_KEY,
  focusEntryFor,
  parseFocusHistoryState,
  sameFocusTarget,
  type FocusHistoryEntry,
} from "./focusHistory";

const entry = (over: Partial<FocusHistoryEntry> = {}): FocusHistoryEntry => ({
  v: 1,
  conversationId: "conv-a",
  path: "/logs/a.jsonl",
  project: "-home-user-proj",
  ...over,
});

describe("focusEntryFor", () => {
  test("keys primarily by the stable conversation id", () => {
    const built = focusEntryFor({ conversationId: "conv-a", path: "/logs/a.jsonl" }, "-p");
    expect(built).toEqual({ v: 1, conversationId: "conv-a", path: "/logs/a.jsonl", project: "-p" });
  });

  test("falls back to the transcript path when no id was adopted yet", () => {
    const built = focusEntryFor({ conversationId: null, path: "/logs/b.jsonl" }, "-p");
    expect(built.conversationId).toBeNull();
    expect(built.path).toBe("/logs/b.jsonl");
  });
});

describe("parseFocusHistoryState", () => {
  test("round-trips a recorded entry", () => {
    const state = { [FOCUS_HISTORY_STATE_KEY]: entry() };
    expect(parseFocusHistoryState(state)).toEqual(entry());
  });

  test("returns null for untyped states", () => {
    expect(parseFocusHistoryState(null)).toBeNull();
    expect(parseFocusHistoryState(undefined)).toBeNull();
    expect(parseFocusHistoryState({})).toBeNull();
    expect(parseFocusHistoryState("x")).toBeNull();
    expect(parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: "conv-a" })).toBeNull();
  });

  test("rejects a version it does not speak", () => {
    expect(parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: entry({ v: 2 as never }) })).toBeNull();
  });

  test("rejects non-string identity fields", () => {
    expect(parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: entry({ conversationId: 7 as never }) })).toBeNull();
    expect(parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: entry({ project: 7 as never }) })).toBeNull();
  });

  test("rejects an entry with no identity at all", () => {
    expect(parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: entry({ conversationId: null, path: null }) })).toBeNull();
  });

  test("rejects unbounded fields — history state carries identity, never transcript text", () => {
    const text = "user: ".padEnd(4000, "x");
    expect(parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: entry({ path: text }) })).toBeNull();
    expect(parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: entry({ conversationId: text }) })).toBeNull();
  });

  test("drops unknown extra fields instead of replaying them", () => {
    const state = { [FOCUS_HISTORY_STATE_KEY]: { ...entry(), transcript: "user: hello" } };
    expect(parseFocusHistoryState(state)).toEqual(entry());
  });
});

describe("sameFocusTarget", () => {
  test("matches on conversation id", () => {
    expect(sameFocusTarget(entry(), entry({ path: "/logs/rotated.jsonl" }))).toBe(true);
  });

  test("matches on path when either side has no adopted id yet", () => {
    expect(sameFocusTarget(entry({ conversationId: null }), entry())).toBe(true);
    expect(sameFocusTarget(entry(), entry({ conversationId: null }))).toBe(true);
  });

  test("distinct conversations do not match", () => {
    expect(sameFocusTarget(entry(), entry({ conversationId: "conv-b", path: "/logs/b.jsonl" }))).toBe(false);
  });
});

describe("decideFocusAction", () => {
  test("a deliberate focus over an untyped entry pushes", () => {
    expect(decideFocusAction(null, entry(), false)).toBe("push");
  });

  test("a deliberate focus on a new target pushes (forward-branch truncation is the browser's)", () => {
    expect(decideFocusAction(entry(), entry({ conversationId: "conv-b", path: "/logs/b.jsonl" }), false)).toBe("push");
  });

  test("repeated focus on the current target coalesces", () => {
    expect(decideFocusAction(entry(), entry(), false)).toBe("replace");
  });

  test("provisional-id adoption still coalesces through the shared path", () => {
    expect(decideFocusAction(entry({ conversationId: null }), entry(), false)).toBe("replace");
  });

  test("a restoration (initial deep link, popstate replay) never pushes", () => {
    expect(decideFocusAction(null, entry(), true)).toBe("replace");
    expect(decideFocusAction(entry({ conversationId: "conv-b" }), entry(), true)).toBe("replace");
  });
});

describe("decideProjectAction", () => {
  test("a project selection over a focused-card entry pushes so the card entry survives", () => {
    expect(decideProjectAction(entry())).toBe("push");
  });

  test("a project selection over an untyped entry replaces, as before", () => {
    expect(decideProjectAction(null)).toBe("replace");
  });
});
