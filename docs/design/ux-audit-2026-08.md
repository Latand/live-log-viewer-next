# Viewer UX audit — synthesis and triaged backlog (issue #693, 2026-08)

> Originating requirement (issue #693, opened by the operator; verified against the live issue 2026-08-14): *"Run a sequential, evidence-based UX/UI audit of Agent Log Viewer using its demo/capture fixtures and synthetic data. Find genuinely confusing, cluttered, inaccessible or poorly responsive surfaces before implementation work begins. The work is research only. It must produce screenshots, observations and a prioritized remediation brief; it must not change product code or live Viewer state."*

This is stage 5 of 5: synthesis. Four sequential lenses (reconnaissance, visual hierarchy, interaction/comprehension, responsive/visible-control correctness) each captured evidence and handed a dossier forward. This stage re-verified every load-bearing claim against the rendered frames (loaded into multimodal context, pixel-sampled where contrast was claimed) and against current source with file:line, dropped one false positive, collapsed duplicate observations by root cause, and deduplicated against the open backlog and the previous #693 tranche (#696–#702, closed 2026-07-26; #699 still open with a fix landed on main). Operator scope note honoured: screen-reader/assistive-technology conformance is out of scope; lens 4 audited responsive behaviour and visible controls.

Every evidence frame regenerates deterministically from a committed script against synthetic fixture data; frames are referenced as `<script> → <frame>` instead of being committed, so the repo carries no new binaries and no environment paths.

## Capture matrix (what was actually inspected)

Viewport bands: desktop ≈1440–1600 · laptop ≈1180–1366 · tablet 768–1024 · phone 390–396. Scripts run with `bun scripts/<name>.ts`; Family-B scripts need only local Chrome. Committed stills in `docs/media/` (regenerated 2026-08-10) stood in for the Docker-only Family-A cells.

| Surface | Desktop | Laptop | Tablet | Phone | States covered |
|---|---|---|---|---|---|
| Overview board | ● 963 | ● demo:capture still | — | ● 963 | zero/one/many attention |
| Project board, card states, far zoom | ● 961/964 dark+light | — | — | ● 961/964 (10 op-states × 2 schemes) | populated, dense (7 & 12 trees), collapsed stack |
| Switchboard | ● 961/964 dark+light | — | — | — | waiting/working/recent/older |
| Conversation feed, question card | still + ● 961 composite | ● demo:capture still | — | ● 961 focus | pending question, working |
| Composer | inside feed frames | ● still | — | ● 961/979 | send/spawn placeholders |
| Draft launch + directory picker | ● 887 (12 frames) | — | — | ● 887 | closed→launched incl. receipt |
| Orchestrator dock (desktop) | ● 977/978 (28 frames, both schemes) | — | — | n/a | draft/creating/error/live/rotation/successor |
| Mobile orchestrator row + sheet | n/a | n/a | — | ● 979 (30 frames, geometry-gated) | draft/creating/error/live/rotation + keyboard-open |
| Attention island / queue | ● 963 | — | — | ● 963 | zero/one/many/popover/filter |
| Pipelines (editor, stage cards, halo) | ✗ both capture scripts fail | ✗ | — | ✗ | **unaudited** (T1) |
| Flows / review decks | — | ● demo:capture still | — | ● still | expanded/collapsed rounds |
| Tasks kanban (uk) | — | ● still | — | ● still | populated |
| Document/artifact preview | — | — | — | — | **no tooling exists** (D4) |

State coverage: populated broadly; *empty* only for attention (zero) and orchestrator draft; *error* only for orchestrator designate/rotate and switch-failed; *loading* nowhere (scripts gate on `networkidle`). Tablet band has zero frames — finding 11 is source-derived and names the missing cell.

## The four lenses, in one paragraph each

**Stage 1 — reconnaissance** inventoried both capture families, produced the matrix above, and flagged the traps that held (node-500 server trap, tmux socket length, capture-dir allocator rules). Its over-engineering verdict stood all audit long: existing tooling covered stages 2–4 with no new fixtures.

**Stage 2 — visual hierarchy and density** produced the highest-cost findings (board fit-zoom collapse, overview attention blindness, switchboard duplication, question-card inversion) and one method rule this stage kept: pixel-verify any scheme/contrast claim before it enters the backlog. Its one *verify*-flagged item was indeed a false positive (below). It also established what works: the switchboard triage grouping, the card state vocabulary, held/rotation visibility, and real dark-scheme parity.

**Stage 3 — interaction and comprehension** walked the newcomer workflows (start, message, review, close, recover) and found the copy-level defects: three vocabularies for reasoning effort, contradictory liveness signals, error remedies naming controls the screen lacks, the unnamed recovery surface. It verified every label claim in `src/lib/i18n/en.ts` rather than from pixels. Its praise list (launch-flow coherence, dead-host recovery card, directory-picker keyboard support) survived re-checking.

**Stage 4 — responsive and visible controls** re-ran the #979 geometry-gated capture (all gates green) and verified four contracts HOLD: the #983 keyboard budget, the #699 fix on main (44px rows, no nested interactive controls), no horizontal overflow at 390px on recent surfaces, and confirm-guarded destructive controls everywhere it checked. Its new findings: the tablet sizing predicate, the keyboard-hidden mandate field, the reduced-motion utility gap, and the pinned-row truncation hazard.

## Verification outcomes (what changed in triage)

- **Dropped as false positive:** "dark far-zoom projection labels look low-contrast" (stage 2, flagged *verify*). Pixel-sampled `capture-issue-964-anatomy.ts → 964-far-zoom-dark` at 3× crop: core label text ≈ `#d4d4d8` on `#131318` card surface, ≈12:1 contrast. Both schemes give the projection an opaque card surface. Dropping this saves an implementation lane.
- **Mechanism corrected:** the board is *not* unconditionally single-row. `placeRestRun` wraps rest-band rows — at a fixed `REST_BAND_MAX_W = 10_500` px (`src/components/scheme/layout.ts:47`, wrap test at `:1148`), an order of magnitude past legibility. The defect stands; the smallest fix shrinks from "build row wrapping" to "retune an existing wrap policy".
- **Staleness corrected:** stage 3 cited the composer placeholder "the agent will start in tmux" from a committed still. The composer string was already fixed by #702 (`composer.placeholderSpawn`, en.ts:343). The residual is the **draft pane**: `draft.hintNew` and `draft.placeholder` (en.ts:530,533) still promise tmux while `spawnTransport()` defaults to structured (`src/lib/runtime/spawnTransport.ts:34`). Filed as finding 15, referencing #702.
- **Severity refined:** the mobile header crush lands as a legibility defect — stage 4 verified Kill is a two-step armed confirm and trash confirms, so #699's near-miss-destructive class stays capped and the data-loss risk stage 2 suspected is off the table.

## Triaged defect backlog

Severity: **S1** = degrades the daily core loop (glance-triage, answering agents); **S2** = meaningful friction on a daily surface; **S3** = polish with a cheap fix. Confidence is post-verification. Owner: Fable = UI/design, Sol = architecture/tooling. Evidence is `script → frame`; source is file:line on this branch (main-equivalent).

### S1 — the "can I trust a glance" cluster

**1. Fit zoom is illegible exactly on busy days — rest-band wrap threshold is ~10× too wide.**
Evidence: `capture-issue-964-anatomy.ts → 964-board-dense-dark` (12 trees → ~12% zoom, thumbnails unreadable, ~85% of canvas empty), `capture-issue-961-status.ts → 961-desktop-dense` (7 trees → 25%), `961-mobile-390-map` (same centering wastes the phone). Cause: `REST_BAND_MAX_W = 10_500` (`src/components/scheme/layout.ts:47`); rows wrap only past that span (`:1148`), so fit zoom scales with n instead of √n. Impact: the board's one-glance triage dies at roughly 6–8 trees; a real day forces pan/zoom or the switchboard. Smallest safe fix: derive the band width from tree count/target canvas aspect (or lower the constant to ≈3,500–4,000) — a policy tune inside the existing atomic-run wrap, no visual-language change. Owner: Fable. Links: #183 (semantic zoom is the destination; #703 directed measured evidence there — see D3 for the interim-fix decision). Confidence 0.95.

**2. Overview rows carry no attention state.**
Evidence: `capture-issue-963-attention.ts → 963-desktop-many` (NEEDS YOU 4 while every branch row renders identically: green dot + engine chip + title), `963-mobile-many`. Source: `OverviewBoard.tsx` rows render engine badge + title only. Impact: the all-projects screen fails "what needs me", the single most frequent question; identifying the rows requires the queue popover. Smallest safe fix: reuse the board status vocabulary on rows — amber dot + warning-tone title (or compact NEEDS YOU chip) for branches holding an attention id. Owner: Fable. Links: related #699 (fixed the tap targets, deliberately preserving row anatomy). Confidence 0.95.

**3. Operator-blocking waits display as green "working".**
Evidence: `docs/media/pending-question.png` (green bouncing dots, "running AskUserQuestion… · 1:30:00" while the agent has been blocked on the operator for 90 minutes). Cause: the status label derives from the last transcript item only (`LogFeed.tsx:447–452`); `TurnStatusBar` renders success tone whenever the turn runs, with no precedence for `pendingQuestion`/`waitingInput`/`rateLimit`. Impact: the most-used surface answers "does this need me" wrong, in the calmest possible tone. Smallest safe fix: a display precedence rule — operator-blocking states override label and tone ("waiting for your answer · elapsed", warning tone, matching the pill). Owner: Fable. Links: #700 (closed — gave the question card its amber card and missed the status bar), #924 (same busy-silent family on the data side: throttled host indistinguishable from a hang; that join stays Sol's), #765 (adjacent question-card lifecycle, fix in flight). Confidence 0.9.

### S2 — daily friction

**4. Mobile focus-card header: five always-inline controls crush the title to one character.**
Evidence: `961-mobile-390-focus` (title "G…" beside edit/collapse/crown/trash/close), re-verified on this branch by `capture-issue-979-mobile-orchestrator.ts → 979-row-live-rotation-dark` ("R…"). Destructive members are confirm-guarded (two-step Kill, confirmed trash), so the cost is that attention cards cannot say what they are. Smallest safe fix: fold crown/trash/close into the existing `⋯` overflow, keep edit + collapse (design-system rule 4 already wants destructive actions behind `⋯`). Owner: Fable. Links: #699 related. Confidence 0.95.

**5. Keyboard-open create sheet can hide the focused mandate field entirely below the fold.**
Evidence: `979-sheet-intent-error-keyboard-light`/`-dark` — error card + engine/account/reasoning fill the visible scroller; the "Mandate" label sits at the fold and the focused textarea starts past it; `979-sheet-draft-edited-keyboard-*` shows one visible line. The script's gate measures only the confirm button (`scripts/capture-issue-979-mobile-orchestrator.ts:229–263`), so this passes silently. Impact: on the newest create surface, in its error-recovery state, the operator types into an invisible field. Smallest safe fix: on mandate focus while `kbInset > 0`, `scrollIntoView({ block: "start" })` in the sheet's scroller (or collapse the explainer header on focus); extend the gate to require the field's top above the fold. Owner: Fable. Confidence 0.95.

**6. The question card leads with red transport jargon above the question.**
Evidence: `961-mobile-390-focus`, `961-card-needs-you`: order is "waiting for a reply" → **"tmux pane unavailable" in danger red** (`QuestionCard.tsx:355`, again at `:380`) → the actual question → "open session". Structured pane-less transport is the default (`spawnTransport.ts:34`), so a missing pane is routine state, announced in the tone reserved for breakage, above the operator's highest-value read. Smallest safe fix: demote pane/transport status to a muted caption below the question; reserve danger for actual delivery failures. Owner: Fable. Links: #765 (adjacent), #702 family. Confidence 0.95.

**7. Switch cards say everything twice.**
Evidence: `964-switchboard-dark`/`-light`: every Recent/Working card duplicates its title in the status line ("Rebuild the board status projection." / "Rebuild the board status projection. · 60s ago"); the rate-limited card carries a "rate-limited until 15:30" chip *and* a "rate-limited" body line. Cause: `timelineLabel` echoes the latest event label, which for these cards IS the first prompt = the title (`useSwitchboardData.ts:52–53`), and `:45` re-states what `RateLimitBadge` already shows. Impact: the main switching surface scans at roughly half its possible density (rule 3: a title appears once). Smallest safe fix: suppress the status line when it string-equals the title (modulo the age suffix); drop the body word when the chip renders. Owner: Fable. Confidence 0.95.

**8. Attention chrome occludes the content it points at, and repeats itself on mobile.**
Evidence: `963-desktop-zero` (pill overlaps the forge card's corner counters at 1280px), `963-desktop-many` (the "Agent is waiting for a reply" toast covers the forge card region it refers to), all ten `964-mobile-390-*` frames (the toast is a permanent ~130px banner above an 844px viewport, repeating what the pill queue and chip strip already carry). Smallest safe fixes: inset the toast below the first card row; on mobile auto-collapse the banner into the pill after a few seconds. Owner: Fable. (Whether the pill should render at zero at all is D1 — the occlusion is a bug regardless.) Confidence 0.9.

**9. One concept, three vocabularies: reasoning effort.**
Evidence: `961-mobile-390-focus` composer pill "Sonnet · Light"; `979-sheet-intent-error-keyboard-light` reasoning dropdown "low"; `887-desktop-closed` header "effort: default". Source: two parallel tier vocabularies live in one file — `reasoningTier.low: "Light"` (en.ts:556) and `effortTier.low: "low"` (en.ts:547) — plus `draft.effortDefault` (en.ts:512) and raw stored effort in `IncumbentHeader.tsx:77`. Impact: every model/effort decision passes through a private translation table; "Light" beside a lightning glyph can also read as the colour scheme. Smallest safe fix: one vocabulary (the `reasoningTier.*` names) in every dropdown and header; prefix the pill's second segment ("effort · Light"). Owner: Fable. Confidence 0.95.

**10. Failure surfaces name controls the screen doesn't have — or attach no action at all.**
Evidence: `capture-issue-978-incumbent-rotate.ts → 978-rotate-error-light` and `979-sheet-intent-error-*`: the otherwise-model error card instructs "pass cwd explicitly or set LLV_ORCHESTRATOR_CWD" (`src/lib/orchestrator/seatCommand.ts:448`) with no cwd field anywhere in the panel; `964-mobile-390-switch-failed-light`: the "Account switch failed — successor never came up" ribbon offers nothing to tap. Impact: the errors that do occur dead-end into the terminal; this repo's incident history makes actionable errors the priority class. Smallest safe fix: every failure ribbon carries its retry/inspect affordance; remedies that are parameters get an in-UI field or a link to where they are set instead of a bare env var. Owner: Fable for the surfaces; Sol if a retry endpoint is missing. Confidence 0.95.

**11. Tablet band: controls sized by the wrong predicate — sub-44px on coarse pointers.**
Source-derived (no tablet frame exists — the missing capture cell is part of T2): the layout switch is pure width, `MOBILE_LAYOUT_QUERY = (max-width: 767px)` (`src/lib/attention/eligibility.ts:26`), so an iPad-portrait-class coarse-pointer viewport at exactly 768px gets the desktop chrome, where strip faces size by `isMobile ? "h-11 w-11" : "p-2"` ≈ 32px (`AgentControlStrip.tsx:60,316`). The repo's own newer convention already uses `(pointer: coarse)` (`actionStyles.ts`, `OverviewBoard`, `CopyButton`, EdgeChips), and design-system rule 8 requires ≥44px on coarse pointers. Smallest safe fix: swap the ternary for the coarse-pointer predicate (`[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11`) on strip faces and the board toolbar; add the 1024×768 coarse capture cell as evidence. Owner: Fable. Links: #691 loosely (conversation-window responsive design). Confidence 0.8.

### S3 — polish, cheap fixes

**12. Chips ellipsize into noise; the empty "Older" band renders furniture.** `964-switchboard-dark`: "«Acco…", "⏰ 2…" — a chip conveying nothing still charges pixel rent; the Older section renders a full-width band with counter "0" unconditionally (`Switchboard.tsx:229–237`). Fix: icon-only below a minimum useful label width (the glyphs are distinctive); hide Older at zero. Owner: Fable. Confidence 0.95.

**13. Map-lite nodes spend their width on a constant engine chip.** `961-mobile-390-map`: every node = dot + truncated "Clau…" chip + 4-character title; the discriminator gets 4 chars while the constant gets half the node. Fix: icon-only engine glyph (shape stays a carrier, honouring the "colour is never the only carrier" convention), width to the title. Owner: Fable. Confidence 0.9.

**14. Unlabeled counter pairs are cryptic.** `963-desktop-zero`/`-many`: bare "8 8" / "2 2" pairs on project cards and sidebar rows; two adjacent identical integers are unlearnable even under rule 5's muted-counter treatment. Fix: one glyph each (● live / ▤ trees) or collapse to a single live/total figure. Owner: Fable. Confidence 0.9.

**15. Copy-pass batch (residual of closed #702 plus label nits).** The draft pane still promises "the agent will start in tmux" (`draft.hintNew`, `draft.placeholder`, en.ts:530,533) while structured transport is the default; the row labeled "reasoning" fronts a *model* dropdown (`DraftAgentPane.tsx:868`); "Main · active" renders an account/status jargon pair beside an unlabeled dot; the flow banner's "auto" chip and the sidebar QR-grid icon are unexplained until used. Fix: one copy pass. Owner: Fable. Links: #702. Confidence 0.95.

**16. The recovery surface is titled "Root conversations".** `trash.title` (en.ts:124) names the place closed cards go without saying so; card × (recoverable) and trash (permanent) both lead there conceptually. Fix: rename to say closed/archived conversations live here. Owner: Fable. Confidence 0.9.

**17. Pinned orchestrator row can truncate the state word away.** Non-live states render `` `${incumbent} · ${stateWord}` `` in one truncating 38vw span (`MobileOrchestratorRow.tsx:240,275`), contradicting the component's own comment ("colour is never the only carrier", `:233`) once a long model id eats the state word. Fix: `shrink-0` span for the state word; truncate only the incumbent. Owner: Fable. Confidence 0.9.

**18. Touch has no route to icon-only control meanings.** Strip faces and board-toolbar glyphs carry `title`/`aria-label` reasons (`AgentControlStrip.tsx:65,100`) that hover surfaces and touch cannot reach; the labeled `⋯` sheet already exists. Fix: ensure every touch-reachable strip control is also present as a labeled row in the `⋯` sheet. Owner: Fable. Confidence 0.85.

### T — tooling and coverage debt

**T1. Both pipeline capture scripts fail on current main — the pipeline surface is unaudited.** `capture-issue-507-editor.ts` dies seeding (`PipelineStoreError: refusing to persist a malformed pipeline record`, store validation vs the script's drifted fixture); `capture-pr-353-halo.ts` aborts its own gate ("expected two compact history anchors, received 0"). Reproduced by stage 2; per stage-1 trap #7 an abort is a finding. Fix: update both fixtures to the current store schema, then run the missing pipeline-density audit cell (editor, stage cards, verdict popover, halo) as a small follow-up lens. Owner: Sol. Confidence 0.95.

**T2. Missing capture cells, each one small:** tablet 1024×768 with `(pointer: coarse)` (one viewport argument in any Family-B script — evidences finding 11); empty-board state (an empty seeded home); error states beyond the orchestrator (catalog failure, connection lost, delivery failure — one small script per the 977 recipe); laptop-band variants (one-line viewport args). The artifact preview pane is a separate decision (D4). Owner: Sol/Fable shared. 

## Decisions needed from the operator

These are discoveries where the audit must not quietly decide. Each is one question.

**D1. Should the attention pill render "NEEDS YOU 0" at rest?** The zero state is *deliberate* — the source comments it as a designed quiet-zero (`AttentionIsland.tsx`, "The zero state stays present and quiet"). The audit's hierarchy lens reads a labeled zero as furniture that spends the attention accent on nothing. Keeping or hiding it is a design-philosophy call (persistent landmark vs. earn-your-accent); the 1280px occlusion (finding 8) gets fixed either way.

**D2. Does reduced-motion coverage enter the next tranche?** Issue #693's lens-4 text asked for reduced-motion inspection; #703 then explicitly excluded reduced-motion work from the first tranche. The measured gap: nine `prefers-reduced-motion` CSS blocks and three JS checks still every *custom* animation, while Tailwind utilities bypass it all — `animate-bounce` runs perpetually on every working conversation's status bar (`TurnStatusBar.tsx:65–67`), `animate-pulse` in ~10 components, `animate-spin` in 55 files. The close is one global CSS block stilling bounce/pulse (spinners = deliberate choice either way). Include it now, or keep the exclusion standing?

**D3. Interim board-density fix, or hold for #183 semantic zoom?** #703 directed measured zoom evidence into #183 (posted there). Finding 1's wrap-policy tune is small, reversible, and independent of the #183 vision — it buys legible fit zoom now, and semantic zoom later supersedes it. Ship the interim tune, or keep the board frozen until #183 is designed?

**D4. Does the artifact preview surface (Text/Image/Pdf panes, `ArtifactPreviewHost`) get audit tooling at all?** It is the one operator surface no capture script reaches; auditing it means writing one small dedicated script (977 recipe). If the surface is rarely in the daily loop, the honest answer may be to accept the permanent gap — building the script is scope only the operator can justify. (Related open defect: #883, stale PDF page after replacement.)

## Backlog dedup summary

| Open issue | Relationship to this audit |
|---|---|
| #183 semantic zoom | Destination for finding 1's measured evidence (posted as a comment there per #703's direction); D3 covers the interim fix |
| #699 mobile tap targets (fix on main) | Verified HOLDING by stage 4; findings 2 & 4 are adjacent new defects, deliberately distinct in scope |
| #700/#702 (closed, first tranche) | Residuals filed as findings 3 and 15 — each names the exact missed surface |
| #765 skipped question cards (fix in flight) | Adjacent to findings 3/6; no overlap in mechanism, no duplicate filed |
| #924 throttled host = busy-silent | Same root-cause family as finding 3; display precedence here, limits-provenance join stays in #924 (Sol) |
| #757, #754, #930, #691, #872, #628 | Checked; no audit finding duplicates them |

## What works — protected from re-litigation

Switchboard triage grouping (Waiting for you / Working / Recent); the card state vocabulary at working zoom in both schemes; held-delivery and rotation visibility exactly where the operator looks; dead-host recovery card copy (title says what happened, body says what happens to text sent now, three actions); launch-flow end-to-end coherence including the don't-send-again receipt; directory-picker keyboard support; composer focus discipline; the mobile bottom sheet's real focus trap; two-step Kill confirm; dark-scheme parity (pixel-verified). The #979 capture script deserves a call-out as a pattern: a capture that is simultaneously a live acceptance test (44px floor, keyboard budget, overflow gates) — extend that pattern (per finding 5) rather than building any separate audit harness.

## Deferred — not currently justified

- **New capture harness or fixture family.** Stage 1's verdict held through four stages: the existing two families cover everything except the named cells in T2/D4, each a one-line or one-small-script addition.
- **Tablet-specific layout redesign.** Finding 11 is a sizing-predicate swap; a dedicated tablet layout has no requirement behind it.
- **Assistive-technology conformance work.** Explicitly out of scope by operator direction; nothing here blocks doing it later.
- **Age-format capping ("26804d ago").** Fixture-clock artifact only; no operator sees it outside capture runs.
- **Provenance chase for stray `llv-issue-699` frames** found in the capture area with no producing script in the repo; stage 4's #699 verdict rests on source + the pinning DOM test, so the frames carry no weight.

## Handoff

This document feeds #703's next tranche. Suggested lane split: findings 1–3 (S1) as one design-heavy lane with Fable review; 4–11 as one implementation lane (they are independent, small, and share no files with the S1 lane except `Switchboard`); 12–18 as a batch copy/polish lane; T1 to Sol before any pipeline-surface work. Decisions D1–D4 gate their respective entries and nothing else.
