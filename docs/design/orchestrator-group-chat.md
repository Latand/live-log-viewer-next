# Orchestrator Group Chat — UX/UI design (issues #338 + #182 phase-2 retarget)

Design date 2026-07-17, grounded in worktree base `6fa8f12d` (production
reality). This spec covers the **group chat room** that the #182 phase-2 pill +
overlay now opens (owner retarget comment on #182, 2026-07-17) under the #338
**Interaction contract**, which is law here:

1. **Mention = launch.** Tagging `@member` wakes/launches it; untagged messages
   wake nobody.
2. **Plan-first message (mandatory)** on wake: acknowledgment + short plan.
3. **No feed mirroring.** Chat carries only plan / decision questions /
   completion; the working feed stays on the conversation card, linked.
4. **Completion summary (mandatory).** Silent finish is a violation the viewer
   surfaces ("finished without report").
5. **Re-mention while running = injection** into the live conversation through
   the standard structured delivery path (queue, receipts, ownership).
6. **Stop control** from chat (same `{"action":"interrupt"}` / kill semantics
   as the conversation card).

Surviving unchanged from the #182 phase-2 grill-me design: pill placement and
state set, spawn resilience (timeout → error → Retry; a perpetual spinner must
be impossible by construction), autonomy tiers + per-project opt-in, window
controls (Stop / Pause autonomy / Reset), hidden board presence + "spawned by
Orchestrator" child badges, role-registry identity, `#222` as the ordering
blocker, and removal of the phase-1 `OrchestratorChatButton` in the same PR
that ships the pill.

Related state inputs honored throughout: #97 (rate-limited engines must be
visible — feeds member presence semantics), #268 (live elapsed-time working
indicator — feeds the member "working" state), #336 (live runtime streaming —
feeds instant link-out and instant plan-message rendering), #272 (focus
stealing — codified as an anti-pattern in §5), #189 (draft-only pipelines).

---

## 1. Room anatomy

### 1.1 The pill

**Placement.** Rendered once at the Viewer root (`src/components/Viewer.tsx`,
alongside `ConnectionPill` / `DeploymentStatusPill`), `position: fixed`,
bottom-right: `right-4 bottom-4` on desktop, and on the phone `right-3`,
bottom offset = `MobileBottomShelf` height + `env(safe-area-inset-bottom)` +
12px, so it floats above the shelf/composer, never behind it. z-index above
page content, below modal sheets. It exists on **every** screen — overview,
any project, any view. `CornerStatus` (absolute inside the feed pane) stays
where it is; the pill is a viewport-level element and the two never share a
stacking context. `ConnectionPill` keeps bottom-left.

**Shape.** A 44×44 circular button (44px = mobile tap minimum, same on
desktop for consistency) carrying the **orchestrator avatar** (§1.4). When
members are active, a compact count chip (`+3`) docks on the pill's left
shoulder. The pill grows into the overlay with a scale+fade transform
originating at its own center (`motion-reduce`: plain fade).

**Five states** (exactly the #182 set, with precedence top → bottom; one state
renders at a time, the highest active wins):

| State | Trigger | Visual |
| --- | --- | --- |
| **Gray (dead)** | Orchestrator session dead (record exists, transcript/process gone) | Desaturated avatar, gray ring, small ⟳ glyph. Tap opens the overlay with the respawn banner (§3.6) — history stays readable. |
| **Red (decision)** | Any member has an unanswered decision-point question; a pipeline draft awaits Start; a "finished without report" violation is unacknowledged | Solid `danger` ring + red badge with count of pending decisions. Steady, not blinking. |
| **Unread** | Chat messages arrived while the overlay was closed | `accent` badge with unread count (top-right shoulder). |
| **Pulsing (working)** | ≥1 member (incl. orchestrator) currently working | Soft `success` pulse ring (2s cycle; `motion-reduce:` static ring). |
| **Calm** | Otherwise | Neutral `border` ring, plain avatar. |

