#!/usr/bin/env bash
# Capture + verify the issue #499 acceptance evidence: the REAL TmuxComposer
# for a Viewer-launched structured conversation, driven in a real browser at
# 390x844, 390x600, and 1440x900.
#
#   bash docs/screenshots/issue-499/capture.sh
#
# Every screenshot run is recorded into capture-manifest.json by
# build-manifest.ts (per-capture SHA-256 + IHDR-verified pixel geometry +
# harness digests + git revision), and the committed still-*.svg frames are
# regenerated from that manifest — so the immutable evidence stays
# mechanically bound to this exact harness run. evidence.test.ts enforces the
# binding in `bun test`.
#
# Requires a completed `bun run build` (for the CSS bundle) and a cached
# puppeteer chrome-headless-shell under ~/.cache/puppeteer.
set -euo pipefail
cd "$(dirname "$0")/../../.."

OUT="docs/screenshots/issue-499"
CSS="$(ls .next/static/css/*.css | head -1)"
SHELL_BIN="$(ls -d "$HOME"/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell | tail -1)"
LIST="$OUT/captures.list"
: > "$LIST"

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

shot() { # name width height view lang theme
  local name="$1" width="$2" height="$3" view="$4" lang="$5" theme="$6"
  "$SHELL_BIN" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=2 \
    --virtual-time-budget=6000 \
    --window-size="$width,$height" \
    --screenshot="$OUT/$name.png" \
    "file://$PWD/$OUT/harness.html?view=$view&lang=$lang&theme=$theme" 2>/dev/null
  echo "$name $view $lang $theme $width $height" >> "$LIST"
  echo "captured $name"
}

# Behavioral verification: re-run the page, dump the DOM, and assert on the
# #verify-log JSON the drivers appended — same execution path as the shots.
# Every view logs its real CSS viewport, so each verify pins geometry too.
verify() { # name width height query expectations...
  local name="$1" width="$2" height="$3" query="$4"
  shift 4
  local dom
  dom="$("$SHELL_BIN" --headless --disable-gpu --no-sandbox \
    --virtual-time-budget=6000 \
    --window-size="$width,$height" \
    --dump-dom \
    "file://$PWD/$OUT/harness.html?$query" 2>/dev/null)"
  for expectation in "$@" "\"viewport\":{\"width\":$width,\"height\":$height}"; do
    if ! grep -qF "$expectation" <<<"$dom"; then
      echo "VERIFY FAILED [$name]: missing $expectation" >&2
      exit 1
    fi
  done
  echo "verified $name"
}

# 1. Rest: the one obvious pill on the phone, no disclosure needed; desktop row.
shot rest-390-en-light      390 844  rest en light
shot rest-390-uk-dark       390 844  rest uk dark
shot rest-desktop-en-light  1440 900 rest en light
verify rest 390 844 "view=rest&lang=en&theme=light" \
  '"pillVisible":true'

# 2. Picker open: 390 bottom sheet and desktop popover.
shot sheet-390-en-light     390 844  sheet en light
shot popover-desktop-en-light 1440 900 popover en light
verify sheet 390 844 "view=sheet&lang=en&theme=light" \
  '"pickerOpen":true'
verify popover 1440 900 "view=popover&lang=en&theme=light" \
  '"pickerOpen":true'

# 3. Typing non-empty text enables Send within one frame on the live host.
shot typed-390-en-light     390 844  typed en light
verify typed 390 844 "view=typed&lang=en&theme=light" \
  '"phase":"before-typing","sendAriaDisabled":"true"' \
  '"phase":"after-typing","sendAriaDisabled":"false"'

# 4. One structured send receipt carrying the selected settings (xhigh + fast).
shot receipt-390-en-light   390 844  receipt en light
verify receipt 390 844 "view=receipt&lang=en&theme=light" \
  '"kind":"send-request","runtime":{"model":"gpt-5.6-sol","effort":"xhigh","fast":true}' \
  '"status":"delivered"' \
  '"runtime":{"model":"gpt-5.6-sol","effort":"xhigh","fast":true}' \
  '"phase":"delivered","echoVisible":true'

# 5. Blocked host: inline reason + Re-check recovery, no mute tooltip-only state.
shot blocked-390-en-light   390 844  blocked en light
shot blocked-390-uk-light   390 844  blocked uk light
verify blocked 390 844 "view=blocked&lang=en&theme=light" \
  '"blockedInline":true' \
  '"placeholder":"message the agent — reconnecting to its session…"' \
  '"launchAdvertised":false'

# 6. Dead structured host, EN and UK at the tall and keyboard-open heights: the
#    recovery banner owns Respawn/Attach/Re-check while Send keeps admitting
#    text durably. The banner body must state the TRUTH in the page's locale —
#    durable admission, delayed delivery after recovery, the image restriction
#    — the composer renders the inline image-restriction notice, and no
#    model/reasoning pill exists (the capability matrix hides `runtime` on the
#    dead surface).
shot dead-390-en-light      390 844  dead en light
shot dead-390x600-en-light  390 600  dead en light
shot dead-390-uk-light      390 844  dead uk light
shot dead-390x600-uk-light  390 600  dead uk light
DEAD_EN_BODY='saved durably and delivered after the host recovers'
DEAD_EN_IMAGES='staged ones stay selected and are delivered after recovery'
DEAD_UK_BODY='надійно зберігається і буде доставлений після відновлення хоста'
DEAD_UK_IMAGES='будуть доставлені після відновлення'
for geometry in "844" "600"; do
  verify "dead-en-$geometry" 390 "$geometry" "view=dead&lang=en&theme=light" \
    '"bannerVisible":true' \
    '"recoveryActions":3' \
    '"sendAriaDisabled":"false"' \
    '"imagesNotice":true' \
    '"pillVisible":false' \
    "$DEAD_EN_BODY" \
    "$DEAD_EN_IMAGES"
  verify "dead-uk-$geometry" 390 "$geometry" "view=dead&lang=uk&theme=light" \
    '"bannerVisible":true' \
    '"recoveryActions":3' \
    '"sendAriaDisabled":"false"' \
    '"imagesNotice":true' \
    '"pillVisible":false' \
    "$DEAD_UK_BODY" \
    "$DEAD_UK_IMAGES"
done

# 7. Image upload through the collapsed fold: paste lands a ready tile in the
#    bounded tray and enables Send on its own.
shot images-390-en-light    390 844  images en light
verify images 390 844 "view=images&lang=en&theme=light" \
  '"tileReady":true' \
  '"sendAriaDisabled":"false"'

# 8. Short viewport (390x600 — keyboard-open class of heights): the live-ready
#    composer with the pill stays reachable (dead 390x600 is covered above).
shot rest-390x600-en-light  390 600  rest en light
verify rest-600 390 600 "view=rest&lang=en&theme=light" \
  '"pillVisible":true'

# Record the run: digest + geometry-verify every capture into the committed
# manifest, then regenerate the committed vector stills from it so the
# immutable evidence can never drift from this harness execution.
bun "$OUT/build-manifest.ts" "$LIST"
bun "$OUT/generate-stills.ts"

rm -f "$OUT/bundle.js" "$OUT/app.css" "$OUT/harness.html" "$LIST"
echo "issue #499 acceptance capture + verification complete"
