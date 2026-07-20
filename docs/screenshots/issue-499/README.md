# Issue #499 acceptance evidence

The REAL `TmuxComposer` (with `DeadHostBanner` for the dead view) mounted for a
Viewer-launched structured conversation (`spawnOrigin: "viewer"`, hosted
codex-app-server session) against a scripted wire, driven by real DOM events in
chrome-headless-shell. `bash docs/screenshots/issue-499/capture.sh` captures
every still AND runs the behavioral verification pass (`--dump-dom` +
assertions on the harness's `#verify-log`), so the screenshots and the checks
come from one execution path. All data is synthetic and publication-safe.

## Committed immutable stills

The `still-*.svg` files ARE committed, inspectable evidence: deterministic
synthetic re-renders of the verified acceptance states, emitted byte-stably by
the co-located `generate-stills.ts` (`bun docs/screenshots/issue-499/generate-stills.ts`).
They are vector artifacts because the privacy-publication gate reproduces
raster provenance from the TRUSTED default-branch generator, which cannot know
about media a not-yet-merged PR introduces — new raster provenance is
structurally unvalidatable inside a single PR (the pr-439 precedent). As text
files they publish under the trusted gate directly, with provenance embedded
in each frame: classification `synthetic`, the generator path, the exact
source revision whose acceptance run the frame re-renders (visible in the
frame AND in its `<metadata>`), and the SHA-256 of the real chrome-headless
capture behind it.

| Still | State |
| --- | --- |
| `still-live-ready-desktop-1440x900` | Desktop live-ready composer |
| `still-live-ready-390x844`, `still-live-ready-390x600` | Mobile live-ready with the always-visible pill, tall + keyboard-open heights |
| `still-unresolved-recovery-390x844` | Unresolved host: inline resolving reason + Re-check, no launch affordance |
| `still-dead-recovery-390x844`, `still-dead-recovery-390x600` | Dead host: recovery banner while Send keeps admitting text |
| `still-image-upload-390x844` | Staged image tile enabling Send |

The raw chrome captures behind the source digests are regenerated locally with
`bash docs/screenshots/issue-499/capture.sh` after `bun run build`; the script
fails loudly when any behavioral expectation is missing.

| Still | State |
| --- | --- |
| `rest-390-en-light`, `rest-390-uk-dark` | Live ready at 390×844: the one obvious 44px model/reasoning pill under the input, no disclosure needed |
| `rest-390x600-en-light` | Live ready at 390×600 (keyboard-open height class): pill and Send stay reachable |
| `rest-desktop-en-light` | Desktop parity: unchanged inline options row |
| `sheet-390-en-light` | Pill open at 390: stacked Reasoning / Model / Speed sheet, 44px rows |
| `popover-desktop-en-light` | Pill open on desktop: WAI-APG popover |
| `typed-390-en-light` | Non-empty text enables Send in the same synchronous flush (verified `aria-disabled` flip) |
| `receipt-390-en-light` | One structured send receipt carrying the selected settings (`runtime: {model, effort: xhigh, fast}` verified on the wire request AND the delivered receipt echo) |
| `blocked-390-en-light`, `blocked-390-uk-light` | Unresolved host: inline reason + Re-check recovery, never tooltip-only |
| `dead-390-en-light`, `dead-390x600-en-light` | Dead structured host: recovery banner (Respawn / Terminal / Re-check) while Send keeps admitting text durably |
| `images-390-en-light` | Image pasted through the collapsed fold: ready tile in the bounded tray enables Send on its own |
