import { compactDigest, type DigestChip } from "./digest";

/**
 * What the overlay's timeline band shows, at each density (#691).
 *
 * The same conversation renders three ways and none of them owns it, so the
 * decision of *what fits* is a pure function of density and content — not
 * something each rendering works out for itself.
 */

/** Rail is mobile's watching state: one truncated line and nothing else. */
export type TimelineDensity = "rail" | "compact" | "expanded";

export const COMPACT_CLAMP_LINES = 3;
export const EXPANDED_CLAMP_LINES = 6;
/** Compact shows the last two or three turns; the newest agent turn is the one
    clamped hardest, because it is the one that grows without warning. */
export const COMPACT_TURN_COUNT = 3;

export interface OverlayTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  at: string;
  /** A voice transcription still settling. It renders in place at the tail with
      reduced emphasis and is REPLACED by the final text — it never adds a
      second row. */
  partial?: boolean;
}

/** The one timeline element that is neither a message nor a chip (D5): a
    rollover wrote a new session, and this says so and taps through to the one
    before. It appears in compact as well as expanded, because a rollover is
    precisely when the operator needs to know why the agent's memory looks
    shorter than they expected. */
export interface ContinuityEntry {
  previousConversationId: string;
  at: string;
}

export type TimelineEntry =
  | { kind: "turn"; turn: OverlayTurn; clampLines: number }
  | { kind: "chip"; chip: DigestChip };

export interface OverlayTimeline {
  continuity: ContinuityEntry | null;
  /** Oldest first, newest last — the tail is where the eye rests. */
  entries: TimelineEntry[];
  /** "+N updates": chips compact folded away rather than showing. */
  foldedChipCount: number;
  /** "N new" while the operator has scrolled back; tapping it returns to live. */
  newCount: number;
}

export interface TimelineInput {
  density: TimelineDensity;
  turns: readonly OverlayTurn[];
  chips?: readonly DigestChip[];
  continuity?: ContinuityEntry | null;
  /** False once the operator scrolls up. Follow-latest is the default and the
      only thing that auto-scrolls. */
  atTail?: boolean;
  /** Turns the operator has already had on screen; anything past this is "new". */
  lastSeenTurnId?: string | null;
}

function newSince(turns: readonly OverlayTurn[], lastSeenTurnId: string | null | undefined): number {
  if (!lastSeenTurnId) return 0;
  const index = turns.findIndex((turn) => turn.id === lastSeenTurnId);
  return index === -1 ? 0 : turns.length - 1 - index;
}

/** A partial transcription replaces the settled text at the tail rather than
    stacking below it, so the tail never grows a second row mid-utterance. */
function collapsePartials(turns: readonly OverlayTurn[]): OverlayTurn[] {
  const settled = turns.filter((turn) => !turn.partial);
  const partial = turns.find((turn) => turn.partial);
  return partial ? [...settled, partial] : settled;
}

export function buildOverlayTimeline(input: TimelineInput): OverlayTimeline {
  const turns = collapsePartials(input.turns);
  const chips = input.chips ?? [];
  const atTail = input.atTail ?? true;
  const newCount = atTail ? 0 : newSince(turns, input.lastSeenTurnId);

  if (input.density === "rail") {
    /* Watching. One truncated line, and the digests become a counter beside the
       identity dot rather than anything that could grow the sheet. */
    const latest = turns.at(-1);
    return {
      continuity: null,
      entries: latest ? [{ kind: "turn", turn: latest, clampLines: 1 }] : [],
      foldedChipCount: chips.filter((chip) => !chip.seen).length,
      newCount,
    };
  }

  if (input.density === "compact") {
    const { chip, foldedCount } = compactDigest(chips);
    const visibleTurns = turns.slice(-COMPACT_TURN_COUNT);
    const entries: TimelineEntry[] = visibleTurns.map((turn) => ({
      kind: "turn" as const,
      turn,
      clampLines: COMPACT_CLAMP_LINES,
    }));
    /* At most one chip, at the tail where the newest thing belongs. */
    if (chip) entries.push({ kind: "chip", chip });
    return { continuity: input.continuity ?? null, entries, foldedChipCount: foldedCount, newCount };
  }

  /* Expanded: chips render inline in time order, each expandable into the
     event's lineage. Nothing is folded away. */
  const merged: TimelineEntry[] = [
    ...turns.map((turn) => ({ kind: "turn" as const, turn, clampLines: EXPANDED_CLAMP_LINES })),
    ...chips.map((chip) => ({ kind: "chip" as const, chip })),
  ].sort((left, right) => {
    const leftAt = Date.parse(left.kind === "turn" ? left.turn.at : left.chip.at);
    const rightAt = Date.parse(right.kind === "turn" ? right.turn.at : right.chip.at);
    return leftAt - rightAt;
  });

  return { continuity: input.continuity ?? null, entries: merged, foldedChipCount: 0, newCount };
}
