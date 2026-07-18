import type { TFunction } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";

import type { Camera } from "./Minimap";
import { GAP_X, NODE_W, type SchemeLayout, type SchemeRect } from "./layout";

/**
 * Pure geometry for spatial keyboard navigation on the scheme board (issue #27).
 * DOM-free and deterministic — the board's Arrow keys pick agent windows by
 * world position (never DOM/freshness order) and the keyboard zoom ladder snaps
 * to framings that show whole windows. Everything here is a plain function of
 * rects + camera, so it runs under `bun test` like `lasso.ts`/`taskGeometry.ts`.
 */

export type NavDir = "up" | "down" | "left" | "right";

/** Arrow key → direction, or null for any other key. */
export function keyToDir(key: string): NavDir | null {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    default:
      return null;
  }
}

/** What the camera should do when the followed anchor is re-laid-out. */
export type ReflowPlan =
  /** The anchor moved: translate the camera by −(dx, dy)·z to hold its screen
      spot (the caller applies the ×z and sign). */
  | { kind: "translate"; dx: number; dy: number }
  /** The anchor left the layout: drop follow and clear the selection. */
  | { kind: "drop" }
  /** Nothing to do (no prior rect, or the anchor did not move). */
  | { kind: "none" };

/** Sub-pixel jitter that must not trigger a follow glide. */
const MOVE_EPS = 0.5;

/**
 * Decide the follow reaction to a relayout: `next` is the anchor's rect in the
 * new layout (undefined/null ⇒ it left the board). Pure so the follow lifecycle
 * is unit-testable without a renderer.
 */
export function planReflow(prev: SchemeRect | null, next: SchemeRect | null | undefined): ReflowPlan {
  if (!next) return { kind: "drop" };
  if (!prev) return { kind: "none" };
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  if (Math.abs(dx) < MOVE_EPS && Math.abs(dy) < MOVE_EPS) return { kind: "none" };
  return { kind: "translate", dx, dy };
}

/** A world-space box the camera can land on, tagged with its selection key. */
export interface NavTarget extends SchemeRect {
  key: string;
}

/* Directional-pick tuning (exported so the tests pin the exact behaviour). */
/** Candidate must sit at least this far along the primary axis to count — a
    tiny forward nudge is the same band, not a step. */
export const DP_MIN = 8;
/** Secondary-axis penalty per tier: same-band ≪ 90° cone ≪ half-plane. */
export const TIER1_S = 0.3;
export const TIER2_S = 2;
export const TIER3_S = 4;

/* Readable-zoom bounds for the keyboard ladder. MAX_Z mirrors useSchemeCamera's
   clamp ceiling; LABEL_Z mirrors SchemeBoard's label-fade threshold — below it
   panes are unreadable labels and the deeper overview belongs to Fit All. */
export const MAX_Z = 1.6;
export const LABEL_Z = 0.45;
/* Ladder framings run 1 window up to this many across before dropping under the
   readable floor; the loop also stops at LABEL_Z, this is a hard backstop. */
const MAX_LADDER_N = 20;

/** Every layout entry the camera can select — nodes, drafts, mini-stacks, decks
    (exactly the `data-scheme-node` set). Task cards live elsewhere and are not
    navigation targets. */
