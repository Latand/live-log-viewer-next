# PR #330 runtime synchronization integration

This integration pins `origin/main` at
`e575dc06aa77fd6d913b90d98268fc77eb64173a` and PR #330 at
`ceb495d2d58fe08a703b9e50a9ea2adbaf30dd1c`.

## Range-diff evidence

The audit used:

```sh
git range-diff --no-dual-color --creation-factor=80 \
  710c4590b677fe5852ed33e9ab1b78d3eb449fec..ceb495d2d58fe08a703b9e50a9ea2adbaf30dd1c \
  710c4590b677fe5852ed33e9ab1b78d3eb449fec..e575dc06aa77fd6d913b90d98268fc77eb64173a
```

The range-diff identified three exact matches already present in the pinned
main ancestry. They were omitted from new integration work:

- `4469df33d6c9d2e725f76c605d7ce67d8c70d0ef` — structured sends remain held
  during synchronization.
- `94386859479b3652880f07fc30c0536c3c3d5b4c` — canonical held commands and
  request digests remain durable.
- `de08bd24cddd271d95a088ba5bab23aa36f64754` — startup recovery and controller
  drain behavior remain present.

The merge base between the pinned main and PR head is the third commit above,
`de08bd24cddd271d95a088ba5bab23aa36f64754`. The remaining nine PR commits were
unmatched and retained because they carry live ownership, recovery, compaction,
and migration semantics.

## Conflict decisions

- Current image content-digest conflict handling and corrupt-image reservation
  recovery remain active beside explicit operation ownership.
- Current terminal journal reconciliation fixtures remain alongside durable
  registry ownership, compacted replay, and provisional-adoption fixtures.
- Current structured write envelopes remain asserted through partial matches in
  the older PR fixtures.

The retained range covers partial startup adoption, explicit and durable
operation ownership, re-entrant journal migration, compacted terminal replay,
provisional owner adoption, bounded terminal owners, and active owner retention.
