# Mobile v2 prototype — independent design critique (round 1)

Reviewed at commit `5c2add4b` on 2026-09-02. The prototype was opened headless in both schemes at 390×844 and 430×932, every one of the 21 screens was rendered with `bun docs/design/mobile-v2/capture.ts` (84 frames, every gate green) and clicked through: the banner, the attention queue and its Next, answering the question by option and by typed text, the keyboard frame, kill and respawn, close, crown, rotate with an engine change, retry / skip / pause on a pipeline, account switch, use-one-reset, killing a background task, scrim and × closes, the bar swipe in both directions, and every back button. Edge fixtures were injected on top: a 139-character title, a 34-character project name, 30 conversations, 10 pipelines, a seat with no orchestrator, a degraded runtime, and an 844×390 landscape viewport. No console error on any path. Every number below was measured with a playwright script against the same frames (element rectangles, route after each tap, `history.back()` results, fixture order versus rendered order); where two passes measured differently the second pass's value is the one printed.

The judgement below is of the product on a phone, against the operator's screenshot observations in issue #1439 (the ground truth of what hurts today), and against the design-system rules the prototype says it follows. Findings are ranked; each names the screen and element, why it hurts, the fix intent, and what "done" looks like. Section 5 lists what is right and must not be lost in the rework.

**Frame.** The requirement is met in direction: one bar, one primary surface, host detail behind a tap, full-width messages, one overflow, composer and model chip as one box. Nothing here is WRONG-PREMISE. What follows is the gap between a good picture and a product the operator can run a fleet from with one thumb.

---

## 1. P1 — changes the product

### P1-1 · Navigation model: the prototype has no consistent answer to "where does back take me"

**Screens / elements.** Bar `‹`, bar `⚠ n`, bar `⋯` on Pipelines, Pipeline and Accounts; the bar swipe; the browser's history.

**Evidence.**
- `prototype/app.js:316`, `:351`, `:378`: Pipelines, Pipeline and Accounts pass `menuGo: "#/board/menu"`. Measured: tapping `⋯` on Pipelines changes the route to `#/board/menu`, the screen underneath becomes the **board**, and closing the sheet leaves the operator on the board, not on Pipelines. Same on Accounts.
- `prototype/app.js:119`: `⚠ n` always goes to `#/board/attention`. Measured from a conversation: the screen under the attention sheet becomes the board; closing the sheet drops the operator on the board, not in the conversation they were reading.
- `prototype/app.js:287`: the conversation's `‹` is the constant `#/board`. Measured: Pipeline p1 → stage "Design" → conversation → `‹` lands on the board, not the pipeline. Attention sheet → conversation → `‹` lands on the board, not where the queue was opened.
- The router is a hash router, so the browser's own back (the iOS edge swipe, Android back) pops the previous hash. Board → `⋯` (`#/board/menu`) → Accounts → back-swipe **re-opens the board menu sheet**. `‹` on the same screen goes to `#/board`. Two back gestures, two destinations.
- `prototype/app.js:697`: the bar swipe steps through `F.conversations` in **fixture order** (orch, c1, c2, c6, c5, c3, c4). The switcher sheet (`app.js:528–541`) lists them in **triage order** (orch, c2, c6, c1, c5, c3, c4). Measured: from c1 a swipe left lands on c2 ("Needs you"), while the switcher shows c1 in "Working" after c6. The README (§4.2) says the swipe "steps through this list"; it does not. The swipe also runs off the end silently (three swipes at c4 stay at c4 with no feedback) and includes finished conversations.
- README §5 "Motion" describes sheets and dots only. Board → conversation → pipeline has no transition defined, so the phone has no push/pop language to make `‹` and the edge swipe feel like the same thing.

**Why it hurts.** On a phone the whole mental model is the stack. A sheet that teleports its host screen, a back button that ignores where you came from, and a system gesture that re-opens menus make the operator distrust every tap; that distrust is the "taps land on tiny truncated targets" feeling from the issue in a new coat. Lane 1 (shell) and lane 3 (conversation) would each invent their own answer.

