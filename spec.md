# Issue 24: preserve reading-pane state during activity reordering

## Task statement

Fix the reading-pane scroll jump that occurs when scheme activity changes pane ordering. Keep pane hosts stable in the DOM while allowing their visual positions to update, so browser-owned reading state survives an overtake.

## Acceptance criteria

- AC1: Scheme pane hosts retain stable DOM order while freshness changes their visual order.
- AC2: An activity overtake preserves the reading pane's scroll position.
- AC3: An activity overtake preserves focus, text selection, and selected state.
- AC4: Pane identity and existing scheme ordering behavior remain unchanged outside DOM placement.
- AC5: A deterministic DOM regression test covers an overtake while a pane is being read.
- AC6: `bun test` passes.
- AC7: `bunx tsc --noEmit` passes.
