import { expect, test } from "bun:test";

import {
  ATTENTION_MIN_BOARD_HEIGHT,
  ATTENTION_MIN_BOARD_WIDTH,
  attentionCapablePresence,
  MOBILE_LAYOUT_QUERY,
  mobileLayoutViewport,
  type AttentionPresenceFacts,
} from "./eligibility";

/*
 * The ONE predicate selection and the host gate share (#873 review, finding 6).
 * The defect it closes: a desktop window narrowed under the phone breakpoint
 * renders the mobile layout — whose attention host holds no device id and can
 * never navigate — while its presence heartbeat still says `desktop`, so
 * selection directed handoffs at a view that would never move.
 *
 * Mobile v2 (issue #1439, README §5) made the breakpoint two-axis: the desktop
 * shell needs 640 × 600, so a landscape phone at 844 × 390 renders the phone
 * layout, and the predicate has to count that window out by its height.
 */

function facts(overrides: Partial<AttentionPresenceFacts> = {}): AttentionPresenceFacts {
  return {
    device: { kind: "desktop" },
    mode: "scheme",
    visibility: "visible",
    viewport: { width: 1_600, height: 900 },
    freshness: "active",
    ...overrides,
  };
}

test("a visible, active, wide desktop on the scheme board is capable", () => {
  expect(attentionCapablePresence(facts())).toBe(true);
});

test("a phone-width desktop window is NOT capable: its layout never mounts the executor", () => {
  expect(attentionCapablePresence(facts({ viewport: { width: ATTENTION_MIN_BOARD_WIDTH - 1, height: 900 } }))).toBe(false);
  /* Exactly at the breakpoint the desktop layout renders, so it qualifies. */
  expect(attentionCapablePresence(facts({ viewport: { width: ATTENTION_MIN_BOARD_WIDTH, height: 900 } }))).toBe(true);
});

test("a desktop window squashed under the phone height is NOT capable either: a landscape phone gets the shell", () => {
  expect(attentionCapablePresence(facts({ viewport: { width: 844, height: 390 } }))).toBe(false);
  expect(attentionCapablePresence(facts({ viewport: { width: 1_600, height: ATTENTION_MIN_BOARD_HEIGHT - 1 } }))).toBe(false);
  expect(attentionCapablePresence(facts({ viewport: { width: 1_600, height: ATTENTION_MIN_BOARD_HEIGHT } }))).toBe(true);
});

test("a phone is chat-only whatever its width claims", () => {
  expect(attentionCapablePresence(facts({ device: { kind: "mobile" }, viewport: { width: 2_000, height: 1_200 } }))).toBe(false);
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

test("the phone layout renders when either axis is under the desktop minimum", () => {
  expect(mobileLayoutViewport({ width: 390, height: 844 })).toBe(true);
  expect(mobileLayoutViewport({ width: 430, height: 932 })).toBe(true);
  expect(mobileLayoutViewport({ width: 844, height: 390 })).toBe(true);
  expect(mobileLayoutViewport({ width: 639, height: 600 })).toBe(true);
  expect(mobileLayoutViewport({ width: 640, height: 599 })).toBe(true);
  expect(mobileLayoutViewport({ width: 640, height: 600 })).toBe(false);
  expect(mobileLayoutViewport({ width: 1_280, height: 800 })).toBe(false);
});

test("the host's media query and the selection viewport are one pair of numbers", () => {
  /* If someone retunes the breakpoint, both sides move together — the drift
     this module exists to prevent. The comma is a media-query-list OR. */
  expect(ATTENTION_MIN_BOARD_WIDTH).toBe(640);
  expect(ATTENTION_MIN_BOARD_HEIGHT).toBe(600);
  expect(MOBILE_LAYOUT_QUERY).toBe(`(max-width: ${ATTENTION_MIN_BOARD_WIDTH - 1}px), (max-height: ${ATTENTION_MIN_BOARD_HEIGHT - 1}px)`);
});
