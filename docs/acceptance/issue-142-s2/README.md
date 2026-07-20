# Issue #142 — board-presence slice S2 acceptance evidence

Engine-native subagent tray + durable fold policy
(`docs/design/board-presence-cards.md` §1.2 / §1.4, S2 acceptance).

## Privacy manifest

- **No private project data.** Every artifact here is generated from synthetic
  fixtures authored for this slice: parent identity `orchestrator-42` and worker
  titles `Config linter`, `Fixture sweeper`, `Doc auditor`. No transcript,
  path, account, or project name from any real board appears in these files.
- Transcript paths in the fixtures are placeholders under `/synthetic/…`.
- `tray-states.html` is a self-contained `renderToStaticMarkup` render of the
  `SubagentTray` component states with an inline CSS shim — it embeds no polled
  data and makes no network calls.

## Visual states (`tray-states.html`)

Open in any browser. Frames, at the labelled widths:

1. **Desktop 1440px — collapsed tray.** Quiet engine children fold into the
   docked lower-edge chip: `⑂ N` + roll-up state dots.
2. **Desktop 1440px — expanded tray.** The durable disclosure pin opens the
   compact member rows (dashed edge). A hand-folded *live* child keeps the
   roll-up hot (`running`).
3. **Mobile 390px — inline tray, expanded.** Rows stay inside the focused
   parent; 44px touch targets; full-width block; `min-w-0`/truncate prevent
   horizontal overflow.
4. **Mobile 390px — collapsed (post-reload folded).** After a reload the durable
   fold/disclosure pins are re-read from board state, so the same children stay
   folded.

## Pixel-screenshot note

Full-app pixel screenshots use the pinned puppeteer Docker harness
(`bun run demo:capture`), which needs Docker + network and is **unavailable in
this offline sandbox**. The automated visual / interaction / a11y evidence is
therefore the DOM test suite, which asserts the same states and semantics:

- `src/components/scheme/SubagentTrayView.dom.test.tsx` — collapsed chip
  `aria-expanded`/`aria-controls`/count, durable toggle, expanded member rows
  (open read-only + unfold), Escape collapses and restores focus to the chip,
  zero-member render, and the inline 44px / full-width / no-overflow variant.
- `src/components/scheme/SubagentBadges.dom.test.tsx` — promoted-badge filtering
  and exact-path navigation preserved (PR #441 primitives).

## Acceptance mapping (S2)

| Acceptance criterion | Where it is enforced / proven |
|---|---|
| Working engine child renders as a full P2 node under its parent | `subagentTray.ts` `classifyEngineChild` (busy → promoted); `projectModel.ts` promoted paths force a column — `subagentTray.test.ts`, `projectModel.test.ts` |
| Quiet/terminal child folds into the tray immediately (no idle wait) | `classifyEngineChild` (authoritative terminal/idle → folded) — `subagentTray.test.ts` |
| A live child can be hand-folded; the pin survives reloads | `set-engine-child-fold` mutation + store persistence — `mutations.test.ts`, `store.test.ts`; UI fold control in `SubagentBadges.tsx` |
| Attention (question/failure/rate-limit/killed) promotes out of the tray | `engineChildNeedsAttention` + precedence rung 1 — `subagentTray.test.ts` |
| Owner-touched child never auto-folds | precedence rung 3 (userAuthored/unverified/pinned) — `subagentTray.test.ts` |
| Tray roll-up shows the hottest child state | `rollUpState` / `buildSubagentTrays` — `subagentTray.test.ts` |
| Child stays visible when its parent cannot host a tray | host-eligibility gate → promoted — `subagentTray.test.ts` |
| Operator-spawned / viewer / claimed children unchanged | provenance + claimed/hidden exclusion — `subagentTray.test.ts` |
| Single-surface (a card renders in exactly one place) | folded paths excluded from nodes (`projectModel`) and badges (`subagentBadgeModel` `exclude`); worker-collapse exemption (`workerCollapse.ts`) — `projectModel.test.ts`, `workerCollapse.test.ts`, `SubagentBadges.dom.test.tsx` |
| Minimap drops tray members | folded children leave `layout.nodes` — `Minimap.render.test.tsx` regression |
| Restart persistence + legacy defaults + merge | `store.ts` read defaults + `mergedBoards` union — `store.test.ts` |
| EN/UK parity | `en.ts`/`uk.ts` `subagentTray.*` keys — `i18n.test.ts` |

## Gate results (this checkout)

- `tsc --noEmit`: clean.
- `eslint` (changed files): clean.
- `bun run build` (`next build --webpack` + MCP bundle): success.
- Focused suites (tray/board/i18n/projectModel/workerCollapse/minimap/mobile):
  all green. Repo-wide failures are pre-existing and environmental (codex
  accounts registry, real runtime/EIO/spawn integration) and touch none of the
  S2 modules.
