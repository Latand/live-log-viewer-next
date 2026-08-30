#!/usr/bin/env bash
# Request a durable production Viewer deployment from runtime-host.
#
# This is the whole release command, run from any checkout of the repository
# (a worktree is fine). It reads nothing from the working tree and moves
# nothing in it: the request names a revision, and the runtime host builds that
# revision from its own canonical Git mirror of the same remote.
set -euo pipefail

PORT="${PORT:-8898}"
CANONICAL_REMOTE="${LLV_VIEWER_CANONICAL_REMOTE:-https://github.com/Latand/live-log-viewer-next.git}"

usage() {
  echo "usage: rebuild.sh [full-commit-sha]" >&2
  echo "  no argument       with LLV_DEPLOY_REVISION unset, deploy the canonical refs/heads/main tip resolved here" >&2
  echo "  full-commit-sha   40 hex characters, in either case; posted lowercase for a pinned redeploy or rollback" >&2
  echo "  LLV_DEPLOY_REVISION follows the same SHA contract and supplies an omitted argument" >&2
}

if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi
# #1309: what this script advertises, validates and sends is exactly what
# `/api/runtime/deployments` accepts for `revision` — a full 40-character
# hexadecimal commit SHA, normalized to lowercase. The old CLI exposed
# `origin/main` as an input sentinel and resolved it before posting; omitting the
# argument now expresses that default without advertising a value the endpoint
# would reject as `revision_invalid`.
ARG_REVISION="${1:-}"
ENV_REVISION="${LLV_DEPLOY_REVISION:-}"
if { [ "$#" -eq 1 ] && [ -z "$ARG_REVISION" ]; } \
  || { [ -n "$ARG_REVISION" ] && [[ ! "$ARG_REVISION" =~ ^[0-9a-fA-F]{40}$ ]]; } \
  || { [ -n "$ENV_REVISION" ] && [[ ! "$ENV_REVISION" =~ ^[0-9a-fA-F]{40}$ ]]; }; then
  echo "invalid revision: pass a full 40-character hexadecimal commit SHA in either case, or no argument to deploy the canonical main tip" >&2
  usage
  exit 1
fi
if [ -n "$ARG_REVISION" ] && [ -n "$ENV_REVISION" ] \
  && [ "${ARG_REVISION,,}" != "${ENV_REVISION,,}" ]; then
  echo "revision argument conflicts with LLV_DEPLOY_REVISION" >&2
  exit 1
fi
REVISION="${ARG_REVISION:-$ENV_REVISION}"
REVISION="${REVISION,,}"

IDEMPOTENCY_KEY="${LLV_DEPLOY_IDEMPOTENCY_KEY:-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
case "$IDEMPOTENCY_KEY" in
  *$'\n'*|*$'\r'*|'') echo "invalid deployment idempotency key" >&2; exit 1 ;;
esac
if [ "${#IDEMPOTENCY_KEY}" -gt 200 ]; then
  echo "invalid deployment idempotency key" >&2
  exit 1
fi

# No SHA is ever carried by hand into a deploy (#1033): the default request
# reads the canonical main tip machine-to-machine and posts the exact commit it
# read. `ls-remote` asks the remote for its refs — it fetches no objects, writes
# no remote-tracking ref, and leaves this checkout and its branch exactly where
# they were. The remote it asks is the one the runtime host's canonical mirror
# clones and fetches from (`scripts/runtime-host-viewer-adapter.ts`), so the SHA
# sent is a SHA that mirror can build. An explicit SHA argument stays a pinned
# redeploy or rollback.
if [ -z "$REVISION" ]; then
  if ! ls_remote="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$CANONICAL_REMOTE" refs/heads/main)"; then
    echo "could not read refs/heads/main from $CANONICAL_REMOTE" >&2
    exit 1
  fi
  REVISION="$(printf '%s\n' "$ls_remote" | head -n 1 | cut -f1)"
  if [[ ! "$REVISION" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "could not resolve refs/heads/main at $CANONICAL_REMOTE" >&2
    exit 1
  fi
  REVISION="${REVISION,,}"
  echo "resolved refs/heads/main at $CANONICAL_REMOTE: $REVISION"
fi

BASE="http://127.0.0.1:${PORT}"
BODY="$(bun -e 'const [revision, idempotencyKey] = process.argv.slice(1); process.stdout.write(JSON.stringify({ revision, idempotencyKey }))' "$REVISION" "$IDEMPOTENCY_KEY")"

# #1309: nothing that reads as a started deployment is printed before the
# endpoint has returned a valid receipt. A refusal used to arrive underneath
# `deployment key: …`, so a request that deployed nothing read like one that
# had started. A request whose response never arrives is the one case where the
# key still has to be shown: that request may have been admitted, and the key
# is what claims its receipt.
if ! response="$(curl -sS --max-time 125 -H 'content-type: application/json' -d "$BODY" -w $'\n%{http_code}' "${BASE}/api/runtime/deployments")"; then
  printf 'deployment request did not complete; it may still have been admitted — rerun with LLV_DEPLOY_IDEMPOTENCY_KEY=%q scripts/rebuild.sh %q to claim the original receipt\n' "$IDEMPOTENCY_KEY" "$REVISION" >&2
  exit 1
fi
code="${response##*$'\n'}"
json="${response%$'\n'*}"
if [ "$code" != "202" ] && [ "$code" != "409" ]; then
  echo "deployment request failed (HTTP $code): $json" >&2
  exit 1
fi
if ! deployment_id="$(bun -e '
  try {
    const [raw, code] = process.argv.slice(1);
    const receipt = JSON.parse(raw);
    const expectedState = code === "409" ? "busy" : "accepted";
    if (!receipt || typeof receipt !== "object" || receipt.state !== expectedState
      || typeof receipt.deploymentId !== "string" || receipt.deploymentId.length === 0) process.exit(1);
    process.stdout.write(receipt.deploymentId);
  } catch { process.exit(1); }
' "$json" "$code")"; then
  echo "deployment request failed (HTTP $code): $json" >&2
  exit 1
fi

echo "deployment key: $IDEMPOTENCY_KEY"
if [ "$code" = "409" ]; then
  echo "deployment busy: $deployment_id"
  exit 2
fi

echo "deployment admitted: $deployment_id"
while :; do
  if status_json="$(curl -fsS --max-time 10 "${BASE}/api/runtime/deployments/${deployment_id}" 2>/dev/null)"; then
    read -r phase terminal error < <(bun -e 'const x=JSON.parse(process.argv[1]); console.log(x.phase, x.terminal ? "1" : "0", JSON.stringify(x.error || ""))' "$status_json")
    echo "deployment phase: $phase"
    if [ "$terminal" = "1" ]; then
      [ "$phase" = "succeeded" ] && exit 0
      echo "deployment ended in $phase: $error" >&2
      # The failed candidate is retired before anyone can inspect it, so print
      # what the gate observed while it was alive (#790).
      printf '%s' "$status_json" | bun "$(dirname "$0")/deployment-failure-report.ts" >&2 || true
      exit 1
    fi
  fi
  sleep 1
done
