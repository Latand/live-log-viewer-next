#!/usr/bin/env bash
# Both Ubuntu audit gates use this wrapper. Bun remains the authority for
# --audit-level and --ignore; every argument is forwarded unchanged.
set -euo pipefail

output="$(mktemp)"
child=""
trap 'rm -f "$output"' EXIT
cancel() {
  trap '' INT TERM
  if [[ -n "$child" ]]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  echo 'Audit execution interrupted; security gate remains blocked.' >&2
  exit "$1"
}
trap 'cancel 130' INT
trap 'cancel 143' TERM

# Bun's observed request timeout is 300s. The outer deadline allows it to
# report that error, then bounds even an unresponsive child (315s maximum).
# Three attempts plus 5s/10s backoff take at most 960s.
for attempt in 1 2 3; do
  echo "Dependency audit attempt ${attempt}/3" >&2
  NO_COLOR=1 FORCE_COLOR=0 timeout --foreground --kill-after=5s 310s bun audit "$@" >"$output" 2>&1 &
  child=$!
  status=0
  wait "$child" || status=$?
  child=""
  cat "$output"
  if (( status == 0 )); then
    echo 'Dependency audit passed.' >&2
    exit 0
  fi

  if (( status == 124 || status >= 128 )); then
    echo "Audit execution timed out or was terminated (exit ${status}); security gate remains blocked." >&2
    exit "$status"
  fi

  # Match the complete diagnostic, excluding only Bun's banner and blank
  # lines. A title mentioning Timeout, extra diagnostics, or a changed output
  # format cannot turn an advisory or unknown failure into a retry.
  # Format: oven-sh/bun, bun-v1.3.3, src/cli/audit_command.zig sendAuditRequest.
  diagnostic="$(sed -E '/^bun audit v[^[:space:]]+.*$/d; /^[[:space:]]*$/d' "$output")"
  case "$diagnostic" in
    'Timeout: audit request failed'|\
    'ConnectionRefused: audit request failed'|\
    'ConnectionReset: audit request failed'|\
    'ConnectionClosed: audit request failed'|\
    'FailedToOpenSocket: audit request failed'|\
    'error: audit request failed (status 408)'|\
    'error: audit request failed (status 429)'|\
    'error: audit request failed (status 500)'|\
    'error: audit request failed (status 502)'|\
    'error: audit request failed (status 503)'|\
    'error: audit request failed (status 504)')
      if (( attempt == 3 )); then
        availability=unreachable
        if [[ "$diagnostic" == 'error: audit request failed (status '* ]]; then
          availability=unavailable
        fi
        echo "Advisory service ${availability} after 3 attempts; dependency audit could not complete. Security gate remains blocked." >&2
        exit "$status"
      fi
      delay=$((attempt * 5))
      echo "Advisory service transport failure; retrying in ${delay}s." >&2
      sleep "$delay" &
      child=$!
      wait "$child"
      child=""
      ;;
    *)
      if grep -Eq '^[1-9][0-9]* vulnerabilities \(.*[1-9][0-9]* (high|critical)(,|\))' "$output"; then
        echo 'Dependency audit reported high/critical advisories; security gate remains blocked.' >&2
      else
        echo "Audit failed with an unrecognized error (exit ${status}); security gate remains blocked. No retry." >&2
      fi
      exit "$status"
      ;;
  esac
done
