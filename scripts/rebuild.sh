#!/usr/bin/env bash
# Request a durable production Viewer deployment from runtime-host.
set -euo pipefail

PORT="${PORT:-8898}"
REVISION="${LLV_DEPLOY_REVISION:-origin/main}"
IDEMPOTENCY_KEY="${LLV_DEPLOY_IDEMPOTENCY_KEY:-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
TOKEN="$(sed -n 's/^LLV_TOKEN=//p' "$HOME/.config/agent-log-viewer/service.env" 2>/dev/null | head -1)"

case "$REVISION" in
  origin/main|[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "invalid revision: use origin/main or a full lowercase commit SHA" >&2; exit 1 ;;
esac
case "$IDEMPOTENCY_KEY" in
  *$'\n'*|*$'\r'*|'') echo "invalid deployment idempotency key" >&2; exit 1 ;;
esac

QUERY=""
[ -n "$TOKEN" ] && QUERY="?k=$TOKEN"
BASE="http://127.0.0.1:${PORT}"
BODY="$(printf '{"revision":"%s","idempotencyKey":"%s"}' "$REVISION" "$IDEMPOTENCY_KEY")"

echo "deployment key: $IDEMPOTENCY_KEY"
response="$(curl -sS --max-time 15 -H 'content-type: application/json' -d "$BODY" -w $'\n%{http_code}' "${BASE}/api/runtime/deployments${QUERY}")"
code="${response##*$'\n'}"
json="${response%$'\n'*}"
if [ "$code" != "202" ] && [ "$code" != "409" ]; then
  echo "deployment request failed (HTTP $code): $json" >&2
  exit 1
fi

state="$(bun -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.state || ""))' "$json")"
deployment_id="$(bun -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.deploymentId || ""))' "$json")"
if [ "$state" = "busy" ]; then
  echo "deployment busy: $deployment_id"
  exit 2
fi
[ -n "$deployment_id" ] || { echo "deployment receipt is missing its id" >&2; exit 1; }

echo "deployment admitted: $deployment_id"
while :; do
  if status_json="$(curl -fsS --max-time 10 "${BASE}/api/runtime/deployments/${deployment_id}${QUERY}" 2>/dev/null)"; then
    read -r phase terminal error < <(bun -e 'const x=JSON.parse(process.argv[1]); console.log(x.phase, x.terminal ? "1" : "0", JSON.stringify(x.error || ""))' "$status_json")
    echo "deployment phase: $phase"
    if [ "$terminal" = "1" ]; then
      [ "$phase" = "succeeded" ] && exit 0
      echo "deployment ended in $phase: $error" >&2
      exit 1
    fi
  fi
  sleep 1
done
