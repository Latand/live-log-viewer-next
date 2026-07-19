# Issue #419 (reopened) — chat-first mobile conversation shell

Deterministic, fully **synthetic** evidence for the chat-first mobile repair. No
operator project, path, account, or state appears here — the frames are captured
against the pinned demo fixture runtime (isolated `$HOME`, fixed clock) with
three fictional `atlas` pipelines injected by `capture.ts`.

## Regenerate

```
bun docs/media/issue-419-chat-first/capture.ts
```

Boots the demo runtime, drives local headless Chrome over the docker-bridge dev
origin (`172.17.0.1`, the fixture's `LLV_DEV_ORIGINS` allowlist), and writes the
three PNGs. Each phone frame **asserts before capture**:

- `document.scrollWidth === window.innerWidth` — no document-level horizontal
  overflow (the #353 class);
- the focus shell exposes `data-chat-min-share >= 0.6` — the transcript owns at
  least 60% of the usable viewport before the keyboard opens (see
  `src/components/mobile/chatBudget.ts`);
- the focused chat renders **zero** `mobile-bottom-shelf` rows — every secondary
  surface (pipelines, handoff, hidden/readiness) reserves no persistent bottom
  height and opens from a compact top-chrome trigger or overlay instead.

## Frames

| File | Viewport | What it shows |
| --- | --- | --- |
| `chat-first-390.png` | 390×844 | Phone chat-first shell: one compact conversation header (memory/goal/model chips + runtime controls folded behind the `›` details disclosure), the transcript dominant, the composer as one compact row, the docked pipelines as a top-strip trigger, and the handoff/hidden shelf as a header trigger — no persistent bottom rows. |
| `chat-first-430.png` | 430×932 | The same shell at the larger pinned frame; the extra height goes to the transcript. |
| `board-desktop.png` | 1920×1080 | Desktop board, unchanged: the scheme keeps every metadata chip and the runtime strip inline. The mobile fold is gated by `useIsMobile`, so desktop is untouched. |

Gate output from the capture run:

```
chat-first-390.png chat-first gate: minShare 0.6, bottomShelfRows 0, pipelineTriggers 1, scrollWidth 390 === innerWidth 390
chat-first-430.png chat-first gate: minShare 0.6, bottomShelfRows 0, pipelineTriggers 1, scrollWidth 430 === innerWidth 430
```
