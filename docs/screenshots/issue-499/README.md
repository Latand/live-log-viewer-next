# Issue #499 acceptance evidence

The REAL `TmuxComposer` (with `DeadHostBanner` for the dead view) mounted for a
Viewer-launched structured conversation (`spawnOrigin: "viewer"`, hosted
codex-app-server session) against a scripted wire, driven by real DOM events in
chrome-headless-shell. `bash docs/screenshots/issue-499/capture.sh` captures
every still AND runs the behavioral verification pass (`--dump-dom` +
assertions on the harness's `#verify-log`), so the screenshots and the checks
come from one execution path. All data is synthetic and publication-safe.

Browser screenshots are not deterministic byte-for-byte, so the stills are NOT
committed (the privacy provenance regime only admits reproducible generator
output). Run the capture locally after `bun run build`; it fails loudly when
any behavioral expectation is missing.

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
