import { expect, test } from "bun:test";

import {
  ATTENTION_MIN_BOARD_WIDTH,
  attentionCapablePresence,
  MOBILE_LAYOUT_QUERY,
  type AttentionPresenceFacts,
} from "./eligibility";

/*
 * The ONE predicate selection and the host gate share (#873 review, finding 6).
 * The defect it closes: a desktop window narrowed under the phone breakpoint
 * renders the mobile layout — whose attention host holds no device id and can
 * never navigate — while its presence heartbeat still says `desktop`, so
 * selection directed handoffs at a view that would never move.
 */

function facts(overrides: Partial<AttentionPresenceFacts> & { viewport?: { width: number } } = {}): AttentionPresenceFacts {
  return {
    device: { kind: "desktop" },
    mode: "scheme",
    visibility: "visible",
    viewport: { width: 1_600 },
    freshness: "active",
    ...overrides,
  };
}

test("a visible, active, wide desktop on the scheme board is capable", () => {
  expect(attentionCapablePresence(facts())).toBe(true);
});

test("a phone-width desktop window is NOT capable: its layout never mounts the executor", () => {
  expect(attentionCapablePresence(facts({ viewport: { width: ATTENTION_MIN_BOARD_WIDTH - 1 } }))).toBe(false);
  /* Exactly at the breakpoint the desktop layout renders, so it qualifies. */
  expect(attentionCapablePresence(facts({ viewport: { width: ATTENTION_MIN_BOARD_WIDTH } }))).toBe(true);
});

test("a phone is chat-only whatever its width claims", () => {
  expect(attentionCapablePresence(facts({ device: { kind: "mobile" }, viewport: { width: 2_000 } }))).toBe(false);
});

test("hidden, background and stale sessions are not capable", () => {
  expect(attentionCapablePresence(facts({ visibility: "hidden", freshness: "background" }))).toBe(false);
  expect(attentionCapablePresence(facts({ freshness: "stale" }))).toBe(false);
  expect(attentionCapablePresence(facts({ freshness: "background" }))).toBe(false);
});

test("the history list is not a mode a board can be mounted in; the overview is", () => {
  expect(attentionCapablePresence(facts({ mode: "list" }))).toBe(false);
  expect(attentionCapablePresence(facts({ mode: "overview" }))).toBe(true);
});

test("the host's media query and the selection width are one number", () => {
  /* If someone retunes the breakpoint, both sides move together — the drift
     this module exists to prevent. */
  expect(MOBILE_LAYOUT_QUERY).toBe(`(max-width: ${ATTENTION_MIN_BOARD_WIDTH - 1}px)`);
});
