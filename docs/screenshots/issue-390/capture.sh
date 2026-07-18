#!/usr/bin/env bash
# Capture the issue #390 acceptance stills (§12): desktop 1440 and mobile 390,
# EN and UK, light and dark, against the real production CSS.
#
#   bash docs/screenshots/issue-390/capture.sh
#
# Requires a completed `bun run build` (for the CSS bundle) and a cached
# puppeteer chrome-headless-shell under ~/.cache/puppeteer.
set -euo pipefail
cd "$(dirname "$0")/../../.."

OUT="docs/screenshots/issue-390"
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
    --virtual-time-budget=3000 \
    --window-size="$2,$3" \
    --screenshot="$OUT/$1.png" \
    "file://$PWD/$OUT/harness.html?$4" 2>/dev/null
  echo "captured $1"
}

# 1. Pill at rest, strip without badge/selects (EN+UK, light+dark, codex+claude).
shot rest-codex-en-light        1440 900 "view=rest&lang=en&theme=light"
shot rest-codex-uk-dark         1440 900 "view=rest&lang=uk&theme=dark"
# 2. Popover: Reasoning group, six sol tiers, check on the active tier.
shot popover-codex-en-light     1440 900 "view=popover&lang=en&theme=light"
shot popover-codex-uk-light     1440 900 "view=popover&lang=uk&theme=light"
shot popover-codex-en-dark      1440 900 "view=popover&lang=en&theme=dark"
# 3. Model drill-down with back row and checked model.
shot model-codex-en-light       1440 900 "view=model&lang=en&theme=light"
# 4. Speed panel (codex only; locked on structured).
shot speed-codex-en-light       1440 900 "view=speed&lang=en&theme=light"
# 5. Claude-broker phase-1 disabled-with-reason rows (no Speed row anywhere).
shot claude-disabled-en-light   1440 900 "view=claude&lang=en&theme=light"
shot claude-disabled-uk-light   1440 900 "view=claude&lang=uk&theme=light"
# resume surface: enabled rows, resume chip in the strip.
shot resume-codex-en-light      1440 900 "view=resume&lang=en&theme=light"
# 6. Mobile 390 sheet: stacked sections, 44px rows.
shot sheet-codex-390-en-light    390 844 "view=sheet&lang=en&theme=light"
shot sheet-codex-390-uk-dark     390 844 "view=sheet&lang=uk&theme=dark"
shot rest-codex-390-en-light     390 844 "view=rest&lang=en&theme=light"
# 7. Live-tmux applying (spinner replaces the chevron) and error (danger face
#    after a failed reconfigure) — desktop and 390 (#405).
shot applying-codex-en-light        1440 900 "view=applying&lang=en&theme=light"
shot applying-codex-390-en-light     390 844 "view=applying&lang=en&theme=light"
shot apply-error-codex-en-light     1440 900 "view=apply-error&lang=en&theme=light"
shot apply-error-codex-390-en-light  390 844 "view=apply-error&lang=en&theme=light"
# 8. Before/after pair: the retired badge+selects+Apply strip vs the new quiet
#    row (the review-facing "clutter is gone" shot) — desktop and 390 (#405).
shot before-strip-uk-light          1440 900 "view=before&lang=uk&theme=light"
shot before-strip-390-uk-light       390 844 "view=before&lang=uk&theme=light"
shot after-strip-uk-light           1440 900 "view=rest&lang=uk&theme=light"
shot after-strip-390-uk-light        390 844 "view=rest&lang=uk&theme=light"
# Stage placeholder runtime row: usable at 390 with 44px targets (#405).
shot stage-controls-en-light        1440 900 "view=stage&lang=en&theme=light"
shot stage-controls-390-en-light     390 844 "view=stage&lang=en&theme=light"
