import { focusTargetAnchorKeys, geometricFrameRect, isGeometricTarget } from "./targets";
import type { FocusFrame, FocusRect, FocusResolutionKind, FocusTarget } from "./types";

/**
 * Resolving a target against the board as it is *now* (#688).
 *
 * Anchor and frame are separate so that a vanished anchor still leaves a usable
 * destination. Resolution is therefore never a boolean: it reports `exact`,
 * `approximate` or `lost`, and the degraded cases are visible in the card and
 * spoken aloud, because arriving somewhere empty without being told why is
 * worse than not going.
 *
 * Deliberately pure and camera-free: the whole target model is testable without
 * moving anything.
 */

/** A named thing on the board a spoken sentence can borrow a name from. */
export interface NamedFrame {
  key: string;
  label: string;
  rect: FocusRect;
}

/**
 * A read-only view of one project's current layout — the minimum a resolution
 * needs. The board's own layout builds one of these; a fixture can too, which is
 * why nothing here imports the renderer.
 */
export interface FocusFrameIndex {
  project: string;
  boardRevision: number | null;
  /** The anchor's rect in the CURRENT layout, or null when it is gone. */
  rectFor(anchorKey: string): FocusRect | null;
  /**
   * Optional: the layout key this anchor actually resolves THROUGH, when the
   * board holds it under a different name than the target asks for.
   *
   * Only aliased anchors need it, and today that means one: a pipeline stage is
   * a placeholder slot until it launches, and afterwards the layout holds it as
   * the conversation card of the agent running it. A camera never notices —
   * `rectFor` already returns the right rectangle. A surface that navigates by
   * KEY rather than by coordinate does: told only `slot::<pipeline>::<stage>`,
   * it finds nothing on its own list and reports a target it is in fact
   * displaying as lost.
   *
   * Returns the key itself when no alias applies, and null when the anchor is
   * not in the layout at all.
   */
  concreteAnchorKey?(anchorKey: string): string | null;
  /** Optional: named objects, used only to phrase a geometric destination. */
  named?: readonly NamedFrame[];
}

/**
 * The keys a key-navigating surface may pin for this anchor, best first.
 *
 * The concrete key leads, because it is the one the board is actually drawing;
 * the anchor's own key follows so a surface that lists targets under the
 * requested name still matches. Anchors the layout does not hold at all are
 * dropped — that is what makes an empty result mean "there is nothing on this
 * board to land on" rather than "nobody looked".
 */
export function navigableAnchorKeys(index: FocusFrameIndex, anchorKeys: readonly string[]): string[] {
  const navigable: string[] = [];
  for (const key of anchorKeys) {
    if (index.rectFor(key) === null) continue;
    const concrete = index.concreteAnchorKey?.(key) ?? key;
    for (const candidate of concrete && concrete !== key ? [concrete, key] : [key]) {
      if (!navigable.includes(candidate)) navigable.push(candidate);
    }
  }
  return navigable;
}

export interface FocusResolutionResult {
  resolution: FocusResolutionKind;
  /** Where the camera goes; null only when the resolution is `lost`. */
  frame: FocusFrame | null;
  /** What is actually navigated to. For an `approximate` resolution this is the
      degraded point target at the stored frame, not the vanished anchor. */
  target: FocusTarget | null;
  /** The nearest named object, for a destination that has no name of its own:
      "just below the reviewer node in that pipeline". Null when nothing named
      is near, in which case the spoken form says "an empty area of the board"
      rather than inventing a landmark. */
  nearestAnchor: { key: string; label: string } | null;
  /** True when the anchor was gone and the stored frame stood in for it.
      One-way, and always spoken. */
  degraded: boolean;
}

const centreOf = (rect: FocusRect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

/** Nearest named object to a frame, by centre distance. Excludes the anchor
    itself so a target never borrows its own name. */
export function nearestNamedFrame(index: FocusFrameIndex, rect: FocusRect, exclude: readonly string[] = []): { key: string; label: string } | null {
  const from = centreOf(rect);
  let best: { key: string; label: string; distance: number } | null = null;
  for (const candidate of index.named ?? []) {
    if (exclude.includes(candidate.key)) continue;
    const to = centreOf(candidate.rect);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (!best || distance < best.distance) best = { key: candidate.key, label: candidate.label, distance };
  }
  return best ? { key: best.key, label: best.label } : null;
}

function frameOf(index: FocusFrameIndex, rect: FocusRect): FocusFrame {
  return { project: index.project, rect, boardRevision: index.boardRevision };
}

const lost = (): FocusResolutionResult => ({ resolution: "lost", frame: null, target: null, nearestAnchor: null, degraded: false });

/**
 * Resolve a target at acceptance time, always against the current layout.
 *
 * The stored frame is never used when the anchor is still there: the board
 * reflows, so a rect recorded at creation is stale the moment a sibling appears.
 * It is kept for exactly one purpose — being the destination when the anchor
 * itself is gone.
 *
 * `index` is null when the project itself is no longer on the board.
 */
export function resolveFocusTarget(
  target: FocusTarget,
  frameAtCreation: FocusFrame | null,
  index: FocusFrameIndex | null,
): FocusResolutionResult {
  if (!index) return lost();

  if (isGeometricTarget(target)) {
    /* A coordinate cannot go stale, so it is exact or it is in another project.
       It never degrades to approximate — there is no anchor to lose. */
    if (target.project !== index.project) return lost();
    const rect = geometricFrameRect(target);
    return {
      resolution: "exact",
      frame: frameOf(index, rect),
      target,
      nearestAnchor: nearestNamedFrame(index, rect),
      degraded: false,
    };
  }

  const keys = focusTargetAnchorKeys(target);
  for (const key of keys) {
    const rect = index.rectFor(key);
    if (rect) {
      return {
        resolution: "exact",
        frame: frameOf(index, rect),
        target,
        nearestAnchor: null,
        degraded: false,
      };
    }
  }

  /* The anchor is gone. If its project is still the one on screen, the frame
     recorded at creation is still a place the operator can be taken — degraded
     to a point, and said out loud as "that's gone now, I'll take you to where
     it was". */
  if (frameAtCreation && frameAtCreation.project === index.project) {
    const centre = centreOf(frameAtCreation.rect);
    return {
      resolution: "approximate",
      frame: frameOf(index, frameAtCreation.rect),
      target: { kind: "point", project: index.project, x: centre.x, y: centre.y },
      nearestAnchor: nearestNamedFrame(index, frameAtCreation.rect, keys),
      degraded: true,
    };
  }

  return lost();
}
