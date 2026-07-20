# Issue #474 — visual acceptance: off-screen edge-agent chips

Release-gate evidence, captured against the real production build, that:

- off-screen current-work conversations surface as an edge-anchored navigation
  landmark on the desktop scheme;
- the landmark can never paint over open chat content — crowded clusters fold
  into a compact «+N» disclosure whose expanded list is labelled and
  click-to-fit (the issue #292 anti-overlap contract), and a chip is only ever
  shown on an edge when its *fully-revealed* width clears every conversation
  pane (the collision geometry reserves the whole reveal, issue #474);
- a real long-titled chip rests with its label truncated behind a reserved
  direction-control box and, through keyboard focus, repeated pointer
  progression, and reduced-motion hover, unfurls the whole exact 48- or
  60-character label inside the same button with its scrollWidth contained (no
  ellipsis), staying inside the viewport and clear of content; every off-screen
  label — visible or folded behind «+N» — is harvested to prove the full cleaned
  title survives and both exact lengths render;
- a top/bottom chip pinned near a viewport corner, whose centered reveal band
  would be a sub-minimal sliver, folds into the «+N» aggregate instead of
  reserving an unusable, collision-unsafe width (issue #474 corner reveal);
- a chip whose revealed band would paint over the vertical agent-avatar/round
  stack (subagent badges) or the composer/input folds into «+N» instead — those
  fixed surfaces are tagged `data-chip-keepout` and reserved as collision
  obstacles alongside conversation panes (operator overlap report);
- the whole affordance is removed on a phone-width / coarse-pointer shell, where
  a conversation opens in the focus view with its pane horizontally contained
  inside 390px and its transcript unobstructed (no edge chip renders at all).

The reserved control box, single continuous hover/focus surface, bounded
progressive reveal, repeated progression within viewport bounds, keyboard
full-reveal, reduced-motion behaviour, and exact 48- and 60-character titles
unfurled through focus + repeated progression + reduced-motion hover are also
exercised deterministically by the DOM interaction suite
[`src/components/scheme/EdgeChips.hover.dom.test.tsx`](../../../src/components/scheme/EdgeChips.hover.dom.test.tsx),
and the reveal-width reservation plus the corner min-width fold by
[`src/components/scheme/offscreenClusters.test.ts`](../../../src/components/scheme/offscreenClusters.test.ts).

## How it was captured

Production build (`next start`, `NODE_ENV=production`) against a disposable
deterministic fixture home, driven by a cached `chrome-headless-shell` through
puppeteer-core. The full harness — fixture materialization, server boot, live
DOM assertions, panning to isolate a chip, screenshots — is
[`capture.ts`](./capture.ts):

```sh
bun install && bun run build
npx --yes @puppeteer/browsers install chrome-headless-shell@stable   # → LLV_474_CHS
mkdir -p /tmp/llv-pptr && (cd /tmp/llv-pptr && bun add puppeteer-core@23.11.1)
LLV_474_CHS=<shell> LLV_474_PPTR=/tmp/llv-pptr/node_modules \
  bun docs/acceptance/issue-474/capture.ts
```

The fixture contains five live claude conversations in one project, each with a
descriptive first prompt of *exactly* 48 or 60 characters (both lengths present)
so its chip label overflows the resting width and whichever chip surfaces proves
an exact-length reveal. The harness places them on the board, folds the crowded edge into
its «+N» disclosure, then pans the board until one long chip is isolated on an
edge clear of every pane and drives it through its resting and fully-revealed
states. On the phone shell it opens a conversation and proves horizontal
containment. Every run re-asserts the DOM contract in the live browser and fails
on any violation; the passing checks are in [`evidence.json`](./evidence.json).

Real captures are never committed (the repository's privacy convention): the
durable, reviewable evidence is this reproducible harness plus the live DOM
assertions it records to `evidence.json`. Running the harness writes the stills
below into this directory for local inspection.

## Stills the harness writes

| Image | Surface | Shows |
| --- | --- | --- |
| `desktop-1440-offscreen-edge-nav.png` | 1440×900 desktop board | Off-screen current-work conversations folded into a compact «+N» edge disclosure. The `Off-screen work` landmark is `pointer-events: none` (only its chips take input), so it never covers chat content; the disclosure is a collapsed, `aria-label`led control (asserted). |
| `desktop-1440-offscreen-edge-nav-expanded.png` | 1440×900 desktop board | The expanded disclosure: a labelled, click-to-fit list of off-screen conversations (`aria-expanded=true`, each entry a `<button>` carrying its title — asserted). |
| `desktop-1440-edge-chip-resting.png` | 1440×900 desktop board | A single long-titled chip isolated on an edge, at rest: the label is truncated (overflowing its resting width — asserted) with the direction control reserved in its own box before it, the whole pill inside the viewport and clear of every pane. |
| `desktop-1440-edge-chip-revealed.png` | 1440×900 desktop board | The same chip after keyboard focus: the whole exact 48- or 60-character label is unfurled inside the button with no ellipsis (`data-reveal="full"`, `scrollWidth ≤ clientWidth` — asserted), still inside the viewport and clear of content. The harness also drives repeated pointer progression and a reduced-motion hover through the same containment assertions. |
| `desktop-1440-edge-chip-keepout-clear.png` | 1440×900 desktop board | A keep-out band placed over the surfaced chip's reveal band (standing in for the vertical agent-avatar/round stack or the composer/input) folds the chip into its «+N» disclosure; no visible edge chip overlaps any `data-chip-keepout` surface (asserted). |
| `mobile-390-conversation-contained.png` | 390×844 phone shell | A real conversation open in the phone focus view: no `[data-edge-chip]` and no `Off-screen work` landmark render, so the wayfinding contributes zero horizontal overflow; the conversation pane is horizontally contained inside 390px and its transcript introduces no horizontal spill (all asserted). |

Native hover state does not paint in headless screenshots, so the resting/
revealed stills are driven by real focus/pointer events and their geometry is
asserted from the live DOM rather than pixels.
