# Issue 438 visual evidence

These images were captured from the repository's isolated production bundle
with synthetic projects created solely for this acceptance pass.

- `pipeline-groups-desktop.png` shows the `pipeline-collision` project. The
  expanded group's header remains at its persisted `(520, 300)` coordinate;
  its body opens upward while the neighbouring task and automatically placed
  pipeline remain clear. Fit All and the minimap include the full group bounds.
- `pipeline-groups-390px.png` shows the pipeline-only `pipeline-mobile` project
  at `390 × 844`. Current framing centers the pipeline outline, the full desktop
  group is absent, and the mobile pipeline sheet remains available from the
  bottom dock.

The live 390 px browser check applied a manual wheel zoom, observed the outline
at `{ x: 15, y: 378.5, w: 360, h: 76 }`, waited through the 10-second files
poll, and observed the same rectangle afterward.

The captures are scoped to the board and mobile main surfaces. Account panels,
resource readings, filesystem paths, and conversation content are excluded.
