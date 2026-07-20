#!/usr/bin/env bash
#
# Deepen the current git checkout until the issue-499 capture manifest's
# ancestor `sourceRevision` is present and connected to HEAD.
#
# The release publish (.github/workflows/publish.yml) checks out with
# actions/checkout@v4's default `fetch-depth: 1`, producing a DEPTH-ONE
# checkout: only the reviewed HEAD commit and its tree are present, and every
# ancestor — including the capture manifest's recorded `sourceRevision` — is
# absent. `docs/screenshots/issue-499/evidence.test.ts` validates the committed
# capture evidence against that revision's git tree and its committed harness
# bytes, so those ancestor objects must be fetched before `bun test`.
#
# Both publish.yml and docs/screenshots/issue-499/depth-one-evidence.test.ts
# invoke THIS script, so the release path and its regression deepen history by
# the exact same mechanism.
set -euo pipefail

manifest="docs/screenshots/issue-499/capture-manifest.json"
rev="$(grep -o '"sourceRevision"[[:space:]]*:[[:space:]]*"[0-9a-f]\{40\}"' "$manifest" | grep -o '[0-9a-f]\{40\}' | head -n1)"
if [ -z "${rev}" ]; then
  echo "deepen-to-evidence-revision: could not read sourceRevision from ${manifest}" >&2
  exit 1
fi

# Deepen this branch's history in chunks until the recorded sourceRevision is a
# reachable ancestor of HEAD (idempotent: a full/normal checkout already is).
for _ in $(seq 1 20); do
  if git merge-base --is-ancestor "${rev}" HEAD 2>/dev/null; then
    break
  fi
  git fetch --no-tags --deepen 10 origin >/dev/null 2>&1 || break
done

# Fail loudly if the evidence's source revision is still unreachable — the
# committed capture evidence must bind to an ancestor of the reviewed HEAD.
git cat-file -e "${rev}^{commit}"
git merge-base --is-ancestor "${rev}" HEAD
echo "deepen-to-evidence-revision: sourceRevision ${rev} present and connected to HEAD"
