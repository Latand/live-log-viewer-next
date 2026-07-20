# Issue 263 — minimap full-world extent and viewport clamp

Synthetic geometry evidence only. Every value below is derived from
constructed world/camera fixtures in the focused tests
(`Minimap.render.test.tsx`, `taskGeometry.test.ts`); no production project,
account, task, or transcript data is used.

## Contract

The desktop minimap (`src/components/scheme/Minimap.tsx`, 216 × 148 px) must
scale down the **complete** current layout world and keep the accent viewport
frame fully inside the map at every pan/zoom corner — including when the
camera's edge-keep clamp lets the view drift past the placed geometry.

## World growth (both axes)

`taskWorldBounds` derives the world from the live layout box unioned with every
placed card, so a node added far right/down after panning is always enclosed:

| Fixture | Before | After node added | Grown axis |
| --- | --- | --- | --- |
| node at `x=4000` | right edge `1000` | right edge `4000 + TASK_W + 140` | width only |
| node at `y=5000` | bottom edge `800` | bottom edge `5000 + 120 + 140` | height only |
| scattered large world | — | `x∈[-740, 6400]`, `y∈[-540, 7260]` | both |

## Viewport indicator stays inside the map

`minimapExtent(world, cam, vp)` grows the layout world to also enclose the live
viewport rect (`x=-cam.x/z`, `y=-cam.y/z`, `w=vp.w/z`, `h=vp.h/z`). The camera
keeps clamping and fitting to the tighter layout `world`, so this display box
growing as the view drifts **never re-snaps the camera**.

Synthetic drift fixture — `world = {0,0,1000,1000}`, `cam = {x:-2600, y:-1900,
z:1.4}`, `vp = {800,600}`:

- Viewport in world space: `{x:1857.1, y:1357.1, w:571.4, h:428.6}` — its origin
  sits well past the world's right/bottom edges.
- **Before #263** (scale to world only): map scale `0.148`, viewport frame left
  edge maps to screen `x ≈ 309 px`, entirely off the 216 px map → clipped and
  invisible.
- **After #263** (scale to `world ∪ viewport`, extent `{0,0,2428.6,1785.7}`):
  map scale `0.0829`, the frame lands at screen `x ∈ [161, 209]`,
  `y ∈ [112, 148]` — fully inside the fixed map, flush against the drifted far
  edge, correctly placed and scaled.

The regression test parses the rendered SVG transform and asserts the frame's
four screen edges stay within `[−2, 216+2] × [−2, 148+2]` (the ±2 tolerance
covers the constant 2.5 px stroke straddling the boundary).

## Preserved behavior

- Issue #343 current-work framing, immutable stored task coordinates, and the
  compact pipeline rails render unchanged — `minimapExtent` only affects the
  minimap's own down-scale, not the camera's clamp/fit or any stored position.
- Issue #418 bounded mobile map (`MobileMapLite`) is a separate component and is
  untouched.

## Verification

- `bun test src/components/scheme src/components/mobile` — 557 pass.
- `bunx tsc --noEmit` — clean.
- `bunx eslint` on the three changed files — clean.
- `bun run build` — production build succeeds.
