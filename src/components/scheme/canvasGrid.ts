/**
 * The scheme canvas dot grid (issue #962): one world-space lattice that stays
 * visually SPARSE at every zoom. A fixed world spacing turns into noise when
 * the camera zooms out (24px of world reads as 3px on screen), so the spacing
 * doubles in power-of-two steps until the on-screen tile clears a floor —
 * every second dot survives a step, so the lattice thins in place instead of
 * re-randomizing while the operator zooms.
 */

/** World-space spacing between dots at zoom 1. */
export const GRID_BASE_TILE = 24;

/** Minimum on-screen spacing; below it the grid reads as texture, not anchors. */
export const GRID_MIN_SCREEN_PX = 18;

/** On-screen dot spacing for a zoom level: base × zoom, doubled until sparse.
    Screen-space result always lands in [GRID_MIN_SCREEN_PX, 2·GRID_MIN_SCREEN_PX)
    for zooms below 1; above 1 the native spacing simply grows. */
export function gridTilePx(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return GRID_BASE_TILE;
  let tile = GRID_BASE_TILE * zoom;
  while (tile < GRID_MIN_SCREEN_PX) tile *= 2;
  return tile;
}
