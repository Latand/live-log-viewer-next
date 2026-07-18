# Issue #270 — visual acceptance: reasoning meter in a reserved in-flow slot

Release-gate evidence that the reasoning meter (EffortPills) occupies a plain
in-flow layout slot on every surface, that width-capped hosts collapse it below
the 260px `reasoning-host` container threshold, and that the effort tier stays
reachable through a localized tooltip when the meter is collapsed or the model
is unknown (the follow-up review finding: the engine-badge fallback now carries
`effortTitle(file)`).

## How it was captured

Production build (`next start`, NODE_ENV=production) against a disposable
deterministic fixture home, driven by Playwright 1.61.1 chromium. The full
harness — fixture materialization, server boot, DOM assertions, screenshots —
is [`capture.ts`](./capture.ts):

```sh
bun install && bun run build
mkdir -p /tmp/llv-pw && (cd /tmp/llv-pw && bun add playwright@1.61.1)
bun docs/acceptance/issue-270/capture.ts
```

The fixture contains two sessions in one project:

- a **claude** session whose transcript records `model: claude-opus-4-8` and a
  `thinking` block → identity `opus-4-8`, effort `high`, ~2 minutes old (lands
  as a large 300px switch card and the open desktop pane);
- a **codex** session whose `turn_context` records `effort: "low"` and **no
  model** → the model=null engine-badge fallback, ~1 hour old (lands as a
  small 220px switch card, below the collapse threshold).

Every run re-asserts the DOM contract in the live browser and fails on any
violation; the passing checks of this capture are in
[`evidence.json`](./evidence.json). Native `title` tooltips do not paint in
headless screenshots, so the tooltip fallbacks are proven by those recorded
DOM assertions rather than pixels.

## Screenshots

| Image | Surface | Shows |
| --- | --- | --- |
| `desktop-pane-claude-effort-slot.png` | 1280×800 desktop pane | Meter as an in-flow flex sibling of the `opus-4-8` model chip in the wrapping header meta row (computed `display: flex`, `reasoning-slot` class, no positioned escape, no transform). |
| `desktop-pane-claude-header-closeup.png` | header crop | Close-up of the model chip + meter cluster. |
| `desktop-pane-codex-model-null-fallback.png` | 1280×800 desktop pane | model=null: the `Codex` engine badge is the identity chip; the meter (1/4 bars, effort low) still rides the same row; badge `title="Reasoning effort: low"` (asserted). |
| `desktop-pane-codex-header-closeup.png` | header crop | Close-up of the fallback badge + meter cluster. |
| `switchboard-collapse-large-vs-small.png` | 1280×800 switchboard | Large 300px card keeps the meter (`display: flex`); small 220px card collapses it via the container query (`display: none`) while the tier stays reachable — model-chip title `Claude · Reasoning effort: high` on the large card, engine-badge title `Reasoning effort: low` on the collapsed model=null card (asserted). |
| `mobile-390-claude-merged-chip.png` | 390×844 mobile focus view | Phone surface renders the merged `opus-4-8 · high` chip in the scrollable meta row; the bar meter never mounts (asserted). |
| `mobile-390-codex-model-null-fallback.png` | 390×844 mobile focus view | model=null on the phone: plain `Codex` badge with `title="Reasoning effort: low"` (asserted). |

Captured 2026-07-18 on branch
`pipeline/270-reasoning-bars-in-a-real-layout-slot-ee682d60` (evidence-only
change; no product source touched).
