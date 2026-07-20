# #353 — restore the colored pipeline halo with real conversation cards

The colored `SchemeGroup` halo is the **sole** desktop pipeline region. It encloses
every materialized `BranchPane` conversation plus `StagePlaceholderPane` cards for
the future stages, at their real stage positions. A single compact header (title,
progress, lifecycle, disclosure) is attached to the halo. Completed attempts stay
compact at their stage position, and pass/fail edges route inside the halo. The
detached `PipelineGroup` body, the duplicate stage graph, the tall draft form, and
the large white empty panel are gone.

## Evidence

| Artifact | Shows |
| --- | --- |
| `halo-composition-desktop.svg` | One colored halo enclosing a completed `architect` (compact), the live `builder` conversation card, and a `review` placeholder card, with the compact header on the halo and pass edges inside it. |
| `halo-composition-390.svg` | The 390px phone: chat owns the viewport, a compact pipeline dock/sheet holds the stage chips, and the document root clips horizontal overflow (`scrollWidth === innerWidth`). |

The SVGs are privacy-safe depictions (synthetic fixture text only). The composition
they depict is asserted deterministically against the **shipped components** by:

- `src/components/scheme/SchemeBoard.pipelineComposition.dom.test.tsx` — renders the
  real `SchemeBoard` with a running pipeline (two materialized stages + one future
  stage) and asserts exactly one `data-scheme-group="pipeline"` halo, the real
  `/arch` and `/build` cards, the `slot::pipe-1::review` placeholder, and the
  absence of any detached body (`data-pipeline-group-body`), control card
  (`data-pipeline-group`), or duplicate graph (`data-scheme-group-strip`,
  `data-pipeline-stage-graph`).
- `src/components/scheme/layout.test.ts` — the halo geometry encloses both the
  materialized node and its future-stage placeholders.
- `src/components/scheme/GroupsLayer.render.test.tsx` — the halo carries only its
  compact header (title, progress `k/n`, lifecycle, disclosure) and no stage graph.
- `src/components/pipelines/pipelinePlaceholderStages.test.ts` — only future stages
  (no launched attempt) become placeholders; completed / folded / zero-stage cases
  grow none.
- `src/components/mobile/MobileFocusView.viewport.dom.test.tsx` — the phone shell
  keeps the chat-first budget and the `overflow-x-clip` / `max-w-[100dvw]` root.
