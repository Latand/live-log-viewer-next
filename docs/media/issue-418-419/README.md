# #418 / #419 mobile recovery — visual evidence

Deterministic capture of the chat-first mobile surface and bounded map, carried
forward through the reviewed PR #431 base
`08b12caba69f31995870ebe841217ba51e0163dd`. That base includes the preserved
#418/#419 mobile recovery and the reconciled #353 pipeline semantics.

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

## Reviewed base / gate status

- Reviewed base: `08b12caba69f31995870ebe841217ba51e0163dd`.
- Standalone TypeScript: `bunx tsc --noEmit` passes. The earlier
  `src/lib/pipelines/engine.ts` `failEdgeInput` narrowing failure was resolved by
  `7579942a69f44176d63294c09ce4cdd025fc4568` for issue **#429**, which is an
  ancestor of the reviewed base.
- Production build: `next build --webpack` compiles successfully.
