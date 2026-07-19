import type { SchemeRect } from "./layout";

export interface BadgePlacement<T extends { id: string }> {
  kind: "badge";
  child: T;
  x: number;
  y: number;
  size: number;
  column: number;
  row: number;
}

export interface BadgeOverflowPlacement {
  kind: "overflow";
  count: number;
  x: number;
  y: number;
  size: number;
  column: number;
  row: number;
}

export type SubagentBadgePlacement<T extends { id: string }> = BadgePlacement<T> | BadgeOverflowPlacement;

export const SUBAGENT_BADGE_HARD_CAP = 12;

/** World-space positions beside a card. Input order is the bottom-up display order. */
export function layoutBadges<T extends { id: string }>(
  children: readonly T[],
  cardRect: SchemeRect,
  badgeSize = 30,
  gap = 6,
): SubagentBadgePlacement<T>[] {
  if (!children.length) return [];
  const rowsPerColumn = Math.max(1, Math.floor((cardRect.h + gap) / (badgeSize + gap)));
  const bottom = cardRect.y + Math.max(0, cardRect.h - badgeSize);
  const visible = children.length > SUBAGENT_BADGE_HARD_CAP
    ? children.slice(0, SUBAGENT_BADGE_HARD_CAP - 1)
    : children;
  const positions: SubagentBadgePlacement<T>[] = visible.map((child, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    return {
      kind: "badge",
      child,
      x: cardRect.x + cardRect.w + gap + column * (badgeSize + gap),
      y: bottom - row * (badgeSize + gap),
      size: badgeSize,
      column,
      row,
    };
  });
  if (visible.length < children.length) {
    const index = visible.length;
    const column = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    positions.push({
      kind: "overflow",
      count: children.length - visible.length,
      x: cardRect.x + cardRect.w + gap + column * (badgeSize + gap),
      y: bottom - row * (badgeSize + gap),
      size: badgeSize,
      column,
      row,
    });
  }
  return positions;
}
