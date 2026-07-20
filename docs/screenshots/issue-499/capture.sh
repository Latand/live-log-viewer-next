#!/usr/bin/env bash
# Capture + verify the issue #499 acceptance evidence: the REAL TmuxComposer
# for a Viewer-launched structured conversation, driven in a real browser at
# 390x844 and 1440x900.
#
#   bash docs/screenshots/issue-499/capture.sh
#
# Requires a completed `bun run build` (for the CSS bundle) and a cached
# puppeteer chrome-headless-shell under ~/.cache/puppeteer.
set -euo pipefail
cd "$(dirname "$0")/../../.."

OUT="docs/screenshots/issue-499"
CSS="$(ls .next/static/css/*.css | head -1)"
SHELL_BIN="$(ls -d "$HOME"/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell | tail -1)"

bun build "$OUT/harness.tsx" --outfile "$OUT/bundle.js" --target browser \
  --define "process.env.NODE_ENV=\"production\"" \
  --define "process.env.NEXT_PUBLIC_RUNTIME_UI=\"1\"" >/dev/null
cp "$CSS" "$OUT/app.css"
cat > "$OUT/harness.html" <<'HTML'
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="app.css" />
</head>
<body class="bg-canvas">
<div id="root"></div>
<script src="bundle.js"></script>
</body>
</html>
HTML

shot() { # name width height query
  "$SHELL_BIN" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=2 \
    --virtual-time-budget=6000 \
    --window-size="$2,$3" \
    --screenshot="$OUT/$1.png" \
    "file://$PWD/$OUT/harness.html?$4" 2>/dev/null
  echo "captured $1"
}

# Behavioral verification: re-run the page, dump the DOM, and assert on the
# #verify-log JSON the drivers appended — same execution path as the shots.
verify() { # name width height query expectations...
  local name="$1" width="$2" height="$3" query="$4"
  shift 4
  local dom
  dom="$("$SHELL_BIN" --headless --disable-gpu --no-sandbox \
    --virtual-time-budget=6000 \
    --window-size="$width,$height" \
    --dump-dom \
    "file://$PWD/$OUT/harness.html?$query" 2>/dev/null)"
  for expectation in "$@"; do
    if ! grep -qF "$expectation" <<<"$dom"; then
      echo "VERIFY FAILED [$name]: missing $expectation" >&2
      exit 1
    fi
  done
  echo "verified $name"
}

# 1. Rest: the one obvious pill on the phone, no disclosure needed; desktop row.
shot rest-390-en-light      390 844  "view=rest&lang=en&theme=light"
shot rest-390-uk-dark       390 844  "view=rest&lang=uk&theme=dark"
shot rest-desktop-en-light  1440 900 "view=rest&lang=en&theme=light"
verify rest 390 844 "view=rest&lang=en&theme=light" \
  '"pillVisible":true'

# 2. Picker open: 390 bottom sheet and desktop popover.
shot sheet-390-en-light     390 844  "view=sheet&lang=en&theme=light"
shot popover-desktop-en-light 1440 900 "view=popover&lang=en&theme=light"
verify sheet 390 844 "view=sheet&lang=en&theme=light" \
  '"pickerOpen":true'
verify popover 1440 900 "view=popover&lang=en&theme=light" \
  '"pickerOpen":true'

# 3. Typing non-empty text enables Send within one frame on the live host.
shot typed-390-en-light     390 844  "view=typed&lang=en&theme=light"
verify typed 390 844 "view=typed&lang=en&theme=light" \
  '"phase":"before-typing","sendAriaDisabled":"true"' \
  '"phase":"after-typing","sendAriaDisabled":"false"'

# 4. One structured send receipt carrying the selected settings (xhigh + fast).
shot receipt-390-en-light   390 844  "view=receipt&lang=en&theme=light"
verify receipt 390 844 "view=receipt&lang=en&theme=light" \
  '"kind":"send-request","runtime":{"model":"gpt-5.6-sol","effort":"xhigh","fast":true}' \
  '"status":"delivered"' \
  '"runtime":{"model":"gpt-5.6-sol","effort":"xhigh","fast":true}' \
  '"phase":"delivered","echoVisible":true'

# 5. Blocked host: inline reason + Re-check recovery, no mute tooltip-only state.
shot blocked-390-en-light   390 844  "view=blocked&lang=en&theme=light"
shot blocked-390-uk-light   390 844  "view=blocked&lang=uk&theme=light"
verify blocked 390 844 "view=blocked&lang=en&theme=light" \
  '"blockedInline":true'

# 6. Dead structured host: the recovery banner owns Respawn/Attach/Re-check
#    while Send keeps admitting text durably — never a mute blocked composer.
shot dead-390-en-light      390 844  "view=dead&lang=en&theme=light"
verify dead 390 844 "view=dead&lang=en&theme=light" \
  '"bannerVisible":true' \
  '"recoveryActions":3' \
  '"sendAriaDisabled":"false"'

# 7. Image upload through the collapsed fold: paste lands a ready tile in the
#    bounded tray and enables Send on its own.
shot images-390-en-light    390 844  "view=images&lang=en&theme=light"
verify images 390 844 "view=images&lang=en&theme=light" \
  '"tileReady":true' \
  '"sendAriaDisabled":"false"'

# 8. Short viewport (390x600 — keyboard-open class of heights): the live-ready
#    composer with the pill, and the dead-host recovery, both stay reachable.
shot rest-390x600-en-light  390 600  "view=rest&lang=en&theme=light"
shot dead-390x600-en-light  390 600  "view=dead&lang=en&theme=light"
verify rest-600 390 600 "view=rest&lang=en&theme=light" \
  '"pillVisible":true'
verify dead-600 390 600 "view=dead&lang=en&theme=light" \
  '"bannerVisible":true' \
  '"sendAriaDisabled":"false"'

rm -f "$OUT/bundle.js" "$OUT/app.css" "$OUT/harness.html"
echo "issue #499 acceptance capture + verification complete"
