# Issue #353 compact pipeline board audit

Date: 2026-07-18
Viewport: 1920 × 1080
Production baseline SHA: `a9f207d86ef72fe2a751d8187dc9aa5a4bab6895`
Project: `-agents-tools-live-log-viewer-next`
Pipeline groups present during both captures: 4

The baseline was captured from production on port 8898. The revised build ran
locally with `next start` on port 8899 against the same Viewer data. Production
state remained unchanged. Counts use `document.querySelectorAll()` after the
camera settled; live-feed polling can move the total by a few nodes between
samples.

## Visual matrix

| Camera | Baseline | Revised build |
| --- | --- | --- |
| 15% | `issue-353-before-15.png` | `issue-353-after-15.png` |
| 30% | `issue-353-before-30.png` | `issue-353-after-30.png` |
| 100% | `issue-353-before-100.png` | `issue-353-after-100.png` |
| Fit All | `issue-353-before-fit-all.png` | `issue-353-after-fit-all.png` |

All images live in
`/home/latand/.config/agent-log-viewer/audits/board-20260718/`.

Fit All rose from 12% to 23%. The final revised scene contained 13 full conversation
nodes, four pipeline groups, zero planned-stage canvas windows, eight terminal
evidence rows, zero pipeline review decks, and four compact pipeline outlines in the minimap. The #353
group contained one full pane for its current Builder attempt; Architect retries
and the earlier Builder attempt were represented in its evidence rail.

## DOM measurements

| Settled Fit All sample | Baseline | Revised | Change |
| --- | ---: | ---: | ---: |
| DOM elements | 4,454 | 3,019 | -1,435 (-32.2%) |
| Buttons | 455 | 350 | -105 (-23.1%) |
| Inputs, textareas, selects | 70 | 28 | -42 (-60.0%) |
| Pipeline groups | 4 | 4 | 0 |
| Planned-stage canvas windows | present | 0 | removed from scene |

The settled 15%, 30%, and 100% samples each held 3,019 DOM elements, 350 buttons,
and 28 form controls. Opening the Reviewer configuration added the existing
stage editor on demand with eight controls, an engine radio group, the role
selector, runtime controls, and the prompt editor. Escape closed it from a
toolbar-focused keyboard state.

## Camera interaction latency

Latency is the elapsed time from the wheel/button input to the first committed
world-transform mutation. Each value is in milliseconds.

| Transition | Baseline | Revised first sample |
| --- | ---: | ---: |
| 15% → 30% | 29.5 | 39.0 |
| 30% → 100% | 17.5 | 34.5 |
| 100% → Fit All | 20.6 | 17.4 |

Five additional 30% ↔ 100% cycles on the final build produced a 42.1 ms
median entering 30% and a 43.5 ms median entering 100%; the slowest commit was
77.6 ms. Frame alignment and live-feed polling make individual samples noisy,
and all observed commits stayed below 100 ms.

## Bounded-render checks

Automated layout coverage constructs 1, 3, and 10 memberless pipelines and
checks 15%, 30%, 100%, and computed Fit All. Every case renders one group per
pipeline, zero full nodes, zero stage slots, and an empty transcript target map.
Task assignments to compacted stage paths resolve to the pipeline group, and
the minimap receives one compact outline per pipeline.
