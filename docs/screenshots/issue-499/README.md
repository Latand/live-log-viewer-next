# Issue #499 acceptance evidence

The REAL `TmuxComposer` (with `DeadHostBanner` for the dead view) mounted for a
Viewer-launched structured conversation (`spawnOrigin: "viewer"`, hosted
codex-app-server session) against a scripted wire, driven by real DOM events in
chrome-headless-shell. `bash docs/screenshots/issue-499/capture.sh` captures
every still AND runs the behavioral verification pass (`--dump-dom` +
assertions on the harness's `#verify-log`), so the screenshots and the checks
come from one execution path. All data is synthetic and publication-safe.

## Mechanical binding: capture-manifest.json

`capture.sh` ends every run by writing `capture-manifest.json` through
`build-manifest.ts`: for each chrome capture it records the SHA-256 and the
IHDR-parsed pixel geometry (refusing any capture that is not exactly
viewport × device-scale-factor 2), plus the SHA-256 of the harness inputs
(`harness.tsx`, `capture.sh`), the git revision of the run AND that revision's
source-tree object. The committed `still-*.svg` frames are regenerated from
that manifest in the same run.

Every capture row is then **sealed** with a SHA-256 over its canonical record
(`captureDigest` in `generate-stills.ts`). The record commits to the captured
PNG's digest and, for the picker-open captures, the measured control geometry —
so the digest is recomputable by CI from the committed manifest bytes alone
(the privacy-safe canonical capture payload the raw, gitignored PNGs cannot be).

**Control geometry.** The picker-open captures at 1440×900, 390×844 and
390×600 record the `getBoundingClientRect` of Send, the model/reasoning pill,
and the opened reasoning + model picker surfaces, measured in the real page.
`collect-geometry.ts` is the acceptance gate: capture.sh REFUSES any run whose
controls are not nonzero and fully inside the CSS viewport, so a regression that
collapses or pushes a control off-screen fails the capture loudly.

`evidence.test.ts` (part of `bun test`) enforces the binding on the committed
artifacts:

- every capture's sealing digest recomputes from its committed canonical record
  — a hand-edited row (digest, geometry, or pixel hash) fails here;
- the manifest's `sourceTree` is `git rev-parse <sourceRevision>^{tree}` and the
  harness bytes committed at that revision are byte-identical to the reviewed
  ones — the evidence binds to the exact reviewed source-tree revision;
- Send, the pill, and the opened reasoning + model picker surfaces have nonzero,
  fully in-viewport bounds at all three viewports;
- every still is byte-identical to its deterministic regeneration from the
  committed manifest, and embeds the manifest's capture digest, revision, and
  exact viewport geometry;
- the manifest's harness digests match the current `harness.tsx`/`capture.sh`
  bytes — editing the harness without recapturing fails the suite;
- each frame's depicted capability set (Send / model-reasoning pill / images /
  recovery) equals what the production `capabilitiesFor` matrix resolves for
  that state — the dead and unresolved frames show no pill, the dead frames
  keep Send enabled with the inline image-restriction notice;
- the dead frames carry the truthful localized banner copy (durable text
  admission, delayed delivery after recovery, image restriction, recovery
  controls) in EN and UK at both 390×844 and 390×600.

## Committed immutable stills

The `still-*.svg` files ARE committed, inspectable evidence: deterministic
synthetic re-renders of the verified acceptance states, emitted byte-stably by
the co-located `generate-stills.ts` from `capture-manifest.json`
(`bun docs/screenshots/issue-499/generate-stills.ts`). They are vector
artifacts because the privacy-publication gate reproduces raster provenance
from the TRUSTED default-branch generator, which cannot know about media a
not-yet-merged PR introduces — new raster provenance is structurally
unvalidatable inside a single PR (the pr-439 precedent). As text files they
publish under the trusted gate directly, with provenance embedded in each
frame's `<metadata>`: classification `synthetic`, the generator path, the
exact source revision of the capture run, the SHA-256 of the real
chrome-headless capture behind it, the viewport, and the resolved capability
summary. The raw chrome captures stay local (`docs/screenshots/issue-499/*.png`
is gitignored) because browser output is not byte-deterministic; their digests
in the manifest are the committed record.

| Still | State |
| --- | --- |
| `still-live-ready-desktop-1440x900` | Desktop live-ready composer |
| `still-live-ready-390x844`, `still-live-ready-390x600` | Mobile live-ready with the always-visible pill, tall + keyboard-open heights |
| `still-unresolved-recovery-390x844` | Unresolved host: inline resolving reason + Re-check, no launch affordance, no pill |
| `still-dead-recovery-390x844`, `still-dead-recovery-390x600` | Dead host (EN): truthful recovery banner while Send keeps admitting text durably; inline image restriction; no pill |
| `still-dead-recovery-390x844-uk`, `still-dead-recovery-390x600-uk` | Dead host (UK): the same truthful copy in Ukrainian |
| `still-image-upload-390x844` | Staged image tile enabling Send |

## Captured states

The raw chrome captures behind the manifest digests are regenerated locally
with `bash docs/screenshots/issue-499/capture.sh` after `bun run build`; the
script fails loudly when any behavioral expectation — including the truthful
dead-host copy in either locale or the requested viewport geometry — is
missing.

| Capture | State |
| --- | --- |
| `rest-390-en-light`, `rest-390-uk-dark` | Live ready at 390×844: the one obvious 44px model/reasoning pill under the input, no disclosure needed |
| `rest-390x600-en-light` | Live ready at 390×600 (keyboard-open height class): pill and Send stay reachable |
| `rest-desktop-en-light` | Desktop parity: unchanged inline options row |
| `sheet-390-en-light`, `sheet-390x600-en-light` | Pill open at 390 (tall + keyboard-open heights): stacked Reasoning / Model / Speed sheet, 44px rows; records Send / pill / reasoning + model picker geometry |
| `popover-desktop-en-light` | Pill open on desktop: WAI-APG popover; records Send / pill / reasoning + model picker geometry |
| `typed-390-en-light` | Non-empty text enables Send in the same synchronous flush (verified `aria-disabled` flip) |
| `receipt-390-en-light` | One structured send receipt carrying the selected settings (`runtime: {model, effort: xhigh, fast}` verified on the wire request AND the delivered receipt echo) |
| `blocked-390-en-light`, `blocked-390-uk-light` | Unresolved host: inline reason + Re-check recovery, never tooltip-only |
| `dead-390-en-light`, `dead-390x600-en-light`, `dead-390-uk-light`, `dead-390x600-uk-light` | Dead structured host, EN + UK at both heights: recovery banner (Respawn / Terminal / Re-check) with the truthful durable-admission body, Send admitting text durably, inline image restriction, no pill |
| `images-390-en-light` | Image pasted through the collapsed fold: ready tile in the bounded tray enables Send on its own |
