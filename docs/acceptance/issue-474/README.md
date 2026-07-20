# Issue #474 — visual acceptance: off-screen edge-agent chips

Release-gate evidence that off-screen current-work conversations surface as an
edge-anchored navigation landmark on the desktop scheme, that the landmark can
never paint over open chat content (it folds crowded clusters into a compact
«+N» disclosure whose expanded list is labelled and click-to-fit — the issue
#292 anti-overlap contract), and that the whole affordance is removed on a
phone-width / coarse-pointer shell.

The reserved control box, single continuous hover/focus surface, bounded
progressive reveal, keyboard full-reveal, and reduced-motion behaviour of an
individual **visible** chip are exercised deterministically by the DOM
interaction suite
[`src/components/scheme/EdgeChips.hover.dom.test.tsx`](../../../src/components/scheme/EdgeChips.hover.dom.test.tsx)
(nine tests). The demo board's auto-layout re-packs current-work clusters into a
compact row and clamps pan/zoom, so a single hovered visible chip cannot be
isolated in a headless still; the folded «+N» surface is what the real board
deterministically shows for off-screen work, and it is what these stills prove.

## How it was captured

Production build (`next start`, `NODE_ENV=production`) against a disposable
deterministic fixture home, driven by a cached `chrome-headless-shell` through
puppeteer-core. The full harness — fixture materialization, server boot, live
DOM assertions, screenshots — is [`capture.ts`](./capture.ts):

```sh
bun install && bun run build
npx --yes @puppeteer/browsers install chrome-headless-shell@stable   # → LLV_474_CHS
mkdir -p /tmp/llv-pptr && (cd /tmp/llv-pptr && bun add puppeteer-core@23.11.1)
LLV_474_CHS=<shell> LLV_474_PPTR=/tmp/llv-pptr/node_modules \
  bun docs/acceptance/issue-474/capture.ts
```

The fixture contains five live claude conversations in one project, each with a
long, descriptive first prompt so its chip label overflows the resting width.
The harness places them on the board, reads one, and lets the remainder fall
off-screen; every run re-asserts the DOM contract in the live browser and fails
on any violation. The passing checks are in [`evidence.json`](./evidence.json).

Real captures are never committed (the repository's privacy convention): the
durable, reviewable evidence is this reproducible harness plus the live DOM
assertions it records to `evidence.json`. Running the harness writes the three
stills below into this directory for local inspection.

## Stills the harness writes

| Image | Surface | Shows |
| --- | --- | --- |
| `desktop-1440-offscreen-edge-nav.png` | 1440×900 desktop board | Reading three conversations while two more sit off-screen to the left: the `Off-screen work` landmark renders a compact `+2` edge disclosure at the left edge. The landmark is `pointer-events: none` (only its chips take input), so it never covers chat content; the disclosure is a collapsed, `aria-label`led control (asserted). |
| `desktop-1440-offscreen-edge-nav-expanded.png` | 1440×900 desktop board | The expanded disclosure: a labelled, click-to-fit list of the two off-screen conversations (`aria-expanded=true`, each entry a `<button>` carrying its conversation title — asserted). |
| `mobile-390-no-edge-chips.png` | 390×844 phone shell | The phone shell drops the scheme entirely: no `[data-edge-chip]` and no `Off-screen work` landmark render (asserted). |

Native `title`/hover state does not paint in headless screenshots, so the
per-chip hover behaviours are proven by the interaction suite rather than
pixels. Captured on branch
`pipeline/finish-474-edge-agent-chips-from-rescued-726b4baa`.
