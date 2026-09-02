# Desktop v2 (rewrite) — independent critique, round 2

Reviewed: `docs/design/desktop-v2/` at `ec8156b2` (the design stage's output on this branch), 2026-09-02, on a fresh context. `bun docs/design/desktop-v2/capture.ts` ran green in the foreground (174 frames, 15 flows). On top of the capture I drove the prototype headless myself with a scratch driver under the gitignored `out/_critique/probe.ts` (kept there so the rework can rerun it): fit-all at 1280 / 1440 / 1920 in both schemes, the 70 % and 85 % zooms inside the yard band, plain-wheel pan and Ctrl+wheel zoom, a drag-pin on a small tile and a pin dropped over the packed rows, a receipt after a pin, a seat-spawned conversation and a grandchild injected into the fixture, and the crowded scenario at every width. Frames from that run are `out/_critique/*.png`. Nothing under `src/` was read for anything but comparison; nothing outside this file was written in the repository.

**Frame.** The critique judges the work against the operator's rejection of 2026-09-02, verbatim from the orchestrator conversation (account name redacted, this repository is public): *"the board is much less nice then now, its too linear, i want it to be 2d or even 3d and fast rps to navigate and to see all work grouped around in clusters logical, maybe graph … account page is shit"*, and *"зараз чат гарний але меню налаштувань і вводу не дуже, в тебе більш компактне вийшло і сподобалося, але більша частина гівно"*. Today's `SchemeBoard` is the bar the board must clear (README §1.1 measures it honestly: spatial regions, three planes, a real camera, live content at 100 %, a band layout that fits at 12–20 %).

**Prior art.** `search_transcripts` in three phrasings (project-scoped, then unscoped): the only hits are the rejection turn itself and this pipeline's own design stage; no earlier design of a clustered or lineage-grouped board exists to build on. Read through `conversation_messages`; the quotes above are from it.

## 0. The verdict in five answers

1. **Is the board spatial, clustered and fast, or rows again?** Inside a cluster: spatial and good. A pipeline is a spine of stations with its fail loops drawn and budgeted, a thread is a worker with its children, the lift is a real depth move, and the camera is transform-only (the pan gate proves it). At the yard level it has slid halfway back: the packer is a shelf packer, so the yard is rank-sorted rows wrapped at a width. Position means "how urgent", which the keycaps, the amber edges and the side list already say three times, and it means nothing else. No cluster is related to any other, and the model drops the one relation the real product has everywhere (F1). The operator's words were *grouped around … clusters logical, maybe graph*; this is grouped, in a grid, with no graph. It clears the rejected column by a distance and still stops short of the picture.
2. **Is the task view relational?** Yes. A task is the header of its pipeline or a tag on its thread, beside its worker; only tasks with no worker are rows, in a tray, with Assign. Keep it.
3. **Is the chat still the good chat, more compact, with a better menu and input?** Yes on three of four counts: one 48 px header row, the feed as it is, one box with the slot. The settings sheet is one level and complete, and it opens 190 px away from the chip that owns it, over the feed, which is the exact complaint about today's menu (F6).
4. **Is the accounts page good now?** Yes. Every account of both engines, two meters each, empty meters on a signed-out one, the detail with the burndown against the ideal line, the pace and the burnout time. It answers *when it runs out*; the missing half is *what stops when it does* (F8).
5. **Is the craft distinctive within the tokens?** The frame, the inspector, the chat, the accounts stage and the dialogs are. The yard at fit altitude is not: eleven tinted rounded rectangles that are 26–53 % text and the rest empty (F3), which is the "dashboard of identical cards" tell the README §2 says it checked for. Fix F3 and the yard looks like a yard.

No WRONG-PREMISE: every surface serves the rejection, nothing serves the retired prototype. Not OVER-BUILT: §2 names two cuts. The two P1s are one root cause: the cluster model and the packer ignore lineage.

## 1. Findings, severity-ranked

### F1 · P1 · The yard loses every conversation the orchestrator spawns

- **Screen / element.** `prototype/app.js:150-152` builds the seat cluster with `nodes: [nodeOf(c)]` and nothing else; `app.js:167` skips any conversation whose parent is on the board (`c.parent && byId.has(c.parent)`) on the assumption that its parent's cluster will carry it. The seat's cluster never does.
- **Evidence.** Probe: a conversation with `parent: "seat"`, no pipeline and no task lands in **no cluster** (`seat-spawned conversation lands in: NOWHERE`). It is absent from the yard, the map, `n`'s walk and the arrows; it is still counted by `counts()` (`app.js:265-274`), so the bar says one more *need you* than the yard shows. The fixture never exercises this, which is why 174 frames are green.
- **Why it hurts.** On the real board this is the common case: lanes are spawned from the seat with the seat as parent (the same orchestrator conversation this critique read carries a peer seat saying twenty-plus sessions were created that way, none of them pipelines). A real project's yard would be the seat plus its pipelines and nothing else, while the rail badge counts the invisible work. That is a worse board than today's, which draws every spawned child under its root.
- **Fix intent.** Every conversation of the project belongs to exactly one cluster. The seat's direct spawns that no pipeline or task claims become their own clusters (thread if a task names them, tree otherwise) and carry their parentage: `parentCluster: "seat"`. That relation is what F2 draws.
- **Acceptance.** The fixture gains three seat-spawned lanes (one working, one waiting, one with a child); each is a cluster on the yard; a capture gate asserts that the set of conversations across all clusters equals the project's non-archived conversations, and that the bar's counts equal the yard's. The same gate runs on the crowded scenario.

### F2 · P1 · Yard position encodes only rank; nothing is "grouped around" anything

- **Screen / element.** `yard`, `yard-crowded`, `field` at every width; `pack()` at `app.js:213-231` (a shelf packer over rank order), README §3.3 and §7 ("edges between clusters: today's model has no such relation").
- **Evidence.** In `out/1440/dark/yard.png` the seat is a corner tile; the four amber clusters sit in row one and two; the running pipelines in rows three and four; quiet at the bottom. Read left-to-right, top-to-bottom it is the needs-you list laid out as a grid. The map (side column) shows the same: rectangles in rows. The world has no edge, no hub, no adjacency that means belonging.
- **Why it hurts.** The operator asked for work *grouped around in clusters logical, maybe graph*. A shelf by urgency answers "what needs me" (already answered by keycaps, edges, the side list and `0`) and nothing about "what belongs to what". The relation exists (F1 restores it): the seat spawned these lanes, this pipeline was opened for that issue. Today's board at least keeps parent-above-children; the yard flattens that into rank.
- **Fix intent.** Lineage is the grouping principle. Concretely, deterministic and without physics: the seat is the hub at the origin; the clusters it spawned pack in rings around it in rank order (needs-you on the inner ring at twelve o'clock, then running, then quiet), so *around* is literal; clusters with no seat lineage (operator-created pipelines, imported trees) pack as a second group beside the hub. At block altitude a spine edge runs from the seat to each spawned cluster's header (one colour, one weight, the seat's violet); at yard altitude the hub reads from adjacency and a small tether mark on the tile. Pins stay obstacles; ranks stay keycaps; the world's aspect still follows the frame. If the ring is judged too much for lane 2, the floor is: F1's clusters are placed adjacent to the seat and the edges are drawn; the shelf may stay.
- **Acceptance.** From `yard.png` alone a reader can name which clusters the seat owns; `yard-block` shows the seat-to-cluster edges; the packing gates (no overlap, determinism, pinned obstacle, Release restores) still pass; fit-all still lands on tiles.

### F3 · P2 · Tiles are the block's rectangle with two lines in the corner

- **Screen / element.** Every yard frame; `.tile` (`styles.css:248-257`) is `inset: 0` over a cluster sized by `sizeOf()` (`app.js:200-209`) for its block content. Probe fill ratio (text bbox over tile rect): 1440 fit, seat 51 %, threads and trees 31–48 %, running pipeline p5 45 %, tree t:t9 31 %; 1920 fit (74 %) drops to 26–44 %. `out/_critique/dark-1440-zoom-85.png` is the worst picture in the design: tiles the size of blocks carrying a title and a phrase.
- **Why it hurts.** "Sized by their content … uneven the way a real yard is" (README §2) is true of the rect and false of what is drawn in it. The yard at 60–90 % is the altitude the operator lands on at 1920 and one wheel step above block everywhere, and it is mostly tinted air with 1 px borders: the identical-cards tell, and less information than today's fit, which at least shows the shape of a feed.
- **Fix intent.** Keep the geometry (nothing re-lays-out on zoom) and fill it. The tile carries a **silhouette of its block**: ghost stations or nodes in their true positions with their state dots and the current one outlined, the fail-loop bracket as a hairline, the seat's context meter, and under the title the live line (`working 12:40 · Read route.ts`, the question's title, the reviewer's finding count). Counter-scale the type as now; the silhouette scales with the world. A pipeline tile then reads as a train at a glance, and descending to block only sharpens it.
- **Acceptance.** On every yard frame the drawn content (text plus silhouette) covers at least 70 % of each tile; at 1920 fit-all no tile shows less than title, phrase, live line and per-node state; the yard-altitude "no node visible" gate is re-expressed as "no *interactive* node visible" (ghosts are inert).

### F4 · P2 · A pin displaces the yard instead of flowing around it

- **Screen / element.** `pack()` `app.js:216-228`: an obstacle is handled by jumping the cursor to its right edge on the current shelf, then wrapping. `out/_critique/dark-1440-after-tile-drag.png`: pinning the small tree at the right pushed the running pipeline `p1` a full row down and everything after it below the fold; `dark-1440-pin-overlap.png` (p2 pinned at 200,380): `p1` lands at y = 948, the rows above it are half empty. The fixture's `yard-pinned` frame shows the same air to the right of row two and three.
- **Why it hurts.** README §3.3 promises *the flow opens around it, never under it*. It opens by leaving holes and demoting the ranks below the pin. The operator moves one thing and the rest of the yard jumps; with three pins the shelf degenerates.
- **Fix intent.** Pack into free rectangles: seed the free list with the world, subtract the pinned rects, place each cluster in rank order into the best-fit free rectangle (top-left preference), split the remainder. Same determinism, same inputs, pins still obstacles, Release still restores the unpinned pack.
- **Acceptance.** Pinning any single cluster anywhere inside the packed bbox changes the fit-all zoom by less than 10 % and leaves no empty region wider and taller than the next unplaced cluster; the pin flow adds this as a gate.

### F5 · P2 · The receipt and the banner reflow the canvas

- **Screen / element.** `app.js:445` renders `.receipt` and `.banner` in flow above `.stagewrap`; `styles.css:176` gives the receipt 44 px. `out/_critique/dark-1440-receipt.png` and `after-tile-drag.png`: the board's top edge moves from 48 to 94 px while the receipt shows, and back after 4 s.
- **Why it hurts.** Every pin, answer, assign, pause and switch makes the whole yard jump 44 px down and 44 px up. For a board whose promise is a still world under a fast camera, this is the one thing that moves without the operator asking. The banner (arrival, degraded) does the same, for longer.
- **Fix intent.** Reserve the slot: one permanent 44 px announcement row under the bar that is empty (same colour as the frame) when there is nothing to say, so the canvas never resizes. Or draw receipts inside the bar's right half and banners in the side column's top. Either keeps "never over the canvas".
- **Acceptance.** The board's rect is byte-identical before, during and after a receipt and a banner; the capture measures it in the pin, answer and arrival flows.

### F6 · P2 · The settings sheet floats away from the chip that opens it

- **Screen / element.** `chat-settings` at 1280 and 1440; `.settings { left: max(14px, calc(50% - 440px)); bottom: 84px }` (`styles.css:405`). At 1440 the sheet's left edge is at 280 px while the chip is at 90 px; at 1280, 200 px versus 90 px. It sits over the feed's middle with a scrim dimming the conversation.
- **Why it hurts.** The rejection named today's menu as *anchored bottom-left, far from the field it configures* (README §1.2). The rewrite reproduces the distance in a different place, and adds a scrim, so choosing a model dims the message you are answering.
- **Fix intent.** Anchor to the chip: left edge aligned with the chip's left, bottom 6 px above the box's top edge, a 6 px notch pointing at the chip; no scrim (the sheet is a popover of the composer and inherits the composer's focus, so the dialog primitive's scrim is unnecessary); Esc and outside-click close it, focus returns to the chip as now. Alternatively grow the box upward as a tray of the same width as the box, which also removes the width mismatch at 1280.
- **Acceptance.** At all three widths the sheet's left edge is within 8 px of the chip's left; the feed is not dimmed; the existing sheet flow (one level, Esc to chip, value applies) stays green.

### F7 · P2 · At the real board's size the tiles cannot be read

- **Screen / element.** `yard-crowded` at 1280 (fit 32 %) and 1440 (36 %): small tiles show `Hero…`, `Investi…`, `Refacto…`, `Harden…`; the designer's own O1. The keycap and the phrase survive, the title does not.
- **Why it hurts.** Twelve to fifteen lanes is the operator's normal day; the promise is *see all work*, and at fit the operator sees state dots with truncated nouns, then reads the side list instead. The tile's width is the block's (one node, 228 px), which was never sized for a counter-scaled title.
- **Fix intent.** Give tiles a floor in world units derived from the title at the counter-scaled size (two lines of 12.5 px × inverse zoom at the crowded fit), or let a narrow tile drop its phrase for a second title line and put the phrase in the badge. With F3's silhouette the phrase is redundant for pipelines anyway.
- **Acceptance.** At the crowded fit at 1280 every tile shows its full first title line or at least two whole words; the gate counts `…` in `.tile .tt` and fails above zero.

### F8 · P2 · The account detail says when it runs out and stays silent on what stops

- **Screen / element.** `account-detail`, `accountDetail()` `app.js:858-872`: windows, burndown, pace, hourly, actions. No section names the conversations running on this account.
- **Why it hurts.** *Switch to this account* is the decision the page exists for, and it is made blind: the operator cannot see that the reviewer on lane 3 and the seat are on the account that runs out at 14:39, nor jump to them. Today's accounts dialog (#1424) was rebuilt around actionable limits; the stage must not lose the "which lanes" half of that.
- **Fix intent.** Add **Using this account** under the pace panel: one row per conversation bound to it (state dot, title, phrase, `open ›`), the seat first with its context meter; the Switch receipt names how many move. The status-bar chip's detail is the same page, so it comes for free.
- **Acceptance.** The fixture binds conversations to accounts; each row opens the chat; the accounts flow asserts the section exists for every signed-in account and is absent for a signed-out one.

### F9 · P3 · Tree lineage is flattened to one row

- **Screen / element.** `nodeRect()` `app.js:551-556` places every descendant on row two; `treeBody()` `app.js:621` draws every edge from the root. Probe `dark-1440-grandchild-edges.png`: a child of `c5` renders as a sibling of `c5` with an edge from `c4`.
- **Why it hurts.** The picture lies about who spawned whom, which is the one thing today's tree layout gets right.
- **Fix intent.** Rows by depth, edge from the real parent; the cluster grows by one node height per level. Acceptance: a three-level fixture renders three rows with edges from the actual parents.

### F10 · P3 · Fit-cluster centres a wide, short cluster in an empty viewport

- **Screen / element.** `yard-block`, `yard-inspect`: the pipeline sits in the middle band with the top third of the canvas blank; `fitCluster()` `app.js:301` pads 40 px and centres.
- **Fix intent.** Anchor the cluster in the upper third (or fit the cluster together with the neighbours that share its shelf/ring), so the descent shows context above and below. Acceptance: on `yard-block` at 1440 at least one neighbouring cluster is partly visible above the target.

### F11 · P3 · Accounts polish

- `sign in to read th…` truncates in the signed-out row at 1440 and 1280 (`accountRow()` `app.js:841`, `.win` grid `styles.css:428`): shorten to `sign in to read` or drop it, the row already says `sign in ›`.
- The week window has no burndown; the ideal-pace argument applies to it just as well. Show both windows, the 5 h chart first.
- *Today by hour* is a 96 px bar row inside a full-width panel with no scale; either give it an axis and the window's average as a rule, or fold it under the chart.
- Chart labels are 10 px at 1440 (`now`, `runs out 14:39`, `window opened`); use `--text-label` and move `runs out` into the pace panel where it already lives.

### F12 · P3 · The pin mark at yard altitude is an unscaled 10 px word

- **Screen / element.** `styles.css:271` hides the header's title, badge and keycap at yard altitude but not `.pinmark`, so a lone `pinned` in 10 px floats at the tile's top-right (`yard-pinned`, `after-tile-drag`). Put a pin glyph in the tile's `trow`, counter-scaled like the keycap; the dashed border stays.

### F13 · P3 · Two capture promises are not what the code does

- The flow *a chat's Esc returns to the yard with the node lifted where it lives* asserts only the hash; `backToYard` (`app.js:914`) sets no lift. Either set `S.lift` to the conversation (the better behaviour: you come back to where you were) or rename the step.
- The crowded needs-you list shows identical titles three times (`Harden the seat tick` × 3); a fixture artefact, but real lanes repeat titles too (`Review · round 2`): the row needs a disambiguator (issue number or engine · model) after the phrase.

## 2. Over-engineering pass — what to cut

- **Bar beacons** (`drawBeacons` `app.js:418-435`, `.beacon` styles). Off-screen needs-you is already answered by the keycaps (rank order, always `1`–`9`), `0` (fit what needs you), the side column's list with keycaps, and the map, whose needs rects are drawn at 0.95 alpha. The beacons add a fifth channel and 260 px of bar at 1280, and fold to `+n` there (the designer's own O3). Cut them; if direction matters, colour the map's needs rects amber and let the map be the compass. A round that removes them is a successful round.
- **Nothing else is heavier than its problem.** The shelf packer is simple and F4 replaces it with something of the same size. The stage editor is drawn ahead of the engine, which lane 4 states. The field is the same packer one level up. The four altitudes are the right number once F3 makes the yard altitude carry content.

## 3. What must not be regressed by the rework or the lanes

- The camera: transform-only pan (the zero-mutation gate), Ctrl+wheel zoom at the cursor, hysteresis at 80/90 %, the 30 % tile floor that keeps every canvas control at 44 px, fit-all landing on tiles, keycaps in rank order, `n`/`N`/`0`/`f`/arrows, the map with the viewport frame.
- Inside a cluster: stations with role, id, engine mark, model · reasoning, access, attempt pips, one phrase; every fail edge drawn to its target with its round budget; the current station outlined; the lift as a `div` at ≥ 100 % with the yard receded and Esc back to the board with focus.
- The inspector: findings block with Answer and retry / Skip, the vertical stage graph with attempts and `open ›`, actions with their inverse in the receipt, the stage editor taking focus.
- The chat: one 48 px header row with the meta folded in, the feed untouched below it, one composer box with the tools row inside, the slot's four states (Stop / Send / Queue / Respawn), Enter sends, the sheet one level with every group visible and Esc to the chip, the question card answering on click and on its digit.
- Accounts: every account of both engines in one list, two meters per row (empty, never absent, when signed out), the best pick named per engine, the detail with the burndown against the ideal pace, the burn rate and the burnout time, Switch with Switch back, Use one reset with its count, Sign in as the primary action on a signed-out row.
- The vocabulary and the badge recipe shared with mobile v2; receipts with their inverse and no confirmation anywhere; both schemes token-exact; identity-free fixtures; `out/` untracked; the capture's habit of proving each of these headless, plus the new gates named in F1, F3, F4, F5 and F7.

## 4. Environmental notes

GitHub and DNS were available (`gh issue view 1453` read); the transcript index was available. The capture ran under the local Playwright Chromium in the foreground; no background task was left running. No TypeScript check applies: the stage changed documentation and a framework-free prototype only.
