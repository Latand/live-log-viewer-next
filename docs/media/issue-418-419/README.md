# #418 / #419 mobile recovery — visual evidence

Deterministic capture of the chat-first mobile surface and bounded map on top of
current `main` (0f239192) with the preserved mobile implementation
(bc619ebd) cherry-picked and reconciled against the #353 pipeline semantics.

Regenerate:

```
bun docs/media/issue-418-419/capture-418-419.ts
```

The script boots the pinned demo fixture runtime, injects three schema-v3
pipelines (a live fail-edge cycle, a needs-decision chain, and a completed
chain), and drives headless Chrome over CDP with a fixed clock.

| File | Viewport | What it shows |
| --- | --- | --- |
| `board-desktop.png` | 1920×1080 | Desktop board unchanged: the live pipeline renders as an on-canvas group with three conversations; the other two pipelines dock in the bottom rail. |
| `chat-first-390.png` | 390×844 | Chat dominant, compact pipeline disclosure collapsed to one row (`3 pipelines · 2 need you · 1 done`), map affordance in the header. |
| `map-lite-390.png` | 390×844 | Bounded `MobileMapLite` with the node grid + All/Current framing and the same pipeline disclosure. |

## Overflow contract (#353, preserved)

Both 390px frames assert `document.scrollWidth === window.innerWidth` before the
screenshot is written; the run logged:

```
chat-first-390.png overflow gate: scrollWidth 390 === innerWidth 390
map-lite-390.png overflow gate: scrollWidth 390 === innerWidth 390
```

## Build / gate status

- Production build: `next build --webpack` **compiles successfully** ("Compiled
  successfully in ~21s").
- The bundled `next build` TypeScript pass fails only in
  `src/lib/pipelines/engine.ts` (`failEdgeInput` narrowing) — a pre-existing
  defect on `main` outside the mobile scope, owned by issue **#429**. It is
  unchanged by this work; the mobile diff touches no pipeline-engine source.
