# Desktop v2 (rewrite) — critique from the rendered frames, round 1

Reviewed: this branch's `docs/design/desktop-v2/` on 2026-09-02, after `bun docs/design/desktop-v2/capture.ts` ran green (174 frames, 15 flows). Nothing under `src/` changed. This is the designer's own pass through the pictures, in the reviewer's format, so the next reviewer starts from what was already seen and fixed, and from what is still open.

**Frame check against the originating requirement.** The operator's rejection asked for a board that is spatial and clustered and fast, a task view that is not a column, an accounts page that shows every account with a bar and a detail, and today's chat made compact with a better settings menu and input. Every screen in `prototype/screens.js` serves one of those four; none serves the rejected prototype's frame (rail · column · stage). No WRONG-PREMISE. The over-engineering pass (README §11) removes more from the product than it adds.

## 1. First glance, 1440 dark

`out/1440/dark/yard.png`: the yard reads in under two seconds — the seat top-left, four amber-edged clusters with keycaps 1–4, the running pipelines with their stage names, the quiet drafts bottom-right, the map and the needs-you list in the side column. It is not a list, it is not a band, and it is not thumbnails: every tile is legible at 61 %. `yard-block.png` one step down: four stations on a spine with two fail loops and their budgets, the current station outlined, the beacon in the bar pointing at the next thing off screen. `yard-lift.png`: the question card readable in place with the yard receded behind it. That is the picture the operator asked for.

## 2. Findings found in the frames and fixed before this document

| # | Where | What the frame showed | Fix |
| --- | --- | --- | --- |
| F1 · P1 | `yard` (first render) | fit-all landed at 63 %, which was block altitude: 8 px station text, no tiles | the Yard/Block boundary moved to 80–90 % with hysteresis; fit-all always lands on tiles |
| F2 · P2 | `yard-crowded` | small tiles clipped their title under the keycap; the micro pips sat under the phrase | the tile is keycap + pips on one row, then the title, then the phrase; a narrow cluster clamps to one line; the keycap's counter-scale caps at 1.8× |
| F3 · P2 | `yard-block` | two fail loops on one pipeline drew their labels on top of each other | loops stack in lanes; each label sits at its source end |
| F4 · P2 | `yard-inspect`, `yard-crowded-block` | beacons on the canvas edge covered nodes (the gate caught the overlap) | beacons moved into the bar with a direction glyph; `+n` folds the overflow |
| F5 · P2 | `yard`, `yard-tray` | the minimap and the backlog tray floated over the canvas and covered tiles | both moved into the side column; the inspector shares it; the map grew from 200 × 132 to 372 × 168 |
| F6 · P3 | `yard` (tree tiles), `account-detail` | two flat class names (`.acc`, `.empty`) bent the tiles' dots and the signed-out account's meters into bars | renamed; lane 1 namespaces the shell's stylesheet |
| F7 · P2 | `field` | the region headers were 5 px | counter-scaled like the tiles; name and needs count only |
| F8 · P3 | `account-detail` | the `runs out` label overlapped the axis labels | moved above the point, left of the burnout zone |
| F9 · P2 | pin flow | Release restored a different layout than the auto one | the packer's aspect is the frame's, not the live board's (a receipt row was changing it) |
| F10 · P2 | pin flow | a drag on a cluster header started a pan | the cluster body intercepted the pointer; it is inert now, nodes and the lift are the only targets in it |
| F11 · P1 | `chat-settings` (flow) | the chip's click never opened the sheet | the composer swallowed clicks to protect the lift; the delegate now resolves the nearest control instead |
| F12 · P2 | `yard-lift` (DOM) | the lift rendered inside a `<button>`, which the parser closes at the first inner button | a lifted node is a `div`; the lift itself is focusable and the keys keep working from it |

## 3. Still open — for the reviewer

- **O1 · P2 · A crowded yard truncates small titles.** At 36 % a 228 px tree tile is 82 px wide and shows `Harden…`. The keycap, the phrase and the side column's list carry the rest, and one Ctrl+wheel step reads it, but the operator asked to "see all work" — a tile could drop its phrase for a second title line when it is narrow, or the packer could give lone conversations a wider, shorter tile. Not done: it changes the tile's shape for one altitude, and the lane can measure which the operator prefers.
- **O2 · P2 · The field re-packs each project at a fixed aspect.** Regions are sized per project and then packed; a project with one wide pipeline makes a wide region with air on its right (`field.png`, corvid-tools). A second packing pass could fill the air with the next region. Cheap in lane 7.
- **O3 · P3 · Beacons hide behind the bar's budget at 1280.** Two fit; the rest fold to `+n`. `n` and the side column reach them, so nothing is lost, but the direction glyphs are the spatial part and `+n` has none.
- **O4 · P3 · The lift's pane is one size (640 × 520).** A long feed scrolls inside it; a wide question (four options) fits. A conversation with a large tool output reads better in the chat stage, which is `Enter` away.
- **O5 · P3 · The inspector's stage editor is drawn ahead of the engine.** `edit-stage`, `note` and `answer` land only after automation-v2 slice 10 admits them; until then the receipt carries today's refusal. The README says so in lane 4; the frames show the editor because the picture is what the operator approves.
- **O6 · P3 · Both schemes are token-exact but the light yard's wells are faint at 0.08 alpha.** They separate ten clusters in the frames, and the hue is louder on the map; if the operator wants more, `--well-a` is one number.

## 4. What must not be regressed by the lanes

- The four altitudes and the hysteresis; the tile floor that keeps every canvas control at 44 px; fit-all landing on tiles.
- The packing order (seat, needs you, running, returned, quiet), determinism, the pin as an obstacle, Release restoring the exact auto layout.
- The camera writing nothing but the transform, the grid offset, the altitude, the map's viewport and the beacons.
- The lift: one node, at ≥ 100 %, the yard inert and receded, Esc back to the board with focus.
- The chat's feed unchanged; one header row; one box; the slot's four states; the sheet as one level; Esc to the chip.
- Every account with two meters; the detail's chart, pace and burnout; Switch back.
- The vocabulary, the badge recipe, the receipts with their inverse, no confirmation anywhere, both schemes token-exact, and the capture's habit of proving each of these headless.
