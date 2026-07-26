import { expect, test } from "bun:test";

import { digestChips, type DigestEvent } from "./digest";
import { buildOverlayTimeline, COMPACT_CLAMP_LINES, EXPANDED_CLAMP_LINES, type OverlayTurn } from "./timeline";

const turn = (id: string, role: OverlayTurn["role"], at: string, partial = false): OverlayTurn => ({
  id,
  role,
  text: `${role} said ${id}`,
  at,
  ...(partial ? { partial: true } : {}),
});

const turns: OverlayTurn[] = [
  turn("t1", "user", "2026-07-01T10:00:00.000Z"),
  turn("t2", "agent", "2026-07-01T10:00:10.000Z"),
  turn("t3", "user", "2026-07-01T10:00:20.000Z"),
  turn("t4", "agent", "2026-07-01T10:00:30.000Z"),
];

const chips = digestChips([
  { eventId: "e1", kind: "stage-started", summary: "Stage started.", at: "2026-07-01T10:00:15.000Z" } satisfies DigestEvent,
  { eventId: "e2", kind: "review-verdict", summary: "Review: request-changes.", at: "2026-07-01T10:00:25.000Z" } satisfies DigestEvent,
]);

test("compact shows the last few turns, clamped, with one chip at the tail", () => {
  const timeline = buildOverlayTimeline({ density: "compact", turns, chips });

  expect(timeline.entries.filter((entry) => entry.kind === "turn")).toHaveLength(3);
  expect(timeline.entries.every((entry) => entry.kind !== "turn" || entry.clampLines === COMPACT_CLAMP_LINES)).toBe(true);
  expect(timeline.entries.at(-1)).toEqual({ kind: "chip", chip: chips[1]! });
  expect(timeline.foldedChipCount).toBe(1);
});

test("expanded renders every chip inline in time order and folds nothing", () => {
  const timeline = buildOverlayTimeline({ density: "expanded", turns, chips });

  expect(timeline.entries.map((entry) => (entry.kind === "turn" ? entry.turn.id : entry.chip.eventId)))
    .toEqual(["t1", "t2", "e1", "t3", "e2", "t4"]);
  expect(timeline.foldedChipCount).toBe(0);
  expect(timeline.entries.every((entry) => entry.kind !== "turn" || entry.clampLines === EXPANDED_CLAMP_LINES)).toBe(true);
});

test("rail is one truncated line, with digests becoming a counter rather than height", () => {
  const timeline = buildOverlayTimeline({ density: "rail", turns, chips });

  expect(timeline.entries).toEqual([{ kind: "turn", turn: turns[3]!, clampLines: 1 }]);
  /* At Rail a digest never expands the sheet; it increments a small counter
     beside the identity dot. */
  expect(timeline.foldedChipCount).toBe(2);
});

test("the continuity marker rides at the head in compact as well as expanded", () => {
  const continuity = { previousConversationId: "conversation_a", at: "2026-07-01T09:00:00.000Z" };

  expect(buildOverlayTimeline({ density: "compact", turns, continuity }).continuity).toEqual(continuity);
  expect(buildOverlayTimeline({ density: "expanded", turns, continuity }).continuity).toEqual(continuity);
  /* Rail has room for one line of conversation and nothing else. */
  expect(buildOverlayTimeline({ density: "rail", turns, continuity }).continuity).toBeNull();
});

test("a partial transcription replaces the tail rather than adding a second row", () => {
  const settling = [...turns, turn("t5", "user", "2026-07-01T10:00:40.000Z", true)];

  const timeline = buildOverlayTimeline({ density: "expanded", turns: settling });

  expect(timeline.entries).toHaveLength(5);
  const tail = timeline.entries.at(-1)!;
  expect(tail.kind === "turn" && tail.turn.partial).toBe(true);

  /* And the settled text takes its place without leaving the partial behind. */
  const final = buildOverlayTimeline({ density: "expanded", turns: [...turns, turn("t5", "user", "2026-07-01T10:00:40.000Z")] });
  expect(final.entries).toHaveLength(5);
  expect(final.entries.every((entry) => entry.kind !== "turn" || !entry.turn.partial)).toBe(true);
});

test("scrolling back counts what arrived; following the latest counts nothing", () => {
  expect(buildOverlayTimeline({ density: "expanded", turns, atTail: false, lastSeenTurnId: "t2" }).newCount).toBe(2);
  expect(buildOverlayTimeline({ density: "expanded", turns, atTail: true, lastSeenTurnId: "t2" }).newCount).toBe(0);
  expect(buildOverlayTimeline({ density: "expanded", turns, atTail: false, lastSeenTurnId: null }).newCount).toBe(0);
});

test("an empty conversation renders as nothing rather than as a placeholder row", () => {
  const timeline = buildOverlayTimeline({ density: "compact", turns: [] });

  expect(timeline.entries).toEqual([]);
  expect(timeline.newCount).toBe(0);
});
