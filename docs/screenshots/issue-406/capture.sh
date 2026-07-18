#!/usr/bin/env bash
# Capture the issue #406 acceptance stills: the TurnStatusBar timer captions at
# desktop 1440 and mobile 390, running and finished, against the production CSS.
#
#   bash docs/screenshots/issue-406/capture.sh
#
# Requires a completed `bun run build` (for the CSS bundle) and a cached
# puppeteer chrome-headless-shell under ~/.cache/puppeteer.
set -euo pipefail
cd "$(dirname "$0")/../../.."

OUT="docs/screenshots/issue-406"
CSS="$(ls .next/static/css/*.css | head -1)"
SHELL_BIN="$(ls -d "$HOME"/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell | tail -1)"

bun build "$OUT/harness.tsx" --outfile "$OUT/bundle.js" --target browser \
  --define "process.env.NODE_ENV=\"production\"" >/dev/null
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
    --virtual-time-budget=1500 \
    --window-size="$2,$3" \
    --screenshot="$OUT/$1.png" \
    "file://$PWD/$OUT/harness.html?$4" 2>/dev/null
  echo "captured $1"
}

# Desktop 1440: live «working… · 4:32» and frozen «Worked for 12m 30s».
shot running-1440-en-light   1440 900 "view=running&lang=en&theme=light"
shot running-1440-uk-dark    1440 900 "view=running&lang=uk&theme=dark"
shot finished-1440-en-light  1440 900 "view=finished&lang=en&theme=light"
# Mobile 390: compact padding, caption stays on one centered line.
shot running-390-en-light     390 844 "view=running&lang=en&theme=light"
shot running-390-uk-dark      390 844 "view=running&lang=uk&theme=dark"
shot finished-390-en-light    390 844 "view=finished&lang=en&theme=light"