export function collectNavTargets(layout: SchemeLayout, extraRects?: ReadonlyMap<string, SchemeRect>): NavTarget[] {
  const out: NavTarget[] = [];
  for (const [key, rect] of layout.byPath) out.push({ key, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  if (extraRects) for (const [key, rect] of extraRects) out.push({ key, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  return out;
}

/**
 * Screen-reader label for a nav-target key. A real conversation node announces
 * its clean title; virtual layout keys must never leak a filesystem path or a
 * raw `::stack` suffix — a quiet-branch stack reads as "N quiet branches under
 * <parent title>", and drafts/decks drop their `draft::`/`deck::` prefix.
 */
export function navTargetLabel(layout: SchemeLayout, key: string, t: TFunction, extraLabels?: ReadonlyMap<string, string>): string {
  const extra = extraLabels?.get(key);
  if (extra) return extra;
  const node = layout.nodes.find((n) => n.file.path === key);
  if (node) return cleanTitle(node.file.title, 80);
  const stack = layout.stacks.find((s) => s.key === key);
  if (stack) {
    const parent = layout.nodes.find((n) => n.file.path === stack.parent);
    const title = parent ? cleanTitle(parent.file.title, 60) : null;
    return title
      ? t("scheme.navStack", { count: stack.items.length, title })
      : t("scheme.navStackBare", { count: stack.items.length });
  }
  return key.replace(/^(?:draft|deck)::/, "");
}

const overlap1D = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

interface Metric {
  key: string;
  /** Distance along the direction of travel (always > 0 for a real candidate). */
  dp: number;
  /** Absolute distance on the perpendicular axis. */
  ds: number;
  /** Extent overlap on the perpendicular axis (> 0 ⇒ same row/column band). */
  ov: number;
}

/* dp/ds/ov of candidate B relative to anchor A for one direction. */
function metric(a: NavTarget, b: NavTarget, dir: NavDir): Metric {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  let dp: number;
  let ds: number;
  let ov: number;
  if (dir === "right") {
    dp = bcx - acx;
    ds = Math.abs(bcy - acy);
    ov = overlap1D(a.y, a.y + a.h, b.y, b.y + b.h);
  } else if (dir === "left") {
    dp = acx - bcx;
    ds = Math.abs(bcy - acy);
    ov = overlap1D(a.y, a.y + a.h, b.y, b.y + b.h);
  } else if (dir === "down") {
    dp = bcy - acy;
    ds = Math.abs(bcx - acx);
    ov = overlap1D(a.x, a.x + a.w, b.x, b.x + b.w);
  } else {
    dp = acy - bcy;
    ds = Math.abs(bcx - acx);
    ov = overlap1D(a.x, a.x + a.w, b.x, b.x + b.w);
  }
  return { key: b.key, dp, ds, ov };
}

const EPS = 1e-9;

/* Lowest `dp + weight·ds` wins; ties break by smaller ds, then lexicographic
   key — so the pick is fully deterministic and array-order independent. */
function bestOf(cands: readonly Metric[], weight: number): string | null {
  let best: { key: string; score: number; ds: number } | null = null;
  for (const c of cands) {
    const score = c.dp + weight * c.ds;
    if (
      !best ||
      score < best.score - EPS ||
      (Math.abs(score - best.score) < EPS && (c.ds < best.ds - EPS || (Math.abs(c.ds - best.ds) < EPS && c.key < best.key)))
    ) {
      best = { key: c.key, score, ds: c.ds };
    }
  }
  return best?.key ?? null;
}

/**
 * The next agent window in `dir` from `fromKey`, or null at an edge (no wrap, no
 * cycle — on a 26,000px world a wrap teleport destroys the spatial model).
 * Three tiers make traversal total on ragged boards: same-band neighbours first,
 * then a 90° cone, then the whole forward half-plane.
 */
export function pickDirectional(targets: readonly NavTarget[], fromKey: string, dir: NavDir): string | null {
  const anchor = targets.find((t) => t.key === fromKey);
  if (!anchor) return null;
  const cands: Metric[] = [];
  for (const b of targets) {
    if (b.key === fromKey) continue;
    const m = metric(anchor, b, dir);
    if (m.dp > DP_MIN) cands.push(m);
  }
  if (!cands.length) return null;
  const tier1 = cands.filter((c) => c.ov > 0);
  if (tier1.length) return bestOf(tier1, TIER1_S);
  const tier2 = cands.filter((c) => c.ds <= c.dp);
  if (tier2.length) return bestOf(tier2, TIER2_S);
  return bestOf(cands, TIER3_S);
}

/* World-space centre of a target mapped into viewport pixels. */
const screenCenter = (t: NavTarget, cam: Camera) => ({ x: (t.x + t.w / 2) * cam.z + cam.x, y: (t.y + t.h / 2) * cam.z + cam.y });

/* Fraction of a target's on-screen area that lies inside the viewport. */
function visibleFraction(t: NavTarget, cam: Camera, vp: { w: number; h: number }): number {
  const left = t.x * cam.z + cam.x;
  const top = t.y * cam.z + cam.y;
  const w = t.w * cam.z;
  const h = t.h * cam.z;
  if (w <= 0 || h <= 0) return 0;
  const ix = Math.max(0, Math.min(left + w, vp.w) - Math.max(left, 0));
  const iy = Math.max(0, Math.min(top + h, vp.h) - Math.max(top, 0));
  return (ix * iy) / (w * h);
}

/**
 * Start target for the first Arrow press when nothing is selected: the window
 * whose centre is closest to the viewport centre in screen space. A selection
 * that is still ≥50% on screen keeps its anchor, so re-baselining never causes a
 * surprise jump on the first press.
 */
export function nearestToViewportCenter(
  targets: readonly NavTarget[],
  cam: Camera,
  vp: { w: number; h: number },
  selectedKey?: string | null,
): string | null {
  if (selectedKey) {
    const sel = targets.find((t) => t.key === selectedKey);
    if (sel && visibleFraction(sel, cam, vp) >= 0.5) return selectedKey;
  }
  const vx = vp.w / 2;
  const vy = vp.h / 2;
  let best: { key: string; d: number } | null = null;
  for (const t of targets) {
    const c = screenCenter(t, cam);
    const d = Math.hypot(c.x - vx, c.y - vy);
    if (!best || d < best.d - EPS || (Math.abs(d - best.d) < EPS && t.key < best.key)) best = { key: t.key, d };
  }
  return best?.key ?? null;
}

/**
 * Keyboard zoom ladder for an anchor rect: ascending zoom levels that each frame
 * a whole number of windows across. Step 1 fits the anchor alone (capped at
 * MAX_Z); step n fits n node-widths + gaps, kept only while it stays at/above
 * the readable floor LABEL_Z. Wheel/pinch stay continuous — this is keys only.
 */
export function zoomLadderSteps(anchor: SchemeRect, vp: { w: number; h: number }): number[] {
  const usableW = vp.w - 48;
  const usableH = vp.h - 48;
  const z1 = Math.min(usableW / anchor.w, usableH / anchor.h, MAX_Z);
  const set = new Set<number>([z1]);
  for (let n = 2; n <= MAX_LADDER_N; n++) {
    const zn = usableW / (n * NODE_W + (n - 1) * GAP_X);
    if (zn < LABEL_Z) break;
    set.add(zn);
  }
  return [...set].sort((a, b) => a - b);
}

/** Next ladder step strictly beyond the current zoom (`dir` +1 in / −1 out), or
    null at the ceiling/floor. The ±1% deadband stops a step that equals the
    current zoom from being re-selected. */
export function nextZoomStep(steps: readonly number[], currentZ: number, dir: 1 | -1): number | null {
  if (dir > 0) {
    let pick: number | null = null;
    for (const s of steps) if (s > currentZ * 1.01 && (pick === null || s < pick)) pick = s;
    return pick;
  }
  let pick: number | null = null;
  for (const s of steps) if (s < currentZ * 0.99 && (pick === null || s > pick)) pick = s;
  return pick;
}
