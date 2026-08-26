/*
 * How the mandate card reads one delivered mandate (#1166).
 *
 * WHICH row is a mandate is delivery evidence, not text: the seat records the
 * identity of the delivery that created it, and the provenance seam projects
 * that fact onto exactly that row. This module only reads the text of a row
 * already known to be one, and answers the two things the card shows: how long
 * the whole delivery is, and where the rotation handoff starts.
 *
 * Pure and render-time only: no transcript byte changes, and nothing here is
 * stored.
 */

/** The headings a rotation handoff is composed under (`seatCommand.ts`), and
    the compact history variant. Matched at the start of a line, so the same
    words quoted inside a mandate never split it. */
const HANDOFF_HEADINGS = ["## Handoff from your predecessor", "## Rotation history"] as const;

export interface MandateMessage {
  /** Lines of the WHOLE delivered message, sections included — the size the
      card is standing in for. */
  lines: number;
  /** The mandate proper, without the rotation handoff. */
  mandate: string;
  /** The rotation handoff, when this delivery carried one. */
  handoff: string | null;
}

/** Offset of the handoff heading that opens a line, or -1. */
function handoffStart(text: string): number {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (HANDOFF_HEADINGS.some((heading) => line.startsWith(heading))) return offset;
    offset += line.length + 1;
  }
  return -1;
}

export function mandateMessage(text: string): MandateMessage {
  const lines = text.split("\n").length;
  const start = handoffStart(text);
  if (start < 0) return { lines, mandate: text.trim(), handoff: null };
  return { lines, mandate: text.slice(0, start).trimEnd(), handoff: text.slice(start).trim() };
}
