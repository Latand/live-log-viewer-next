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
#
# The deepen loop is PROGRESS-CHECKED, not capped at a fixed commit count: it
# keeps extending shallow history as long as each fetch reveals new ancestors of
# HEAD, and stops only when the sourceRevision becomes reachable OR the remote's
# history is exhausted (the repository is no longer shallow, or a fetch adds
# nothing). A fixed ceiling would spuriously fail whenever the reviewed HEAD sat
# more commits ahead of the recorded evidence revision than that ceiling — even
# though the remote could still serve the ancestor.
set -euo pipefail

manifest="docs/screenshots/issue-499/capture-manifest.json"
rev="$(grep -o '"sourceRevision"[[:space:]]*:[[:space:]]*"[0-9a-f]\{40\}"' "$manifest" | grep -o '[0-9a-f]\{40\}' | head -n1)"
if [ -z "${rev}" ]; then
  echo "deepen-to-evidence-revision: could not read sourceRevision from ${manifest}" >&2
  exit 1
fi

# Extend history in chunks until the recorded sourceRevision is a reachable
# ancestor of HEAD. Terminate on genuine exhaustion — never on an arbitrary
# commit ceiling — so an evidence revision arbitrarily far behind HEAD still
# resolves as long as the remote can serve it (idempotent: a full/normal
# checkout enters neither branch of the loop and validates directly).
while ! git merge-base --is-ancestor "${rev}" HEAD 2>/dev/null; do
  # Complete history is already present yet the revision is still not an
  # ancestor: it is genuinely not in this branch's history. Stop; the ancestry
  # validation below then fails loudly.
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  before="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
  # A failed fetch (no origin, offline) is exhaustion for our purposes.
  git fetch --no-tags --deepen 100 origin >/dev/null 2>&1 || break
  after="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
  # The fetch revealed no new ancestor of HEAD: the remote's reachable history
  # is exhausted. Stop rather than spin.
  if [ "${after}" = "${before}" ]; then
    break
  fi
done

# Fail loudly if the evidence's source revision is still unreachable — the
# committed capture evidence must bind to an ancestor of the reviewed HEAD.
git cat-file -e "${rev}^{commit}"
git merge-base --is-ancestor "${rev}" HEAD
echo "deepen-to-evidence-revision: sourceRevision ${rev} present and connected to HEAD"