**Fix intent.** One navigation contract in the README, prototyped:
1. Screens push; sheets do not create history (open with `replaceState` semantics, close on back). The browser back and `‹` are the same operation: pop the screen stack, never a sheet route.
2. Sheets open over the **current** screen. `⋯` on Pipelines opens a pipelines menu (or the board menu, but over Pipelines); `⚠ n` opens the queue over the conversation; closing returns to that screen unchanged.
3. `‹` pops to the screen the operator came from (pipeline → conversation → `‹` = pipeline); the board is the bottom of the stack.
4. The bar swipe walks **the switcher's list in the switcher's order**, skipping "Recent", and bumps at both ends (a 12 px overscroll and a haptic-equivalent flash of the title cell).
5. Motion: push = 200 ms slide (`--motion-base`), pop = the reverse, swipe-switch = 120 ms crossfade of the bar title and feed, sheets as already specified.

**Acceptance.** A headless test walks Pipeline → stage → conversation → `‹` and ends on the pipeline; board → `⋯` → Accounts → `history.back()` ends on the board with no sheet; `⚠` from a conversation → close returns to the same conversation with its scroll position; the swipe sequence from any conversation equals the switcher's row order minus Recent. README §3 carries the contract and §5 the transitions.

### P1-2 · The attention queue does not contain pipeline decisions

**Screens / elements.** Board "Needs you" section and `⚠ n` badge; banner; attention sheet; Pipelines list.

**Evidence.** `prototype/app.js:96` builds `attention()` from `F.attention`, which lists conversations only. Pipeline p2 is `needs_decision` ("Review round 3 · REQUEST_CHANGES", `fixture.js:212–235`) and appears nowhere in the queue: not in the badge count (2, not 3), not in the banner, not in "Needs you". It is folded into one summary row, "3 pipelines · 1 active · 1 need you · 1 done" (`app.js:164–175`), whose only cue is a warning edge. The row renders after every "Working" row (`app.js:196–199`), so with ten working lanes it sits past 1 000 px; with the ten-pipeline edge fixture (eight needing a decision) the board's `⚠` still read 2.

**Why it hurts.** A failed review round waiting for retry / skip is the operator's most frequent blocking event on this product (the record of #1439's own pipeline is one). The board's whole promise is "what needs me, in one second"; the thing that most often needs them is the one thing not in the queue.

**Fix intent.** One attention queue, two item kinds. A pipeline in `needs_decision` is a "Needs you" row on the board (title, `stage 3/5 · review failed · 2 findings`, badge `needs a decision`, tap → the pipeline screen), a row in the `⚠` sheet, a candidate for the banner, and counted in the badge. The "n pipelines" summary row stays as the entry to the list, without a warning edge (its warning moved up).

**Acceptance.** With p2 in the fixture the badge reads 3, "Needs you" shows three rows (two conversations, one pipeline), the attention sheet lists three, "Next ›" reaches the pipeline, and the ten-pipeline edge fixture puts every decision above the fold at 390×844.

### P1-3 · Only the happy path is drawn: no seat, degraded, offline, held, limit-blocked and stalled do not exist

**Screens / elements.** Seat card, banner slot, bar meta line, board rows, composer status row, accounts.

