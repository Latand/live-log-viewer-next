/**
 * Geometry of the persistent root-conversation overlay (#691, delivered with
 * #688).
 *
 * One conversation, three renderings (D2): a desktop document
 * Picture-in-Picture window, the identical component docked in the page, and a
 * mobile sheet over the Viewer. All three read one state and none owns it, so
 * every number here is a pure function of a measured size — there is no
 * arrangement *mode* to keep in sync between the renderings.
 *
 * Pure and DOM-free on purpose: the layout rules are the part worth pinning.
 */

/* ── Desktop ──────────────────────────────────────────────────────────────── */

/** The window opens here. */
export const PIP_DEFAULT_SIZE = { width: 380, height: 220 } as const;
/** A comfortable expanded window, for the "grow me" affordance to aim at. */
export const PIP_EXPANDED_SIZE = { width: 420, height: 560 } as const;
/** The in-page dock matches the window's width exactly, because it is the same
    component and crossing the boundary must not reflow anything. */
export const DOCK_WIDTH = PIP_DEFAULT_SIZE.width;

/**
 * There is no expand *mode*: the arrangement switches on measured height, so
 * resizing the window IS the expand gesture. One component, two arrangements,
 * no state to keep in sync and no control to hunt for.
 */
export const ARRANGEMENT_THRESHOLD = 360;

export type OverlayArrangement = "compact" | "expanded";

export function arrangementFor(height: number): OverlayArrangement {
  return height >= ARRANGEMENT_THRESHOLD ? "expanded" : "compact";
}

export const DESKTOP_HEADER_H = 36;
export const DESKTOP_COMPOSER_H = 44;
/** Present only when something needs an answer. */
export const DESKTOP_ACTION_H = 40;
/** Window chrome and band padding the four bands do not get: at the opening
    380×220 this is what leaves the timeline the 108px the design budgets. */
export const DESKTOP_CHROME_H = 32;

export interface OverlayBands {
  header: number;
  timeline: number;
  actionRow: number;
  composer: number;
}

/** The four bands at a measured height. The timeline takes all the growth,
    which is the entire difference between the two desktop arrangements. */
export function desktopBands(height: number, hasAction: boolean): OverlayBands {
  const actionRow = hasAction ? DESKTOP_ACTION_H : 0;
  return {
    header: DESKTOP_HEADER_H,
    actionRow,
    composer: DESKTOP_COMPOSER_H,
    timeline: Math.max(0, height - DESKTOP_HEADER_H - DESKTOP_COMPOSER_H - actionRow - DESKTOP_CHROME_H),
  };
}

/* ── Mobile ───────────────────────────────────────────────────────────────── */

/**
 * The operator's priority governs the mobile layout: what is happening in the
 * Viewer above stays visible. The sheet is a controllable cover over live work,
 * never a full-screen chat app — which is why even Full leaves a peek.
 */
export type SheetSnap = "rail" | "half" | "full";

export const SHEET_SNAP_ORDER: readonly SheetSnap[] = ["rail", "half", "full"];

/** Watching: one truncated line, the state word, and the mic. */
export const RAIL_HEIGHT = 64;
export const HALF_FRACTION = 0.45;
export const FULL_FRACTION = 0.92;

export const SHEET_STATE_ROW_H = 44;
export const SHEET_COMPOSER_H = 64;
export const SHEET_ACTION_H = 48;

/**
 * Mobile controls are deliberately LARGER than desktop, and the inversion is
 * the point: the phone is in your hand while you look at something else, so the
 * root conversation's controls are the biggest touch targets in the product.
 * Desktop controls are small because your hands are on a keyboard and the
 * window is taking pixels from your editor.
 */
export const MOBILE_MIC_SIZE = 56;
export const MOBILE_SECONDARY_SIZE = 48;
export const DESKTOP_MIC_SIZE = 32;
export const MOBILE_IDENTITY_DOT = 28;
export const DESKTOP_IDENTITY_DOT = 20;

/** Floored rather than rounded: the fractions describe how much the *sheet* may
    take, so rounding up would quietly borrow a pixel from the work surface the
    whole mobile arrangement exists to keep visible. */
export function sheetHeights(usableHeight: number): Record<SheetSnap, number> {
  return {
    rail: RAIL_HEIGHT,
    half: Math.floor(usableHeight * HALF_FRACTION),
    full: Math.floor(usableHeight * FULL_FRACTION),
  };
}

/** How much of the Viewer survives at each snap. The peek left at Full is the
    return affordance, and it is why the Viewer never fully disappears. */
export function viewerVisibleHeight(usableHeight: number, snap: SheetSnap): number {
  return usableHeight - sheetHeights(usableHeight)[snap];
}

/** The sheet's internal bands. Same four as desktop; the timeline takes the
    growth here too. */
export function sheetBands(sheetHeight: number, hasAction: boolean): OverlayBands {
  const actionRow = hasAction ? SHEET_ACTION_H : 0;
  return {
    header: SHEET_STATE_ROW_H,
    actionRow,
    composer: SHEET_COMPOSER_H,
    timeline: Math.max(0, sheetHeight - SHEET_STATE_ROW_H - SHEET_COMPOSER_H - actionRow),
  };
}

/** Gestures, and the one rule they all obey. */
export type SheetGesture = "drag-up" | "drag-down" | "tap-state-row";

/**
 * Where a gesture lands.
 *
 * Never a jump of two snaps: two-snap moves come only from an explicit control,
 * because a gesture that skips a stop is a gesture that surprises you. Tapping
 * the state row is the Rail↔Half toggle, and from Full it steps down one rather
 * than collapsing all the way.
 */
export function nextSnap(current: SheetSnap, gesture: SheetGesture): SheetSnap {
  const index = SHEET_SNAP_ORDER.indexOf(current);
  if (gesture === "drag-up") return SHEET_SNAP_ORDER[Math.min(index + 1, SHEET_SNAP_ORDER.length - 1)]!;
  if (gesture === "drag-down") return SHEET_SNAP_ORDER[Math.max(index - 1, 0)]!;
  if (current === "rail") return "half";
  return current === "half" ? "rail" : "half";
}

/**
 * Where an arriving attention request leaves the sheet.
 *
 * A handoff never raises the conversation — if it moves the sheet at all it
 * lowers it, so the thing the operator is being pointed at is visible. Nothing
 * else arriving in the timeline moves the sheet by itself at all.
 */
export function snapForAttentionRequest(current: SheetSnap): SheetSnap {
  return current === "full" ? "half" : current;
}

/**
 * The two-composer collision, resolved.
 *
 * The phone already has a composer in the focused conversation pane. Two text
 * inputs on a 390px screen is the worst available outcome, so exactly one is
 * ever expanded: focusing the worker's input drops the root sheet to Rail, and
 * raising the sheet collapses the worker composer to a "reply here" chip. Both
 * stay one tap away and typing is never ambiguous about where it goes — and
 * since typing to a worker is a delegation act, D1 is intact either way.
 */
export type ComposerFocus = "root" | "worker";

export interface ComposerArrangement {
  snap: SheetSnap;
  /** The worker's pane composer collapses to a chip in its header. */
  workerComposer: "expanded" | "chip";
}

export function composerArrangement(snap: SheetSnap, focus: ComposerFocus): ComposerArrangement {
  if (focus === "worker") return { snap: "rail", workerComposer: "expanded" };
  return { snap: snap === "rail" ? "half" : snap, workerComposer: "chip" };
}
