# PR #441 — subagent badge anchors: acceptance evidence

The reviewed blockers are frontend interaction/geometry changes. The pipeline
sandbox has no browser or Docker, so this evidence set is split into two
deterministic, fully synthetic halves:

- **Auditable geometry stills (`*.svg`)** — regenerated with
  `bun docs/acceptance/pr-441/capture.ts`. They are rendered from the **same
  pure geometry the product ships** — `subagentsOf` (current-generation
  selection and bottom-up order) and `layoutBadges` (30×30 placement, right-edge
  anchoring, hard-cap overflow) — over hand-authored fictional data. Being SVG
  text they are fully readable in review.
- **Published raster stills (`*.png`)** — deterministic **redacted
  placeholders** emitted by the approved trusted generator
  `scripts/generate-privacy-placeholders.ts`, with schema-v2 provenance recorded
  in `privacy-manifest.json`. This keeps the raster evidence reproducible from
  the trusted publication gate itself rather than from an ad-hoc `sharp`
  rasterization, which is what the two `chore(privacy): remove live board
  evidence` commits were guarding against.

## Privacy

Every id, title, path, project (`atlas-demo`) and model in the capture script is
invented for these stills. No real project name, account, filesystem path,
transcript text, or user data is read or embedded. The SVGs are text-auditable;
the PNGs are reproducible redacted placeholders whose provenance
(`privacy-manifest.json`, schema version 2) is verified by the privacy
publication gate. Both are safe to publish.

## Stills

### `pr-441-desktop-badges.svg` (1040×600)
Desktop board card with the subagent rail anchored to the card's **right edge**,
bottom-up:

- `SM` (Schema migration) — **running**, live green ring, at the bottom.
- `AT` (API contract tests) — **live**, shown **expanded** (hover/focus
  disclosure) as the 220px title pill.
- `DS` (Docs sweep) — **closed**, dimmed.
- A **structural arrow** starts at the bottom badge's fixed 30px circle center
  (the registered anchor) and curves down into the child card — edge anchoring.

`pr-441-desktop-badges.png` is the redacted-placeholder companion at the same
1040×600 viewport.

### `pr-441-mobile-390.svg` (390×844)
The phone focus surface (issue #419 chat-first shell) with the **same** badge
interaction mounted on the focused conversation (PR #441 blocker 1):

- The rail anchors to the pane's **left edge**, bottom-up, lifted clear of the
  composer.
- `SM` is shown **expanded** (tap disclosure); the pill grows rightward and stays
  within the 390px viewport, so it adds **zero horizontal overflow**.

`pr-441-mobile-390.png` is the redacted-placeholder companion at the same
390×844 viewport.

## Blocker → acceptance mapping

| Reviewed blocker | Where verified |
| --- | --- |
| P1 — mobile focus never mounts badges | `pr-441-mobile-390.svg`; `src/components/mobile/MobileFocusView.badges.dom.test.tsx` |
| P1 — coarse-pointer hand mode blocks badge taps | `SubagentBadges.dom.test.tsx` → `data-scheme-ui` + `pointer-events-auto` ownership test |
| P2 — activation reopens a stale native generation | `subagentBadgeModel.test.ts` + `SubagentBadges.dom.test.tsx` current-generation-path tests; capture log shows `conv-migrate → /atlas/migrate-gen2` (not gen1) |
