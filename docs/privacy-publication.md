# Privacy-safe publication

Every pull request runs `privacy-publication` from the default branch through
`pull_request_target`. The job checks out trusted scanner, test, workflow, and
fingerprint files separately, then handles the pull-request checkout as opaque
inspection input. Candidate code is never executed. The scan covers committed,
staged, unstaged, and untracked changes relative to the exact base SHA.
Diagnostics expose finding classes and counts. Matched values, OCR text,
metadata values, and file paths remain suppressed.

Run the same check locally:

```sh
bun run privacy:check
```

The gate requires Tesseract plus FFmpeg and FFprobe. CI installs English and
Ukrainian OCR data and configures `eng+ukr`; operators can set
`LLV_PRIVACY_OCR_LANGUAGES` to another Tesseract language expression. Missing
tools, missing language data, failed inspection, and malformed configuration
fail closed.

Text inspection applies bounded fixed-point decoding to nested percent encoding
and the complete GFM HTML5 named-entity table. It normalizes CommonMark escapes,
emphasis delimiters, and zero-width separators, then inspects Markdown
destinations, HTML attributes, credential-bearing forms, URI authentication,
authorization headers, and split token shapes. Text-like files remain
inspectable with NUL bytes or UTF-16 encoding. Unsupported binary inputs fail
closed. Publication inputs and supporting files with symlinks in any path
component are rejected before their targets are read.

Media dispatch recognizes PNG, JPEG, GIF, BMP, TIFF, WebP, ISO-BMFF, AVI, and
Matroska signatures before applying the declared-extension fallback. Renamed
media therefore receives the same OCR, container, and provenance checks.
Raster inspection covers pixels and metadata. PNG inspection validates chunk
CRCs and scans `tEXt`, compressed `zTXt` and `iTXt`, `eXIf`, UTF-oriented
metadata strings, and bytes after `IEND`. Live-capture classification runs over
every decoded PNG metadata channel. APNG animation controls produce
`inspection_error` until multi-frame PNG sampling is supported. GIF and video
inspection scans container metadata plus five representative frames from every
video stream. Frame-count sampling keeps that coverage when duration metadata
is unavailable. Missing duration and frame count, malformed stream inventories,
and excessive stream counts produce `inspection_error`.

## Known-value fingerprints

CI reads the committed
[`scripts/privacy-known-value-fingerprints.json`](../scripts/privacy-known-value-fingerprints.json)
catalog and passes `--require-known-values`. A missing, empty, or malformed
catalog produces `configuration_error`. The workflow has no dependency on an
Actions secret for this coverage.

Catalog entries contain normalized lengths and SHA-256 fingerprints. Runtime
matching hashes same-length windows after NFKC, lowercase, markup, and separator
normalization, so formatting and token splitting cannot bypass the catalog.

Keep raw private labels in the ignored `.privacy-known-values` operator file.
Refresh the committed fingerprints with:

```sh
bun run privacy:fingerprints -- \
  --input .privacy-known-values \
  --output scripts/privacy-known-value-fingerprints.json
```

The generator emits a status and count. Raw labels stay out of its diagnostics
and the generated catalog.

## Authenticated GitHub publication audit

The `privacy-tracker-audit` workflow audits the event's issue or pull request
through GitHub's authenticated API. Coverage includes issue and pull-request
titles and bodies, issue comments, inline review comments, review bodies,
Markdown media links, HTML media attributes, and raw GitHub media URLs. Media
references use the same bounded canonical representation as text scanning.
Root-relative and scheme-relative references resolve from a fixed repository
base before the trusted-host policy runs.

`pull_request_target` events check out the default branch, so the token-bearing
audit always executes trusted code. The checkout excludes persisted Git
credentials. API requests use the automatic read-only `github.token`. Media
downloads accept a fixed GitHub host allowlist, apply redirect and size limits,
and send authorization only to the API origin and `github.com`. Missing auth,
untrusted media origins, API failures, and unsupported media types fail closed.

An operator can run the same audit with `GITHUB_TOKEN` or `GH_TOKEN` already set:

```sh
bun run privacy:github-audit -- --repo OWNER/REPO --number 456
```

## Media provenance

Every changed raster, GIF, or video needs a co-located
`privacy-manifest.json` using schema version 2. Each asset entry binds:

- an allowed classification and source class;
- the exact SHA-256 digest of the published bytes;
- one or more SHA-256 source digests;
- a deterministic generator path and generator version;
- the pinned generator runtime;
- the exact SHA-256 digest of the generator bytes; and
- a useful evidence description.

The gate verifies canonical regular-file paths for manifests and generators,
validates every digest, confirms the declared generator version and exact
supported runtime exist in the bound generator, and requires source digests to
differ from the published output digest. Normal provenance maps the candidate
generator path to the default-branch checkout, requires the trusted generator
digest, and executes those trusted bytes once in an isolated temporary root.
The candidate entry must exactly match the reproduced manifest, source digests,
and output digest. Unsupported generators and reproduction failures produce
`provenance_invalid`.

The normal classifications are `synthetic` and `redacted-placeholder`.
`adversarial-synthetic` is reserved for documented fixture directories. Its
manifest declares the exact synthetic finding classes expected from the
fixture. Finding suppression requires an identical asset entry at the supplied
trusted base revision. Candidate-created exemptions and any checksum, class,
source, version, or generator mismatch fail provenance validation.

## Redacted evidence placeholders

Issue #448 replaces confirmed live-state captures with deterministic raster
placeholders generated by:

```sh
bun run privacy:placeholders
```

Generation requires Bun 1.3.3, the version pinned in both privacy workflows.
The generator fails closed when a different runtime is active.

Each placeholder keeps its path, viewport dimensions, comparison name, and a
synthetic layout skeleton. Generation derives its visual variant from the
original source digest, generator version, and output path. Repeated generation
reproduces identical PNG bytes and manifest bindings.

## Issue #448 remediation record

Two redacted records document the wider audit and cleanup:

- [`docs/acceptance/issue-448/tracker-remediation-inventory.md`](acceptance/issue-448/tracker-remediation-inventory.md)
  lists every sanitized issue, comment, and pull-request body by surface and
  exposure class while omitting private values.
- [`docs/acceptance/issue-448/historical-retention.md`](acceptance/issue-448/historical-retention.md)
  records reachability through ancestor blobs and GitHub edit history, along
  with the operator-owned options for fuller removal. Shared history changes
  require an explicit decision.
