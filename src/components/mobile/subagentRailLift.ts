import { KEEPOUT_CLEARANCE_PX } from "@/components/scheme/offscreenClusters";

/** The rail's resting offset above the pane area's bottom edge — the pre-#474
    `bottom-20` position, kept as a floor so the rail never slides down toward
    the input when the composer is short (no downward layout jump). */
export const SUBAGENT_RAIL_MIN_BOTTOM_PX = 80;

/** Bottom offset (px) for the phone's side agent rail: high enough that the
    lowest badge — and any title reveal it expands, which shares its row —
    clears the measured composer/input/Send band by the same stable clearance
    gutter the board reserves around keep-out chrome. `composerTop` is the
    composer surface's viewport top (null when no composer is mounted);
    `hostBottom` is the rail's positioning container's viewport bottom. The
    composer can grow to min(38dvh, 20rem) on a phone, so a fixed offset lets
    it swallow the rail — this tracks it instead (issue #474 follow-up). */
export function subagentRailBottom(hostBottom: number, composerTop: number | null): number {
  if (composerTop === null || !Number.isFinite(composerTop) || !Number.isFinite(hostBottom)) {
    return SUBAGENT_RAIL_MIN_BOTTOM_PX;
  }
  const band = Math.ceil(hostBottom - composerTop);
  if (band <= 0) return SUBAGENT_RAIL_MIN_BOTTOM_PX;
  return Math.max(SUBAGENT_RAIL_MIN_BOTTOM_PX, band + KEEPOUT_CLEARANCE_PX);
}
