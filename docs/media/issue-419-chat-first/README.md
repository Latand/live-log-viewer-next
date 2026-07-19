# Issue #419 (reopened) — chat-first mobile conversation shell

Deterministic, fully **synthetic** evidence for the chat-first mobile repair. No
operator project, path, account, or state appears here — the frames are captured
against the pinned demo fixture runtime (isolated `$HOME`, fixed clock) with
five fictional `atlas` pipelines injected by `capture.ts`.

## Regenerate

```
bun docs/media/issue-419-chat-first/capture.ts
```

Boots the demo runtime, drives local headless Chrome over the docker-bridge dev
origin (`172.17.0.1`, the fixture's `LLV_DEV_ORIGINS` allowlist), and writes the
three PNGs. Each phone frame **asserts before capture**:

- `document.scrollWidth === window.innerWidth` — no document-level horizontal
  overflow (the #353 class);
- the **measured** transcript share `>= 0.60` — the real LogFeed scroller
  (`[data-log-feed-scroller]`) rendered height over the usable visual viewport
  (`visualViewport.height`), taken from live geometry rather than any
  self-declared constant. The measured state is the default chat-first shell: a
  waiting focused conversation with long metadata, folded runtime controls, and
  many docked pipelines;
- attachments add no persistent chrome — the image picker folds behind the
  composer-options disclosure, and a staged image is transient operator content
  (its preview tray consumes space only while shown, with no horizontal overflow)
  that reserves **zero** height once cleared, fully restoring the `>= 0.60`
  budget;
- with the conversation-details **and** composer-options disclosures driven open
  (materializing the long-metadata row and the model/reasoning + attachment
  row), the document still shows **no** horizontal overflow;
- the focused chat renders **zero** `mobile-bottom-shelf` rows — every secondary
  surface (pipelines, handoff, hidden/readiness) reserves no persistent bottom
  height and opens from a compact top-chrome trigger or overlay instead.

The bottom shelf (`MobileBottomShelf`) opens as a real modal dialog: `aria-modal`,
focus moves into it, Tab is trapped, Escape closes it, focus returns to the
opener, and body scroll locks while it is up.

## Frames

| File | Viewport | What it shows |
| --- | --- | --- |
| `chat-first-390.png` | 390×844 | Phone chat-first shell: one compact conversation header (memory/goal/model chips + runtime controls folded behind the `›` details disclosure), the transcript dominant, the composer as one compact row, the docked pipelines as a top-strip trigger, and the handoff/hidden shelf as a header trigger — no persistent bottom rows. |
| `chat-first-430.png` | 430×932 | The same shell at the larger pinned frame; the extra height goes to the transcript. |
| `board-desktop.png` | 1920×1080 | Desktop board, unchanged: the scheme keeps every metadata chip and the runtime strip inline. The mobile fold is gated by `useIsMobile`, so desktop is untouched. |

Measured gate output from the capture run (real geometry, not a constant):

```
chat-first-390.png default chat-first budget: share 0.611 (feed 516px / usable 844px), pipelineTriggers 1, bottomShelfRows 0, scrollWidth 390 === innerWidth 390
chat-first-390.png attachment (staged, transient): share 0.500 (feed 422px / usable 844px), no h-overflow
chat-first-390.png attachment cleared: restored share 0.611 (feed 516px / usable 844px) — tray reserves zero height
chat-first-390.png expanded (details+options open): share 0.428 (feed 361px / usable 844px), scrollWidth 390 === innerWidth 390
chat-first-430.png default chat-first budget: share 0.648 (feed 604px / usable 932px), pipelineTriggers 1, bottomShelfRows 0, scrollWidth 430 === innerWidth 430
chat-first-430.png attachment (staged, transient): share 0.547 (feed 510px / usable 932px), no h-overflow
chat-first-430.png attachment cleared: restored share 0.648 (feed 604px / usable 932px) — tray reserves zero height
chat-first-430.png expanded (details+options open): share 0.482 (feed 449px / usable 932px), scrollWidth 430 === innerWidth 430
```

`share` is the **measured** LogFeed scroller height over the usable visual
viewport — the default folded state clears `0.60` at both sizes; a staged image
is transient and reserves zero height once cleared; opening both disclosures (the
long-metadata row and the composer model/reasoning + attachment row) never
introduces horizontal overflow.