Unread semantics (resolving the #182 open question): **opening the overlay
marks read** — the client persists `lastReadSeq` per device
(`localStorage["llvChatRead:<roomId>"]`); unread = messages with `seq >
lastReadSeq`, system events excluded (they never count toward the badge).
Red and gray are *not* cleared by opening — they clear only when the
underlying condition resolves (question answered, draft started/dismissed,
violation acknowledged, orchestrator respawned).

The pill is a `button` with a live `aria-label`:
`"Orchestrator chat — 2 unread, 1 decision waiting, 3 agents working"` (en+uk).

### 1.2 The overlay window

Tapping the pill expands the **group chat room**:

- **Desktop:** a floating panel anchored bottom-right, 420px wide,
  `min(640px, 100vh - 96px)` tall, `rounded-2xl`, distinct chrome: 1px
  `accent/40` border + a slightly raised surface (`bg-card` with `shadow-1`)
  so it reads as "the Orchestrator", per #182 §1. Behind it the app gets a
  light dim (`bg-primary/20`) + `backdrop-blur-[2px]`; clicking the dim or
  pressing Esc collapses the window back into the pill. The session and the
  room keep running in the background.
- **Mobile:** a full-screen sheet sliding up from the pill (no floating
  window on a phone). Same dim rule is moot (sheet covers the app); the
  sheet's header carries the close (▾) control.
- **Expand affordance** in the header (⤢) opens the *room* full-page via the
  hash deep link `#chat` (a sibling to `#c=` in `parseConversationHash` —
  new recognized form; `#chat` alone means the one orchestrator room, future
  multi-room uses `#chat=<roomId>`). Full-page is the same `ChatRoomView`
  component filling the main column.

**Layout, top to bottom:**

1. **Header row:** orchestrator avatar + "Orchestrator" title + presence dot;
   right side: overflow menu (⋯ → Pause autonomy, Reset — the #182 §6
   controls; Stop for the orchestrator's own turn appears while it works),
   expand (⤢), close (✕).
2. **Member strip** (§1.3).
3. **Message list** — the room transcript (§2), newest at bottom,
   scroll-anchored to bottom with a "↓ new messages" jump chip when scrolled
   up (reuse the `scrollMemory` pattern from the feed).
4. **Composer** — single-line growing textarea with `@`-mention autocomplete
   (§2.6), mic (`MicButton`) and image attach (`ImagePickerButton`) reused,
   send button. Receipts render on the sent message, not under the composer
   (§2.5).

### 1.3 Member strip and presence

A horizontal row of member avatars under the header, ordered: orchestrator
first, then active members by recency, then idle, then dead. Overflow folds
into a `+N` chip that opens the full member list as a popover (desktop) /
sheet (mobile).

Each avatar carries a **presence dot** (bottom-right of the avatar, 10px,
1.5px `card` ring for contrast):

| Presence | Source | Dot |
| --- | --- | --- |
| **Working** | runtime turn active (`activity === "live"`) | `success`, pulsing (`motion-reduce`: solid). The member popover and any plan message header show the **live elapsed timer** per #268: `working · 4:32`, ticking. |
| **Idle** | session alive, no active turn | hollow `success` outline dot |
| **Needs decision** | unanswered question from this member | `danger` dot + the avatar gets a subtle red ring |
| **Blocked / rate-limited** | #97 detection (usage-limit banner or structured rate-limit read) | `warning` dot; popover shows "rate-limited until 19:55" and the reseat affordance once #97 ships it. Never rendered as "working". |
| **Dead** | process/pane gone, transcript stale | gray dot, desaturated avatar. Tap → respawn (§3.6). |

Tapping an avatar opens the **member popover**: avatar large, name
("Sol · 2"), template + engine/model/effort line (reuse `engineBadgeFor`
tinting), presence with elapsed time, and actions: **Open conversation**
(link-out §4), **Stop** (working members), **Respawn** (dead members),
**Mute** (per-member hard mute, #338 guard — muted members can be mentioned
but their posts collapse to a one-line "muted message" stub until unmuted).

### 1.4 Avatar system

Deterministic, generated, no image assets — same philosophy as
`ENGINE_COLORS`/`tintOf` in `src/components/utils.ts` (one saturated identity
color, translucent soft derived from it, works on both themes).

**Layer 1 — template identity** (who kind of agent this is). Each template
gets a fixed hue + a monogram glyph:

| Template | Base | Hue (identity color) | Glyph |
| --- | --- | --- | --- |
| Sol | GPT-5.6-Sol (review) | Codex blue family, `#2f6fd0` | S |
| Terra | GPT-5.6-Terra (implement) | Codex teal shift, `#2f9fd0` → distinct teal | T |
| Opus | Claude Opus | Claude orange family `#d97757` | O |
| Fable | Claude Fable | Claude deep amber shift | F |
| Sonnet | Claude Sonnet | Claude light coral shift | So |

(The exact shifted hex values reuse the model-family hue-shift table already
in `utils.ts` — one source of truth; new templates from the role registry get
a hue by hashing the template id into the free hue range.)

Avatar = circle filled with a two-stop gradient of the identity color
(color → 20% darkened), the monogram in white, weight 700. The
**orchestrator** is the Fable avatar with a 1.5px `crown`-token ring — it is
visually a member, first among equals.

**Layer 2 — per-instance variant** (which Sol this is). `hash(conversationId)
mod 8` selects one of 8 variants: gradient angle (0/45/90/135°) × a small
corner notch position (top-left / bottom-right). Additionally every instance
gets an ordinal within the room — "Sol · 2" — shown in names and tooltips;
the ordinal is assigned at launch and never reused within a room. Two Sols
are therefore tellable apart by both variant and ordinal.

**The user** renders with a neutral `accent`-soft circle and their initial
(from the account badge identity); user messages are also right-aligned, so
the avatar is redundant there and rendered only in the member strip.

Sizes: 28px in message gutters, 24px member strip, 16px inline mention chips
and receipts. All sizes carry `aria-hidden` glyphs with the name in text.

---

## 2. Message taxonomy + visual language

All chat bubbles use the feed's `markdown.tsx` renderer. Six kinds:

### 2.1 User message
Right-aligned bubble, `accent-soft` background, `rounded-[12px]` with a
flattened bottom-right corner. Mentions render inline as **mention chips**:
16px avatar + name, `soft` tint of the member's identity color. Below the
bubble: one `ReceiptChip` **per mentioned member** (§2.5) — a message tagging
two agents shows two delivery receipts.

### 2.2 Agent plan-first message (contract §2)
Left-aligned card: 28px avatar in the gutter, member name + "started
working" label + timestamp header; body = the plan (markdown, clamped to ~12
lines with "show more"); footer = **Open conversation →** link (§4). A 2px
left border in the member's identity color ties the card to the avatar. While
the member works, the card footer shows the live `working · m:ss` counter
(#268 semantics: from prompt receipt to last agent event; frozen when the
turn ends).

### 2.3 Decision-point question
The red tier. Same card chrome as 2.2 but `danger/25` border + `danger-soft`
header strip "needs your decision". Body reuses the **`QuestionCard`
interaction model** (options as buttons, multi-select, free-text "other",
comment field) adapted to chat width. Answering delivers the answer into the
member's live conversation via structured delivery and renders the outcome
inline ("answered: Option B" collapsed state, exactly QuestionCard's
answered/superseded/failed states). An unanswered question sets the red pill
state and the member's red presence.

### 2.4 Completion summary (contract §4)
Same card chrome, `success/25` border, header "finished · 12:34" (frozen
elapsed), body = the summary markdown, footer = Open conversation → plus any
artifact chips the agent reported (draft id → links to the pipeline draft on
the board — **never** a Start button in chat, per the #189 draft-only
contract; PR/issue links).

### 2.5 Receipts
Reuse `ReceiptChip` + the journaled receipt model verbatim
(`runtime/runtimeModel.ts`, merge semantics from `TmuxComposer`):
`queued (№k)` → `delivered` / `rejected` / `failed`, with **Retry (same
idempotency key — never a double send)** and **Edit (new key)** on failures.
A mention that *launches* shows the launch lifecycle instead: `launching…` →
`plan received` (terminal ok) or `launch failed → Retry` (§3.2). Receipts are
per-message, inline, and survive reload (journal-backed).

### 2.6 System events
Centered, small (`text-[11px] text-muted`), no bubble, no avatar, grouped by
minute:

- `— Sol · 2 launched by @you —`
- `— Sol · 2 stopped by you —`
- `— Terra · 1 rate-limited until 19:55 —` (`warning` tint, #97)
- `— Sol · 2 died —` (gray; followed by the respawn affordance on the member)
- `⚠ Sol · 2 finished without report` — the **contract-violation marker**
  (`warning-soft` background strip, not centered-muted: it must be seen).
  Carries two affordances: *Open conversation* and *Request summary* (injects
  a canned "post your completion summary to the chat" message through the
  standard delivery path). Unacknowledged violations contribute to the red
  pill state; tapping either affordance acknowledges.
- Event-relay digests (#182 §4) post as one system line per batch:
  `— relay: flow #12 verdict APPROVE · lane idle 18m —`.

System events are excluded from unread counts and from `aria-live`
announcements except violations (polite) and failures (assertive).

### 2.7 Mention / autocomplete UX

Typing `@` (or tapping an @-button in the composer on mobile) opens the
autocomplete popover anchored to the caret:

- **Section "In room"** — existing members: avatar, name+ordinal, presence
  dot, template label. Mentioning a live/idle member = wake or inject (§3.4).
  Mentioning a **dead** member offers `Respawn & deliver`.
- **Section "Launch new"** — templates from the role registry (#35:
  orchestrator excluded, reviewer/builder/architect/… included) with engine
  badge. Selecting one inserts a chip like `@Sol (new)`; sending launches a
  fresh member (§3.2).
- Bare-template disambiguation: typing `@sol` when Sol instances exist ranks
  the **most recently active live instance first**, then other instances,
  then "Sol (new)". The chip always resolves to a concrete target before
  send — a message never carries an ambiguous mention.
- Keyboard: ↑/↓ navigate, Enter/Tab accept, Esc closes (and does NOT close
  the overlay — Esc closes innermost layer first). Filtering is
  fuzzy-by-prefix over name, template, model.
- An untagged message posts to the room and wakes nobody (contract §1). The
  composer shows a one-time inline hint under the field when the first
  untagged message is sent: "No one is tagged — nobody will be woken."
  (dismissable, remembered per device).

---

## 3. Interaction flows

### 3.1 Master lifecycle (per member)

```
                 mention @Template(new)
                          │
                          ▼
                    ┌──────────┐  journal deadline (90s) /
                    │ LAUNCHING │  spawn error
                    │ starting → │ ─────────────────► ┌────────┐   Retry (same
                    │ binding →  │                    │ FAILED │◄─ profile, new
                    │ queued     │                    └───┬────┘   launch id)
                    └─────┬─────┘                         │ retry
                          │ 202 + conversationId          ▼
                          ▼                          (back to LAUNCHING)
                    ┌──────────┐  plan chat.post
                    │  WAKING   │ ───────────────► plan card rendered
                    └─────┬─────┘  (>3 min without plan → "working
                          │         without plan ⚠" soft marker)
                          ▼
                    ┌──────────┐ ◄── re-mention = injection (§3.4)
                    │ WORKING   │ ◄── decision question posted → RED
                    │ (elapsed  │
                    │  ticking) │ ─── stop (§3.5) ──► turn interrupted → IDLE
                    └─────┬─────┘
              turn end    │
        ┌─────────────────┴──────────────────┐
        │ completion chat.post seen           │ no chat.post this turn
        ▼                                     ▼
   completion card → IDLE            "finished without report ⚠"
                                      violation marker → IDLE (red until ack)

   IDLE ── process/pane dies ──► DEAD (gray) ── tap/mention → respawn → WAKING
```

### 3.2 Mention → launch (and why the perpetual spinner is impossible)

1. User sends `@Sol (new) review the auth diff`. The message posts
   optimistically with receipt `queued`.
2. The server launches through the structured spawn path (`/api/spawn`,
   202-fast per #336) and the member appears in the strip immediately in the
   **launching** state (spinner avatar placeholder with the template identity
   color).
3. Launch progress is **only ever derived from the journaled spawn state**
   (`StructuredSpawnCardState`: `starting | binding | queued | failed |
   recovered`) — the exact machinery `StructuredSpawnStatus` +
   `LaunchHistory` already render. No component holds a local "busy" boolean
   that a lost response could strand (the phase-1 `OrchestratorChatButton`
   bug). The supervisor stamps a **deadline** on every launch (90s, the
   existing `SPAWN_TTL_MS`); a launch that neither binds nor errors by the
   deadline is journaled `failed` + `retrySafe` *server-side*, so every
   client — including one that reloads mid-launch — renders the terminal
   failure. By construction there is no state that renders a spinner without
   a journal row that will terminate.
4. **Failure UI:** the launching avatar turns into a `danger` stub; a system
   line shows the exact error (`spawn.error` verbatim, like `LaunchHistory`)
   with **Retry** (relaunches the same profile; the original message is
   redelivered on success) and **Dismiss**.
5. Success: `conversationId` binds, the member gets its ordinal + avatar
   variant, receipt flips to `delivered`, and the room waits for the plan
   card (§2.2). Per #336, the plan message streams into the chat from the
   runtime host — it must not wait on the transcript scanner.

### 3.3 Plan → work → completion

Covered by §§2.2–2.4. Enforcement is **surfacing, not blocking**: the viewer
never suppresses a working agent for skipping a plan; it marks the contract
violation (soft "working without plan" after 3 min; hard "finished without
report" on turn end without a completion post) and makes the fix one tap
("Request summary").

Turn-end detection reuses the runtime turn state (the same signal #268's
timer freezes on). "Posted this turn" = any `chat.post` from that member
with a timestamp inside the turn window.

### 3.4 Re-mention while running (contract §5)

User tags a **working** member: the message is delivered INTO the live
conversation through `structuredDeliveryQueue` — identical to typing in that
pane's composer. **What the chat displays:** the user's message bubble with
that member's receipt chip advancing `queued (№2) → delivered`, plus a small
inline annotation on the delivered receipt: `delivered into live turn`. No
system line, no echo of the agent's feed — the agent's *response* to the
injection reaches the chat only as its next plan-amendment / question /
completion post. Queue position, rejection (`no-claim`, ownership), and
failure all render through the standard `ReceiptChip` states with
Retry/Edit.

### 3.5 Stop from chat (contract §6)

Two equivalent surfaces:
- **Member popover → Stop** (working members only): sends
  `{"action":"interrupt"}` through `structuredControls` — same as the
  conversation card. A long-press / overflow "Force kill" maps to `kill` for
  a wedged pane.
- **Chat command:** a message `/stop @Sol·2` (autocomplete assists after
  `/stop `). The command is a control, not a chat post — it renders as a
  pending system line with the control receipt, becoming
  `— Sol · 2 stopped by you —` on ack.

Stop never deletes anything: the member drops to **idle**, its conversation
card keeps the partial feed, and the room notes the interruption.

### 3.6 Dead member → tap-to-respawn

A dead member stays in the strip (gray) with history intact. Tap → popover →
**Respawn**: ownership-principle order — try to re-attach/resume the live
process; else `--resume` the transcript into a fresh pane (same semantics the
supervisor uses elsewhere). The respawned member **keeps its identity**
(name, ordinal, avatar variant); the room posts `— Sol · 2 respawned —`. If
the user *mentions* a dead member, the composer chip shows
`Respawn & deliver` and the flow is: respawn → deliver via the queue →
normal receipts. Respawn failures follow §3.2's journaled-failure UI.

The **orchestrator itself** dead = gray pill; opening the overlay shows a
respawn banner pinned above the message list ("Orchestrator is down —
[Respawn]") while history stays scrollable. Same journaled launch lifecycle;
the banner can never spin forever for the same reason §3.2 can't.

---

## 4. Link-out contract (chat → conversation card)

Every agent card footer, member popover, violation marker, and system line
that references a conversation links out the same way:

1. Target: the canonical deep link `#c=<conversationId>` — the hash router in
   `Viewer.tsx` already resolves, pins, and opens it (project switch
   included, archived-predecessor redirect included).
2. **The overlay collapses to the pill** on link-out (both desktop and
   mobile): one focus surface at a time; the pill retains unread/red state so
   the way back is one tap. The room's scroll position is preserved for the
   next open (per-device memory, same pattern as feed `scrollMemory`).
3. With #336 landed, a conversation launched from chat opens **instantly**
   (attach by `conversationId`, live stream, no scanner wait). Until #336
   lands, the link-out may hit the file-scanner delay for very fresh spawns —
   acceptable interim: the pane shows the existing `StructuredSpawnStatus`
   card, never a blank.
4. Links are real `<a href="#c=…">` elements (middle-click/new-tab works, and
   the full-page `#chat` view gets browser-back for free).

Board presence stays per #182 §7: the orchestrator conversation is filtered
off board and scheme; chat-launched members appear on the board as normal
conversations with the "spawned by Orchestrator" badge instead of a lineage
edge to a hidden parent.

---

## 5. Mobile layout + accessibility

**Mobile.**
- Pill floats above `MobileBottomShelf` (§1.1); the overlay is a full-screen
  sheet (§1.2). The member strip horizontally scrolls with snap; the member
  popover becomes a bottom sheet.
- All interactive targets ≥44px (`min-h-11`), matching every existing mobile
  affordance in the codebase. Composer is sticky above the keyboard with
  `env(safe-area-inset-bottom)` padding.
- The `@` autocomplete renders as a docked list above the composer (not a
  floating popover) so the keyboard never covers it.
- Swipe-down on the sheet header closes (same gesture grammar as
  `MobileFocusView` header swipes).

**Focus rules — #272 is the anti-pattern to design out:**
- Focus moves into the room (to the composer) **only on the explicit user
  open** (pill tap, `#chat` navigation). No `autoFocus` on any element that
  data refreshes can remount.
- Message list keys are stable message ids (`seq`), member strip keys are
  member ids — never array indices or paths that adoption churn rewrites, so
  polls/streams can never remount the focused composer.
- No `.focus()` in any effect fed by poll/stream data. Receipts updating,
  members reordering by activity, presence flips: `document.activeElement`
  and the caret must survive all of them (regression test mirrors the #272
  acceptance: focused composer + dispatched store updates → activeElement
  unchanged, draft intact).
- The overlay is a focus trap while open (Tab cycles inside); Esc order:
  autocomplete → member popover → overlay. Closing returns focus to the pill.

**Keyboard (desktop).**
- Global toggle: `c` (chat), guarded by the same "not while typing" check the
  `N`/`F` hotkeys use in `Viewer.tsx`; no modifier conflicts.
- In-room: Enter sends, Shift+Enter newline; ↑ in an empty composer edits
  nothing (no history editing in v1 — receipts' Edit covers failures); Tab
  order: composer → send → member strip (roving tabindex, arrow keys move
  between avatars) → header controls.

**Screen readers.**
- Message list is `role="log"` with `aria-live="polite"`; violations polite,
  delivery failures assertive (matching `ReceiptChip`'s existing behavior).
- Every avatar/dot pairs with text: presence is announced as words
  ("Sol 2, reviewer, working 4 minutes 32 seconds"), never color alone.
  Color is reinforcement throughout — state words always present (same rule
  `ReceiptChip` documents).
- The pill's `aria-label` enumerates its state (§1.1); the red/unread badges
  are text counts, not just dots.
- `prefers-reduced-motion`: no pulse, no expand animation, no dot pulsing.

---

## 6. Component inventory

**Reused as-is:**

| Existing | Role in chat |
| --- | --- |
| `runtime/ReceiptChip.tsx` + `runtimeModel.ts` | delivery/control receipts, Retry(same key)/Edit(new key) |
| `TmuxComposer`'s `mergeRuntimeReceipts` + idempotency minting | receipt journal merge for chat sends (extract into a shared module — see New) |
| `feed/markdown.tsx` | plan/summary/message bodies |
| `feed/QuestionCard.tsx` interaction model | decision-point cards (visual re-skin, same states) |
| `StructuredSpawnStatus` state machine + `launchHistoryModel` | launch lifecycle, terminal failures, retry-safe semantics |
| `MicButton`, `imageAttachments.ImagePickerButton`, `ComposerBar` scaffolding | chat composer |
| `ui/Badge`, `Hint`, `utils.ts` (`engineBadgeFor`, `tintOf`, hue tables, `fmtAge`) | chips, tints, avatar colors |
| `useIsMobile`, i18n (`useLocale`, en+uk), `scrollMemory` pattern | layout, copy, scroll anchoring |
| `structuredControls` (`interrupt`/`kill`), `structuredDeliveryQueue` | stop + injection paths (server, unchanged) |
| hash router in `Viewer.tsx` (`parseConversationHash`) | `#c=` link-out; extended for `#chat` |

**New components** (all under `src/components/chat/`):

| New | Purpose |
| --- | --- |
| `OrchestratorPill.tsx` | §1.1 pill, five states, replaces `OrchestratorChatButton` (deleted same PR) |
| `ChatOverlay.tsx` | desktop panel / mobile sheet shell, dim+blur, trap, expand |
| `ChatRoomView.tsx` | header + member strip + message list + composer (shared by overlay and `#chat` full page) |
| `MemberStrip.tsx`, `MemberAvatar.tsx`, `MemberPopover.tsx` | §1.3–1.4 |
| `chatAvatar.ts` | pure: template hue/glyph + instance variant hash + ordinals |
| `ChatMessage.tsx` (+ kind variants), `SystemEventLine.tsx`, `ViolationMarker.tsx` | §2 taxonomy |
| `MentionAutocomplete.tsx`, `mentionModel.ts` | §2.6 (pure model: sections, ranking, disambiguation — unit-testable) |
| `ChatComposer.tsx` | composer wiring mentions + receipts + `/stop` command |
| `chatModel.ts` | pure client model: unread counts, pill-state precedence, member lifecycle reduction from journal/inventory inputs (unit-testable, like `attention.ts`) |
| `useChatRoom.ts` | data hook: history + cursor stream (`chat.history`/SSE per #338), receipts join |

Server-side surface (out of UI scope, listed for the implementer's contract):
room + message store per #338 phase 2 (SQLite, #312), `chat.post/history`
with `clientMessageId` idempotency, mention routing through the delivery
queue, member registry joined with the #326 inventory for presence, and the
launch-deadline journaling of §3.2.

---

## 7. Implementation slices (ordered, each independently shippable)

Blocker ordering per #182: **#222 first** (launch-verification
false-negatives poison every spawn path, chat included).

**Slice 1 — Pill + overlay shell, orchestrator-only room.**
Pill at Viewer root (calm/pulsing/gray only), overlay/sheet opening a room
containing just the user + orchestrator; messages post to the orchestrator
via the existing delivery path; plan/completion render as plain agent
messages (no contract markers yet); `OrchestratorChatButton` removed; board
filter for the orchestrator conversation; journaled launch lifecycle with
deadline → failed → Retry.
*Accepted when:* pill visible on every screen incl. mobile; open/close by
tap, Esc, outside click; a killed orchestrator shows gray → tap respawns →
never an unterminated spinner (pull the network mid-launch: failure + Retry
appears ≤90s); header button gone; orchestrator absent from board/scheme.

**Slice 2 — Members, avatars, presence, link-out.**
Member model + avatar system + member strip + popover; presence from the
inventory (working/idle/dead; #268 elapsed in popover); Open-conversation
link-out with overlay collapse; "spawned by Orchestrator" badge on children.
*Accepted when:* two Sols are visually distinct (variant + ordinal); presence
dots track runtime state within one poll/stream tick; link-out lands on the
`#c=` pane and back-tap reopens the room at the same scroll.

**Slice 3 — Mention = launch + contract markers.**
`@` autocomplete (members + templates), template mention launches a member
(§3.2 lifecycle end-to-end), plan-first card, completion card,
finished-without-report + working-without-plan markers, unread badge +
`lastReadSeq`.
*Accepted when:* `@Sol (new) …` yields launching → plan card ≤ launch time +
first token (no scanner wait once #336 lands); killing the agent before its
summary produces the violation marker with working Request-summary; unread
count survives reload and clears on open.

**Slice 4 — Injection, stop, receipts.**
Re-mention of a working member delivers via the queue with full `ReceiptChip`
lifecycle + "delivered into live turn" annotation; Stop in popover +
`/stop @member` command; `Respawn & deliver` for dead-member mentions.
*Accepted when:* injecting during a long tool call shows queued(№)→delivered
without disturbing the pane; Stop interrupts within the same bounds as the
conversation-card control; retry of a failed injection never double-delivers
(same idempotency key asserted in a test).

**Slice 5 — Decision layer + red state + push.**
Decision-point question cards (QuestionCard re-skin), red pill precedence,
red member ring, pipeline-draft artifact chips (draft-only — link to board,
no Start in chat), push notifications on decision points only (#182 §5).
*Accepted when:* an agent question turns the pill red until answered;
answering from chat resolves the pane's pending question too (single source
of truth); a draft posted by the orchestrator is startable only from the
board.

**Slice 6 — Health states + polish.**
Rate-limited presence (#97) with "until HH:MM" and never-fake-working;
event-relay digest lines (#182 §4 wiring); Pause-autonomy + Reset controls in
the header menu; mobile a11y audit pass (focus regression test per #272,
reduced-motion, SR labels).
*Accepted when:* a rate-limited member shows `warning` presence while its
card shows the same; the #272-style regression test passes with chat mounted
and streaming; axe/manual SR pass on overlay + sheet.

Slices 1–2 deliver visible value without any new server chat store if the
room is initially backed by the orchestrator conversation transcript;
slice 3 onward requires the #338 phase-2 room store (SQLite #312). If #312
is not ready, slices 1–2 ship regardless; slice 3 waits.

---

## Open questions for the owner

1. **Red state in the global attention queue?** Proposed: chat decisions
   also enter `buildAttentionQueue` (top-right badge + toasts) so the
   existing "needs me" muscle memory covers chat. Alternative: pill-only.
2. **History depth in the overlay** — proposed: last 200 messages with
   load-earlier on scroll; retention itself is #322's call.
3. **Bare `@sol` default** when live instances exist — spec says "most
   recently active instance"; confirm, or prefer always-disambiguate.
4. **Plan-timeout threshold** for the soft "working without plan" marker —
   proposed 3 min.
5. **`c` hotkey** for toggling the room — confirm it's free in your muscle
   memory (N/F are taken; `c` currently unbound).
6. **Violation acknowledgment** — proposed: tapping either affordance on the
   marker clears red; should ignoring it also expire (e.g. 2h TTL like
   stalled attention)?
