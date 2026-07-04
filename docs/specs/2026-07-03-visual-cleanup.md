# Spec addendum: visual cleanup of focus mode, sidebar, chip strip

Follow-up to `2026-07-03-process-status-dashboard.md` after a live visual pass.
Problems seen on a real screen (wide desktop, focus mode on a Claude session):

## 1. Raw log text used as titles

Sidebar rows and the focus top bar show raw last-message text, including markdown
syntax: «Готово. Handoff створений і перевірений: [2026-07-03-…md](/home/user/…)».
A second row shows a full agent prompt («Read .tmux-multi-agent/… You are a
read-only research worker…») wrapped over 5 lines.

Fix in the title derivation (scanner `describe.ts` or wherever titles are built)
AND defensively at render:

- Strip markdown: `[text](url)` → `text`, inline code backticks removed, `**` and
  `#` markers removed.
- Collapse absolute paths longer than ~40 chars to `…/last/two/segments`.
- Collapse whitespace/newlines to single spaces.
- Cap sidebar titles at 2 rendered lines (`line-clamp-2`), top-bar title at one
  line with ellipsis. FileRow currently wraps unbounded — that is what makes
  rows 5 lines tall.

## 2. Descendant chip strip is a second header row of noise

The strip renders every descendant with long labels; finished items look identical
to running ones; on a busy session it scrolls forever and adds ~48px of chrome.

- Chip label: max ~32 chars, single line, ellipsis.
- Each chip gets an activity dot: green pulse = live, amber = recent, red = stalled,
  gray = done. Dim (opacity-60) finished chips.
- Order: live first, then recent, then the rest by mtime desc.
- Show at most 6 chips + a «+N» toggle chip that expands/collapses the remainder
  (wrap to more rows only when expanded). Default collapsed.
- Tighten vertical padding so the strip is one compact row (~32px).

## 3. Feed stretched across the full viewport

Message text lines run 1200px+ wide — unreadable. Constrain the feed content
column to `max-w-[880px]` (keep it left-aligned with the existing left padding,
centered is fine too). Tool-call rows and message bubbles share that max width.
The wide two-column whitespace on the right must disappear.

## 4. Top bar decluttering (focus mode)

Currently: title row + buttons Дашборд / Follow / Пауза / Службові / line-filter
input + size/time on the right — then the chip strip below. Keep ONE compact bar:

- Left: engine badge + model chip + one-line title (ellipsis).
- Right: «Дашборд» button, Follow toggle, Пауза toggle, «Службові» toggle,
  line-filter input shrunk (w-40), size/time text stays but `text-[11px]`.
- Reduce paddings (`py-1.5`) so the whole header block (bar + chip strip) is
  visibly slimmer than now.

## 5. Sidebar group header consistency

Group headers currently mix «1 live · 124» and «+45» badge styles. Unify:

- Right side of every group header: live count first when > 0 as a green
  `N live` chip, then total count as plain dim text `M`.
- Remove the `+` prefix style entirely.
- Keep project name uppercase styling as is.

## Gates

`bunx tsc --noEmit && bun run lint && bun run build` must pass. No commits.
UI strings Ukrainian; no antithesis phrasing in comments/strings.