**Evidence.**
- Seat with no orchestrator (edge fixture `seat.state = "none"`): `app.js:149–162` still renders the card with a hard-coded `b-success` badge (line 155) reading "no seat" in green, plus the previous model, account and context meter. There is no "create an orchestrator" state.
- Degraded runtime (`host.runtime = "degraded"`): the only trace is the quiet Host row's meta text at the bottom of the board; the banner slot (README §2 principle 3 promises it carries "a runtime degradation") still shows the attention banner (`app.js:125–133` only knows attention).
- Offline / reconnecting: nothing in fixture, app or README. The operator reads this product from a phone precisely when they are away from the machine.
- Delivery held (`cardStatus.held` in the product's own vocabulary), account limit reached, stalled agent (danger dot in §5 "Visual language"): no fixture, no row, no meta phrase. `stateBits()` (`app.js:105–111`) knows killed / working / waiting / returned / done.

**Why it hurts.** The screenshot that opened #1439 had a "degraded" pill in it. Failure states are what a phone is for; a design that cannot show "the host is down", "this lane is held", "Main is out of Opus until 16:40" will get them bolted on by five different lanes in five vocabularies.

**Fix intent.** Add the states as fixtures and screens (both schemes, both frames):
- **No seat**: the card becomes an invitation: bot mark, "No orchestrator", one primary row "Create an orchestrator ›" opening the existing draft; nothing else on the card.
- **Degraded / offline**: the banner slot in `info` tone ("Runtime degraded · polling" / "Offline · reconnecting"), on every screen; the composer's send turns into "Queue" with a receipt "Held until reconnected"; the bar meta line says `offline` in muted, outranking everything.
- **Held**: row meta `held · 2 messages queue` in warning, danger dot off; conversation status row `held · text you send queues`.
- **Limit reached**: row meta `limit · Main resets 16:40`; the seat card and account card show the same phrase; the model chip offers the alternative account inline.
- **Stalled**: danger dot, meta `stalled · 14 min`, the `⋯` Kill row's hint reads "stalled".
One precedence list in the README: offline > degraded > killed > stalled > limit > held > waiting > working > returned > done.

**Acceptance.** Six new screen ids in `screens.js` (`board-noseat`, `board-degraded`, `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`) render and gate; the precedence table lives in README §4.2 and `stateBits` implements it.

### P1-4 · The bottom stack still carries a status row that repeats the bar

**Screens / elements.** Conversation screen, composer dock: `working · 12:40 · live tail · ■ Stop` (`app.js:252`, `styles.css:313–320`).

**Evidence.** At 390×844 the conversation bar's meta line reads `working 12:40` (`app.js:283`) and 640 px lower the status row reads `working · 12:40 · live tail`. The same state, twice, on one screen; the app's own comment at `app.js:248–251` states the rule that a state appears once. The row costs 36 px and exists to host Stop. "live tail" is the old pill's word, now permanent while working (README §3.4 counted it as removed chrome).

**Why it hurts.** This is the operator's observation 6 ("live tail pill, the working indicator … each its own row") surviving into v2 with the rows merged rather than removed. On the keyboard frame the row hides, which proves it is not load-bearing.

**Fix intent.** Delete the status row. Stop lives in the send slot: while the agent works and the draft is empty, the accent square is `■` (Stop) in the send position; typing turns it back into `⬆` (send queues behind the turn, as the product does). Killed state: the box's placeholder reads "killed · text queues until a respawn" and the send slot shows `▶ Respawn`. Elapsed time stays in the bar meta only.

**Acceptance.** `.status` is gone from the prototype; the dock measures ≤ 116 px working and idle; the chrome total in README §3.4 drops to 160 (204 with a banner); the keyboard frame is unchanged; a working conversation shows Stop in the send slot and a non-empty draft flips it to send.

---

## 2. P2 — should change before implementation

### P2-1 · The banner is redundant where it appears and missing where it matters

**Screens / elements.** Board banner (`app.js:206`, only place `banner()` is called); conversation screens.

**Evidence.** On the board the banner ("Agent is waiting for a reply · a question / Implement the export endpoint") sits 45 px under the bar and repeats, word for word, the first "Needs you" row 250 px below it, while the `⚠ 2` badge says it a third time. In a conversation, where a new arrival is invisible, there is no banner at all; the README's "one banner slot on every screen" (§2 principle 3, §4.6) is not prototyped, and neither is the auto-collapse (Q3).

**Fix intent.** Suppress the banner on the board when the queue is visible (always, since "Needs you" is the first section after the seat). Show it on every other screen for a **new** arrival, in flow, collapsing into the badge after ~6 s or on dismiss, exactly as §4.6 says. Body tap opens the conversation and stamps seen.

**Acceptance.** `board` frame has no banner; a new `chat-arrival` screen shows the banner over a conversation in both schemes; the prototype's collapse is visible (a timer in the prototype, gated by a test in lane 8).

### P2-2 · Row anatomy: one state said three ways, the least important fact said first

**Screens / elements.** Board and switcher rows (`app.js:135–147`), pipelines row.

**Evidence.** A waiting row reads: warning edge, warning dot, `gpt-5.6 · high`, `a question · 9 min` in warning bold, and a warning badge `a question`. The decision word appears twice on a 56 px row; three warning-coloured elements on one row against rule 7 (one accent element per component). The meta line leads with model and effort; the state and its age, the only thing the operator triages on, come last and get truncated first when the title is long. The pipelines summary row shows a three-dot cluster (`app.js:171`) that reads as a "more" glyph.

**Fix intent.** Row = dot · title · one meta line · one trailing element. Meta line order: state phrase first (`a question · 9 min`, `working 12:40 · Edit cardStatus.ts`), then engine mark and model; effort only in the conversation bar and the composer chip. The trailing element is either the decision badge (waiting) or the chevron, and when the badge is present the meta line drops the decision word. Warning colour on the edge and the badge only; the meta phrase in secondary text. The pipelines row uses one dot in its strongest state.

**Acceptance.** No row contains the same word twice; at most two warning-coloured elements per row; the long-title edge fixture still shows the state phrase in full (the title truncates, the state does not).

### P2-3 · The seat card and the "Working" rows do not say what the agent is doing

**Screens / elements.** Seat card (`app.js:149–162`), Working rows.

**Evidence.** The card shows `Orchestrator · live · Opus · high · Main · Max plan · ctx 24%` and a meter. The orchestrator's conversation state (`working 2:14`) and its last line ("218 has a question for you…") are absent; plan and account are host detail (already in the seat sheet). A Working row shows `working 12:40` and nothing about progress, while the fixture has the perfect line for it (`running Edit src/components/cardStatus.ts…`).

**Why it hurts.** "Working 12:40" answers nothing the operator opens the board for. The desktop card shows the last activity; the phone, where opening each conversation costs a round trip, needs it more.

**Fix intent.** Seat card: title row `Orchestrator · working 2:14`, second line = last agent message or running tool, truncated; context as the meter only (percentage in the sheet); account and plan move to the sheet. Working rows: meta line `working 12:40 · Edit cardStatus.ts` (running tool) or the first 60 characters of the last agent line when no tool runs. Rows stay 56 px.

**Acceptance.** Every working row and the seat card carry a "now" fragment from the fixture; the seat card no longer shows plan or account.

### P2-4 · One meter, two opposite meanings

**Screens / elements.** Seat card and seat sheet context meter (`app.js:157`, `:470`), Details & host context (`app.js:443`), accounts windows (`app.js:364`).

**Evidence.** The context meters fill by **used** (24 % used → 24 % filled, warning at ≥ 70 % used). The account meters fill by **left** (62 % left → 62 % filled, warning at ≤ 30 % left). Same component (`styles.css:262–265`), same colours, inverted semantics; the accounts card's corner number "38 % left" is the lowest window with no label saying which.

**Fix intent.** One semantic everywhere: the fill is what remains, colour by remaining (accent > 30 %, warning ≤ 30 %, danger ≤ 10 %). Context reads `76 % left of 100k` (or "used" everywhere, but one). Label the corner number with its window (`Week · 38 % left`).

**Acceptance.** Every `.meter` in the prototype fills with the same quantity; a note in README §5 states it; the accounts corner number names its window.

### P2-5 · Hit areas overlap, and chrome lines cost more transcript than the messages

**Screens / elements.** Feed: agent message header (`styles.css:280`, `margin: -8px 0 -10px`), tool lines (`styles.css:289`, `margin: -6px 0`); capture gate (`capture.ts:62–75`).

**Evidence.** Measured at 390×844: the 44 px message-header target ends 10 px **inside** the first line of prose on every agent message (header bottom 230, prose top 220; 386/376; 479/469), so a tap on the first line of an agent message opens "Copy · Read aloud". Consecutive tool lines overlap each other by 6 px (rects 541–585 and 579–623). The gate checks each control's size, never overlap, so it passes. In `chat-working`, five quiet tool lines cost 220 px and three message headers another 132 px of a 641 px feed: 352 px, more than half the transcript, for content the design system calls chrome packed "at 2 px".

**Fix intent.** No negative margins. Message header: 32 px visual, 44 px hit inflated **upward** into the message gap only. Tool lines: a folded run is one 44 px line; inside an expanded run (the error case) the individual lines are 36 px rows inside one sunken block, where the block is the target region and rows are list items (the design system's expanded-group body). Add an overlap check to the capture gate (no two visible controls' rects intersect).

**Acceptance.** Gate refuses intersecting control rects; `chat-working` spends ≤ 150 px on chrome lines; tapping the first prose line does nothing.

### P2-6 · Receipts cover the controls they report on and carry no undo

**Screens / elements.** Toast (`styles.css:440`, `bottom: calc(76px + safe)`, z 70; `app.js:88–92`, 2.6 s).

**Evidence.** Measured: after "Crown", the toast (710–754) sits exactly over the status row and its Stop control (698–742); once P1-4 removes that row the same fixed offset lands it over the composer box's top edge (box 742–824). Over the host sheet, "Killed PID …" covers the sheet's "Hidden" rows. The toast is text only. With confirmation prompts removed by the operator's rule, the receipt is the only safety net, and it has no action in it.

**Fix intent.** Receipts are anchored to the **top edge of the dock** (or of an open sheet's footer), positioned from the dock's measured height rather than a constant, so they sit over the last lines of the feed and never over a control; 4 s; `success`/`info` tone as today; and they carry the inverse action as a 44 px text button when one exists: Kill → Respawn, Close card → Reopen, Archive → Restore, Skip stage → Retry stage, account switch → Switch back, Use one reset → (none, state the new window). The bottom is the right place for a receipt with an action: the thumb is already there, and the banner slot at the top is for arrivals, not for undo.

**Acceptance.** A receipt never intersects a control (add the intersection check from P2-5 to the receipt's frame); each destructive receipt in the prototype offers its inverse and the inverse works.

### P2-7 · Two answer controls, two commit rules

**Screens / elements.** Question card options (`app.js:238`, `:595–603`: **send on tap**) and suggested-reply chips (`app.js:254`, `:604`: **fill only**); the answered state (`app.js:234`).

**Evidence.** Tapping an option row sends the answer at once; tapping a chip only fills the field, leaving a second tap on send. The two look like siblings (rows of white pills 30 px apart) and behave differently. After an answer the card collapses to `Answered: …` and the question text is gone; the answer does not appear as the user's bubble, though the product sends it as the reply message.

**Fix intent.** Chips send on tap too (the operator's words are the trigger, and a chip is their words); the field is for a custom reply. After sending: the question stays as a folded quiet line (`▸ question · answered 13:56`), and the reply renders as the user bubble in the feed, so the transcript reads as the transport actually did it.

**Acceptance.** Chip tap and option tap produce the same receipt and the same bubble; the folded question line expands to the original options.

### P2-8 · Switching to an unauthenticated account makes it "active"

**Screens / elements.** Accounts, account rows (`app.js:362`, `:624`).

**Evidence.** Tapping "Second · needs sign-in" or "Studio · Signed out" flips it to `active` with the receipt "Future launches use Second". Nothing signed in.

**Fix intent.** A row whose auth is not "Authenticated" opens the device sign-in on tap (the same flow as "Add a … account"); it becomes active only after sign-in returns. Its trailing glyph is `→ sign in`, not a chevron.

**Acceptance.** Tapping a needs-sign-in row shows the sign-in receipt and leaves the active badge where it was.

### P2-9 · A conversation cannot reach its own pipeline

**Screens / elements.** Conversation `⋯` menu (`app.js:512–526`), Details & host (`app.js:435–455`), bar meta line.

**Evidence.** The hop chips were cut (README §6) and nothing replaced them. c1 is the Design stage of p1 in the fixture; its screen, menu and details show no pipeline. The operator's screenshot had the pipeline strip precisely because lanes live inside pipelines.

**Fix intent.** In `⋯`, a first-group row `Pipeline · Mobile redesign prototype · stage 1/4 ›` opening the pipeline screen; in the bar meta line, when the conversation is the **current** stage, a trailing `· stage 2/4` fragment. Pipeline → stage → conversation → `‹` returns to the pipeline (P1-1).

**Acceptance.** `chat-menu` for a stage conversation shows the pipeline row; the bar meta of a current-stage conversation shows the stage fragment.

### P2-10 · Reading size: 13 px prose on a phone

**Screens / elements.** Feed prose and user bubbles (`styles.css:153`, `:283`, `:288`).

**Evidence.** Prose is `--text-body` 13 px at 1.45. The frames read as small even at 2×; the operator's complaint was "scrolls to read", and reading is what the conversation screen is for. Phone platforms set body copy at 16–17 px; the product's own 15 px token exists (`--text-title`).

**Fix intent.** On the phone, message content (agent prose, user bubble, question text and options) uses 15 px at 1.45; rows, meta and chrome keep 13 / 11. Tokens unchanged; the phone maps content to the larger token.

**Acceptance.** `.ma .txt`, `.mu .bubble`, `.q .qt`, `.q .opt` at 15 px; the §3.4 transcript share is re-measured and still ≥ 70 %.

### P2-11 · Vocabulary: five phrasings of one state, and internal words in the UI

**Screens / elements.** Board section "Needs you"; attention sheet "Waiting on you"; question card "waiting for your answer"; banner "Agent is waiting for a reply"; the product's switcher string "Waiting for you". Status row "live tail"; host sheet "updates stream; polling stands by"; details "structured host · claude"; the pipeline findings block's heading "Review round 3 · REQUEST_CHANGES" (`app.js:344`, a verdict token from the engine's JSON, in capitals, on a screen whose own badge already says "needs a decision"); switcher note "Swipe the title bar…"; accounts note "Nothing here asks you to confirm."; seat sheet "Nothing rotates until you confirm the draft."; "Working dir: the project's checkout".

**Fix intent.** One phrase for the queue everywhere ("Needs you" is the shortest and already the section title; the sheet title becomes "Needs you · 2"). Drop "live tail". Runtime reads `connected` / `degraded` / `offline`. Transport is a mono value in Details only when it is not the default. The findings heading reads "Review · round 3 · 2 findings" in the product's words. Remove the instructional notes (the swipe is discoverable through the switcher's hint on first open, or not at all); remove "confirm" from copy since nothing confirms; drop the "Working dir" row when it has no real value.

**Acceptance.** `grep -c "Waiting on you\|waiting for your answer\|Agent is waiting\|live tail\|polling stands by\|REQUEST_CHANGES\|confirm"` over `prototype/` returns 0; README §4 uses the one phrase.

### P2-12 · OVER-BUILT: three doors to the same host sheet, and one of them is an always-on host row

**Screens / elements.** Board "Host" section + row (`app.js:177–184`, `:202–203`), board `⋯ › Host details` (`app.js:426`), conversation `⋯ › Details & host` (`app.js:520`); the seat sheet's "Working dir" row (`app.js:471`).

**Evidence.** The issue asks that host details "live behind one tap, never as always-on rows". The board still ends with a section titled Host and a row reading `runtime live · 2 background tasks · 14 quiet · 3 collapsed workers`, host detail on the primary surface. With the default fixture at 390×844 it is the only thing below the fold: the body scrolls 746 px in a 683 px viewport, and the "Host" heading sits on the fold with its row hidden under the dock, so the board scrolls for a row nobody came for; with the 30-conversation fixture it sits past 2 100 px, so it is also unreachable. The same sheet is one row in `⋯`. Degradation, the only host fact the operator needs unprompted, belongs in the banner slot (P1-3).

**Fix intent.** Cut the board's Host section and row. Keep `⋯ › Host details` (badge `degraded` on the row when it is) and the conversation's `Details & host`. Cut the "Working dir" row.

**Acceptance.** `board` frame has no Host section; the board menu's Host row carries the runtime badge; the seat sheet has no working-dir row.

---

## 3. P3 — worth doing in the same pass

### P3-1 · Landscape is undefined
At 844×390 the `min-width: 640px` bench (`styles.css:180–189`) appears and the page scrolls; the design has no landscape statement. Say it in the README: same layout, the keyboard frame is not budgeted in landscape, the bench gates on `min-width` **and** `min-height`. Acceptance: an 844×390 render shows the shell, not the bench.

### P3-2 · Long lists
With 30 conversations the board is about 2 200 px; "Recent" holds every finished conversation as a full 56 px row, and the pipelines row comes after every Working row. Cap Recent at three rows plus `All conversations · n ›`; move the pipelines summary row above "Working" when any pipeline is active. The switcher (33 rows, sheet at 88 %) should open scrolled so the current row is visible, which it does; keep that. Acceptance: the 30-conversation fixture board is ≤ 1 400 px tall.

### P3-3 · Pipeline screen: the title cell says "Pipeline", the body repeats itself
The bar's title cell, the widest cell on the phone, holds the word "Pipeline" (`app.js:322`) while the task title, state badge, stage counter and start time stack in a header block below it (`app.js:339–343`). Use the conversation bar's own pattern: title cell = task title, meta line = `needs a decision · stage 3/5 · 2h`; the header block goes. The template line `design → implement → review → fix → merge` (`app.js:342`) repeats the stage list below it; drop it. The Review stage row has no conversation in the fixture though review stages always do; give it one, so "2 findings" is a tap away from the reviewer's transcript. Acceptance: the pipeline bar shows the task title with a meta line; no header block, no template line; every reviewed stage opens its conversation.

### P3-4 · Title truncation
The conversation bar shows 39 of 139 characters; a "Needs you" row shows 29. Allow two-line titles on "Needs you" rows (64 px row) and a two-line title in the bar when the meta line is empty (idle). Acceptance: the long-title fixture shows ≥ 60 characters on its board row.

### P3-5 · Engine marks are the loudest pixels on every row
The filled orange / blue 16 px circles (`styles.css:249–252`) appear on every row and every message header; on the board they are the most saturated element in the viewport while carrying the least decision weight (rule 7). Use the glyph in secondary colour inside rows and message headers; keep filled marks on account cards and the seat sheet. Acceptance: no filled engine circle inside `.row`, `.mrow`, `.who`.

### P3-6 · Both switching affordances live in the unreachable zone
Title-cell tap and bar swipe are at the top; one-handed on a 6.1-inch phone both need a second hand. State it as accepted, or add a reachable alternative: a horizontal swipe on the dock (composer box) walks the same list. Acceptance: README §3.1 names the choice.

### P3-7 · Copy pass on the sheets and the footer
"Replaced an earlier orchestrator · open ›" is a sentence in a row; "Edit the mandate · opens a rotation" says the mechanism instead of the outcome ("Edit the mandate · replaces the orchestrator"); the rotate draft's "Keep this one" is Cancel. The board footer's placeholder "Tell the orchestrator what should get done in atlas…" (`app.js:205`) truncates before the project name at 390 px, so the one word that varies is the one that is cut; "Tell the orchestrator…" says the same. Acceptance: every row label is a noun phrase or a verb phrase, never a sentence; the footer placeholder fits at 390 px without an ellipsis.

### P3-8 · Dark-scheme only
The quiet `.row.quiet` recipe (border, no shadow) and the card recipe (shadow-1) are indistinguishable in dark; the `Recent` rows read the same as `Working`. Either drop the distinction or lower the quiet rows' text to secondary. Acceptance: a dark `board` frame shows Recent rows visibly quieter.

### P3-9 · Gestures that are promised but not drawn
README §2 principle 1 says a sheet closes "with one tap on the scrim, the `×`, or a swipe down", and every sheet carries a grab handle (`app.js:385`, `styles.css:361`); nothing in `app.js` handles a drag, so the handle is decoration and the swipe is a claim the lanes will each implement differently or not at all. Either prototype the drag (follow the finger past 80 px, release closes, else spring back over `--motion-base`) or drop the handle and the sentence. In the attention sheet, "Next ›" (`app.js:413`, `:641`) always opens the **first** queue item, so from inside that conversation it opens the same conversation; Next should skip the current one and wrap. Acceptance: a sheet closes on a simulated 80 px downward drag in the headless run, or the handle and the sentence are gone; "Next ›" from the first queue item lands on the second.

---

## 4. The five open questions — the critic's answers

1. **Board = triage list, map-lite cut on the phone.** Agree. The list answers the phone's questions in words; keep the desktop scheme untouched.
2. **Board footer "Tell the orchestrator…".** Agree, as a launcher into the orchestrator conversation with the keyboard open. It must not become a field that sends from the board, because the reply lands in the conversation.
3. **Hide the badge at zero; banner collapses after ~6 s.** Agree on both, with the amendment in P2-1: no banner on the board at all, and the collapse must be prototyped before a lane inherits it.
4. **Kill and Close act on the tap.** Agree, no arm step anywhere (the two-tap arm is a confirmation in disguise). The safety net is the receipt with its inverse action (P2-6), which the prototype already half has as "Respawn" in the status row.
5. **One reasoning vocabulary, the tier ids.** Agree. `low · medium · high · xhigh · max` are the operator's own words; the 2026-08 audit's friendly names would be a translation nobody asked for.

---

## 5. What is right and must not be regressed

- **The bar budget.** Back, a title cell of ≥ 190 px at 390 (measured 236 on both the board and the conversation bar with the attention badge present), at most three targets, the meta line under the title. This is the single biggest win over today's header; keep the measurement in the gate.
- **One overflow.** Every former header control is a labelled row in `⋯`; the danger group is last and separated. Keep the order and the hints ("running now").
- **Sheets over the screen**, scrim and × close, 88 % max height, the grab handle. Keep, and give them the history rule from P1-1.
- **The switcher mirrors the board's sections** with the current row checked. Keep the sections identical between board, switcher and attention sheet.
- **Full-width agent prose with a 16 px inline mark**, user bubbles at 86 %, folded tool runs with counts and a time range, errors in danger with the detail block, the running tool as the last line. This is §3.4 of the design system finally drawn.
- **The composer box**: field on top, chip · attach · dictate · send below, 16 px field so iOS does not zoom, chips above it when replies are suggested. Keep the chip **inside** the box.
- **The keyboard frame**: the question card stays visible above the keyboard (measured: the whole card, 124–359 px, inside the 317 px feed that remains), chips stay, send ends at 499 px against a 508 px keyboard edge, no page scroll. Keep the gate.
- **The question card order**: header, question, options, "or type your own answer". Transport out of the way.
- **The killed state with Respawn** and text queuing; the receipt wording is honest.
- **The seat sheet as a bottom sheet** with Rotate and Open conversation at the thumb; the rotate draft's segmented controls and the account rows; landing in the successor's conversation after a rotation.
- **The pipeline screen**: findings block, the two actions for the state, the stage list with the accent edge on the current stage, linked tasks. One surface for what used to be three.
- **Accounts & limits**: active card with windows and resets, quiet rows for others, "Add" last; Refresh and Use one reset as text buttons.
- **Tokens value-for-value** with `src/styles/tokens.css`, both schemes via `prefers-color-scheme` and `data-theme`; the capture gate for scheme, overflow and the 44 px floor; the identity-free fixture; `out/` gitignored.
- **The implementation plan's shape**: one lane per slice, one owner per file, i18n keys append-only per lane. Re-slice for the findings above (navigation contract into lane 1, states into lanes 2–3 and 8, the status-row removal into lane 5, pipeline decisions into lanes 7 and 8), and add the new screen ids to lane 0's matrix.
