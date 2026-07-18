# Composer model/reasoning pill — issue #390

Design for replacing the conversation composer's engine/effort controls (raw
`Fable` + «високі» selects, the «Застосувати» button, the «структурований»
badge) with one compact pill that opens a clean Codex-desktop-style popover,
where every selection applies automatically to the next message.

Grounded in current code on `main`:
`TmuxComposer.tsx`, `ComposerBar.tsx`, `AgentControlStrip.tsx`,
`AgentRuntimeControls.tsx`, `agentCapabilities.ts`, `useAgentCapabilities.ts`,
`src/lib/agent/models.ts`, `src/lib/agent/efforts.ts`,
`src/lib/runtime/{codexAppServerHost,claudeStreamBrokerHost,structuredDeliveryQueue,structuredControls}.ts`,
`src/hooks/useRuntime.ts`, `src/lib/i18n/{en,uk}.ts`, and the design system
(`docs/design/viewer-design-system.md` — tokens, §3.5 composer, §3.6 menu
labels, hierarchy rules).

Audience: the Opus implementer. Product-source file paths in §11 are the
authoritative change map. Scope is the **conversation pane composer**
(desktop + 390 px mobile). The pipeline stage placeholder
(`StagePlaceholderPane`) keeps `RuntimeControlsView` untouched — its
override-stage PATCH semantics are out of scope.

---

## 1. Current state (what the code confirms)

- The controls live in the **control strip above the composer**, not in the
  composer bar: `AgentControlStrip.runtimeSlotFor()` mounts
  `AgentRuntimeControls` (live tmux root), `ResumeRuntimeControls` (finished
  conversation), or `DisabledRuntimeControls` (structured host, Apply fenced
  with «структурований хост поки не підтримує цю дію»).
- Desktop renders two raw `<Select>`s + a 24 px Apply button with a four-state
  label (Apply / After turn / Next turn / Applied). Mobile renders a pill that
  opens a bottom sheet with model/effort chip grids, a fast checkbox, and a
  full-width Apply button (`AgentRuntimeControls.tsx:115–207`).
- The strip's `ModeChip` renders the «структурований» badge for the
  `structured` surface (`AgentControlStrip.tsx:82`).
- The capability matrix (`agentCapabilities.ts`) shows the `runtime` control on
  exactly three surfaces: `live-root` (enabled), `resume` (enabled),
  `structured` (disabled-with-reason). All three also render the composer, so
  the control can move into the composer bar without losing any surface.
- Effort scales are per engine+model (`effortScale`): claude
  `low…max`; codex `gpt-5.6-sol/terra` `low…ultra`; other codex `low…xhigh`.
  Tier display names come from `effortTier.*` i18n keys.
- The structured send path (`/api/runtime/send` → durable delivery queue →
  host `turn/start`) carries **no model/effort today**. The codex host already
  sends a host-fixed `effort` on `turn/start`
  (`codexAppServerHost.ts:572`); the claude broker fixes `--model`/`--effort`
  as CLI args at process boot (`claudeStreamBrokerHost.ts:574`). The
  structured `reconfigure` control answers 409
  (`structuredControls.ts:56`).
- The resume path already honors a persisted profile: `resumeProfileBody`
  reads `savedResumeProfile` (`llvAgentRuntime:<id>:resume`, only when
  explicitly applied — issue #241 finding 4) and rides it on the spawn POST.
- Codex `fast` maps to `serviceTier: "priority"` at the account layer
  (`codexAppServer.ts:318`) and is codex-only everywhere.

## 2. Options and trade-offs

### 2.1 How "auto-apply" reaches the agent (the load-bearing decision)

**Option A — settings ride the send (chosen).** The client persists the
selection per conversation; each structured send includes an optional
`runtime: { model?, effort?, fast? }` override. The durable send effect
snapshots it, so a replayed idempotency key re-delivers with *identical*
settings, and the host applies it at `turn/start`.

- - Matches the issue's contract literally: "the next message simply goes out
    as a structured request with the newly selected model/effort settings".
- - No new control-plane operation, no receipt lifecycle for a settings
    change; delivery behavior (idempotency, receipts, policies) is untouched.
- - No race: the settings a message was admitted with are the settings it is
    delivered with, across crashes and retries.
- − The send wire contract grows an optional field (see the decision record,
    §10).

**Option B — unfence the structured `reconfigure` control.** Selection
dispatches a control-plane reconfigure; the host mutates its profile between
turns.

- - Settings changes get their own durable receipts.
- − Requires a new host mutation path per engine *plus* UI receipt handling
    for a change the user never thinks of as an operation; a reconfigure
    racing a send can apply to the wrong message. Rejected for this issue;
    the 409 fence stays for `reconfigure` (nothing else consumes it in the
    conversation UI after this redesign).

**Live tmux root** keeps its existing `/api/tmux {action:"reconfigure"}`
lifecycle (pending → converging re-apply → confirm-by-observation) — only the
trigger changes from an Apply press to selection commit. **Resume** keeps pure
client persistence (`:resume` profile) — auto-apply *is* the save.

### 2.2 Model submenu presentation

Side-flyout (Codex desktop) vs in-place drill-down. Panes can be as narrow as
a 300 px scheme node and the popover anchors 8 px above a bottom-row pill, so
a side flyout needs collision flipping in two axes. **Chosen: in-place
drill-down** — the popover swaps to a Model panel with a back row; one
anchored surface, no collision math, identical keyboard model
(ArrowRight enter / ArrowLeft back). The mobile sheet has no submenu at all —
sections stack.

### 2.3 Tier naming

The issue enumerates Light / Medium / High / Extra High / Ultra (Codex
desktop's names). Existing `effortTier.*` keys ("low", "extra high", «низькі»)
are reused across builder/meter surfaces in *sentence-embedded* contexts, so
they are not renamed. **Chosen: new standalone display keys**
`reasoningTier.*` for menu rows (§8), mapping CLI tokens 1:1
(`low→Light/Легкі`, `medium→Medium/Середні`, `high→High/Високі`,
`xhigh→Extra High/Дуже високі`, `max→Max/Максимальні`,
`ultra→Ultra/Ультра`, `minimal→Minimal/Мінімальні`). Values submitted to
CLIs/APIs remain the CLI tokens.

---

## 3. Anatomy and layout

### 3.1 The pill (composer bottom row)

The pill moves **into the composer bar** — it becomes the `leftSlot` of
`ComposerBar`'s quiet bottom row (currently `null` for `TmuxComposer`), left
of the image picker. The strip's `runtimeSlot` is deleted, and the strip's
`ModeChip` no longer renders anything for the `structured` surface (the
«структурований» badge is removed; `live-subagent`/`resume`/`dead` chips
stay — they carry routing information).

```
Desktop (composer, part of the card — design §3.5):
┌─────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────┐ │
│ │ Напиши агенту…                        🎤  ▶ │ │
│ └─────────────────────────────────────────────┘ │
│ ⚡ 5.6-Sol · Light ▾                        🖼  │  ← pill in the quiet row
└─────────────────────────────────────────────────┘

Mobile 390 px: identical row; pill truncates at max-w-[52vw], 44 px hit area.
```

Face recipe: borderless quiet button (same recipe as the row's other
controls): `Zap` glyph 14 px `text-accent`, model **short label** ·
reasoning tier label, `ChevronDown` 12 px. `--text-label`/600
`text-secondary`; hover `--surface-sunken` + `text-primary`; radius
`--radius-control`. Visual height 28 px desktop; mobile inflates the hit area
to 44 px via padding/pseudo-element (design rule 8). No border, no pill-shaped
outline — rule: borders live on raised surfaces only.

Model **short labels** are a new `shortLabel` field on `AgentModelOption`:
Fable, Opus, Sonnet, Haiku, `5.6-Sol`, `5.6-Terra` (full labels stay in
menus and aria).

The face always shows the **effective next-message profile**: the user's
persisted selection where one exists, otherwise the observed/boot runtime,
otherwise engine defaults. With auto-apply there is no "unapplied draft" state
to flag — the face is simply the truth about the next message — so the
warning dot, the After turn/Next turn/Applied labels, and the pending-draft
copy are all deleted. The only asynchronous case (live tmux reconfigure
converging) shows a 12 px spinner replacing the chevron while
pending/confirming; failure paints the pill text `text-danger` and surfaces
the error through the composer's existing status line (assertive live
region).

### 3.2 The popover (desktop)

Anchored above the pill (`bottom-[calc(100%+6px)] left-0`), `--surface-raised`,
`--radius-surface`, `--shadow-2`, `w-[240px]`, `z-40` — the `SendMenu` recipe.

```
Root panel                          Model panel (drill-down)
┌───────────────────────────┐      ┌───────────────────────────┐
│ Reasoning                 │      │ ‹ Model                   │  ← back row
│   Light                   │      │   GPT-5.6-Sol           ✓ │
│   Medium                  │      │   GPT-5.6-Terra           │
│   High                  ✓ │      └───────────────────────────┘
│   Extra High              │
│   Ultra                   │      Speed panel (codex only)
│ ──────────────────────────│      ┌───────────────────────────┐
│ Model         5.6-Sol   › │      │ ‹ Speed                   │
│ Speed        Standard   › │      │   Standard              ✓ │
└───────────────────────────┘      │   Fast — priority tier    │
                                   └───────────────────────────┘
```

- Group label "Reasoning": §3.6 sentence-case recipe (`--text-label`/600
  `text-secondary`, no uppercase).
- Reasoning rows: the tiers of `effortScale(engine, effectiveModel)`, lowest
  first — the list is engine/model-accurate, so claude shows Light…Max and a
  non-sol codex model shows Light…Extra High; the issue's five-item list is
  the sol scale. Row: 28 px visual, label left, `Check` 14 px right on the
  active tier only.
- Divider, then two **submenu rows**: label left, current value
  (`text-muted`) + `ChevronRight` right. "Speed" renders only for
  `engine === "codex"` (Standard/Fast; Fast notes the priority service tier).
  There is **no Full access row** and nothing resembling it.
- No header, no Apply, no close button — Esc/outside click/selection close it.
- Only one popover/menu may be open per composer; opening it closes the send
  menu and vice versa.

### 3.3 The sheet (mobile)

Reuses the existing bottom-sheet recipe (fixed inset overlay `z-[70]`,
`bg-black/40`, `rounded-t-[16px] bg-card`, grab handle, safe-area bottom
padding, backdrop tap closes) with menu-row content instead of chip grids:

```
┌─────────────────────────────┐
│            ▬▬               │
│ Reasoning                   │
│   Light                     │   rows: min-h-11 (44 px), label left,
│   Medium                    │   check right on the active row
│   High                    ✓ │
│   Extra High                │
│   Ultra                     │
│ Model                       │
│   GPT-5.6-Sol             ✓ │
│   GPT-5.6-Terra             │
│ Speed              (codex)  │
│   Standard                ✓ │
│   Fast — priority tier      │
└─────────────────────────────┘
```

No Apply button (the old full-width Apply is deleted). Desktop popover
**closes on selection** (menu semantics, matching Codex desktop); the mobile
sheet **stays open** on selection so model + reasoning can be set in one
visit, and closes on handle-drag/backdrop/Esc.

---

## 4. Interaction contract

1. **Open**: click/tap or Enter/Space/ArrowDown on the pill opens the popover
   (desktop) or sheet (mobile). `aria-expanded` reflects state.
2. **Select a reasoning tier**: persists the profile, commits it to the
   surface adapter (§5), moves the check, announces via the polite live
   region, closes the popover (desktop). The selection is complete in one
   gesture — there is no Apply anywhere.
3. **Select a model**: same commitment. If the current effort is not in the
   new model's scale, it clamps to the nearest end of the new scale (via the
   `EFFORT_ORDER` ranking, matching `effortMeter`'s clamp) and the clamped
   tier is what persists and announces.
4. **Select a speed** (codex only): commits `fast: true|false` the same way.
5. **Persistence**: the profile is stored per conversation identity under
   `llvAgentRuntime:<conversationIdentity>:profile` as
   `{ model?, effort?, fast? }` — **only explicitly selected fields are
   written**. A synthesized display default is never persisted (preserves
   issue #241 finding 4: a display default must never become a silent
   override). The store follows the composer's identity-adoption rules
   (`adoptComposerState` analog: profile keys move with id rotation).
6. **Auto-apply**: committing a selection triggers the surface adapter (§5)
   immediately. The **next message** the user sends goes out with the new
   settings; a send already in flight is untouched (its settings were
   snapshotted at admission).
7. **Delivery behavior is preserved**: idempotency keys, receipts, the
   `interrupt-active` policy, retry/replay, held-migration semantics — all
   unchanged. A replayed key re-delivers with the settings snapshotted in the
   durable effect, never with the current selection.
8. **Close**: Esc, outside pointer-down, or (desktop) a selection. Focus
   returns to the pill. The popover unmounts; no state survives except the
   persisted profile.
9. **While recording/busy**: the pill stays enabled (a settings change during
   dictation or a busy send is legal and affects the next admission).
10. **One source of truth for the face**: after any commit the face re-renders
    from persisted-profile-else-observed, so the pill, the popover checks, and
    the sheet checks can never disagree.

## 5. Surface adapters (what "commit" does per surface)

| Surface | Commit action | Next-message guarantee |
| --- | --- | --- |
| `structured` (codex-app-server) | persist profile only | next `/api/runtime/send` carries `runtime: {model?, effort?, fast?}`; the durable send effect snapshots it; host applies on `turn/start`. A mid-turn steer (`turn/steer`) cannot change the active turn's settings — they apply from the next turn start (documented in aria copy, not surfaced as a state). |
| `structured` (claude-broker) | persist profile only | send admission compares the requested profile to the host's boot profile; on mismatch the delivery controller performs a **between-turns host succession** — release the broker, re-boot via the structured resume path with the new `--model`/`--effort`, deliver the message as the first prompt. If succession is deferred (phase 2, §11), affected rows render disabled-with-reason instead (§7) — never a silent no-op. |
| `live-root` (legacy tmux) | persist + POST `/api/tmux {action:"reconfigure", model, effort, fast}` immediately (the existing pending → re-apply → confirm-by-observation lifecycle, minus the button) | the pane process is reconfigured; spinner on the pill until confirmed |
| `resume` | persist to the `:resume` profile (what `savedResumeProfile` reads) | the next send's spawn body carries model/effort via the existing `resumeProfileBody` |

The capability matrix changes one cell: `structured.controls.runtime` flips
from `disabled("strip.structuredUnsupported")` to `enabled` — selection is
now meaningful there. Per-item constraints inside the popover come from the
session's negotiated capabilities (§7), not from the whole-control cell.

## 6. States

**Pill**: `default` (face = effective profile) · `open` (aria-expanded,
hover-surface held) · `applying` (live-tmux only: spinner replaces chevron;
`aria-busy`) · `error` (text-danger + error in the composer status line;
face reverts to observed runtime) · `disabled` (capability `disabled`:
reduced opacity, tooltip + aria-label carry the reason, popover does not
open) · `hidden` (capability `hidden` — surfaces per matrix; the composer row
then holds only the image picker).

**Rows**: `active` (check, `aria-checked="true"`) · `inactive` ·
`disabled-with-reason` (opacity-50, reason in `title` and appended to the
accessible name — e.g. a model the current host can't switch to, §7) ·
`focused` (2 px accent ring, `focus-visible` only) · hover
(`--surface-sunken`).

**Empty/degenerate**: an engine outside `claude|codex` renders no pill (as
today's `runtimeSlotFor`); an effort scale of length 1 still renders the
group (one checked row); an unknown observed model shows its raw id on the
face and an unchecked Model panel.

## 7. Capability and account constraints (fallbacks)

- **Engine catalogs**: Model panel lists `ENGINE_MODELS[engine]` only; Speed
  renders only for codex. Claude never shows Speed (capability that never
  applies is hidden — matrix rule).
- **Per-model reasoning scales**: the Reasoning group always reflects
  `effortScale(engine, effectiveModel)`; switching models re-derives the list
  and clamps the checked tier (§4.3).
- **Per-turn settings capability (structured)**: the session contract grows a
  negotiated `runtimeSettings` capability (mirroring `imageInput`):
  `{ perTurnEffort: boolean, perTurnModel: boolean }`. codex-app-server
  advertises per-turn effort (already carried on `turn/start`) and per-turn
  model once verified against the protocol; claude-broker advertises both
  only when succession (§5) ships. A false capability renders the affected
  rows disabled with the reason «composer.settingsNextResume» — the tier the
  host *can* honor stays enabled. Temporarily unavailable ⇒ disabled with
  reason, never hidden (matrix rule).
- **Account/service tier**: Fast maps to the codex priority service tier at
  the account layer; if the account rejects priority the send fails with the
  server's error through the existing receipt path — the popover does not
  pre-guess entitlement (no entitlement signal exists client-side today).
- **Image capability across model switches**: switching to a model without
  image input (`codexModelSupportsImages`) while images are attached does not
  block the selection; the composer's existing negotiated-capability gate
  (`structuredImagesDisabled` / pre-flight rejection) reports it on send,
  and the model row carries a quiet `title` note naming the limitation.
- **Dead/unresolved/held**: pill hidden on `dead`/`unresolved` (matrix
  unchanged); during a migration hold the pill stays enabled — the persisted
  profile rides to the successor exactly like the draft does.
- **Legacy tmux with runtime plane off**: `live-root` adapter works unchanged
  (it never touches `/api/runtime/*`).

## 8. Copy (EN / UK)

New keys:

| key | EN | UK |
| --- | --- | --- |
| `composer.runtimePill` | Model and reasoning — applies to your next message | Модель і міркування — застосується до наступного повідомлення |
| `composer.reasoningGroup` | Reasoning | Міркування |
| `composer.modelGroup` | Model | Модель |
| `composer.speedGroup` | Speed | Швидкість |
| `composer.speedStandard` | Standard | Стандартна |
| `composer.speedFastTier` | Fast — priority tier | Швидка — пріоритетний тариф |
| `composer.backTo` | Back | Назад |
| `composer.nextMessageUses` | Next message: {model} · {effort} | Наступне повідомлення: {model} · {effort} |
| `composer.settingsNextResume` | applies when the conversation is next resumed | застосується під час наступного відновлення розмови |
| `reasoningTier.minimal` | Minimal | Мінімальні |
| `reasoningTier.low` | Light | Легкі |
| `reasoningTier.medium` | Medium | Середні |
| `reasoningTier.high` | High | Високі |
| `reasoningTier.xhigh` | Extra High | Дуже високі |
| `reasoningTier.max` | Max | Максимальні |
| `reasoningTier.ultra` | Ultra | Ультра |

Removed (verify zero remaining references before deleting):
`composer.structured` (the badge label — `sendStructuredAria` etc. stay),
`runtimeConfig.pending`, `runtimeConfig.confirming`, `runtimeConfig.applied`,
`runtimeConfig.pendingDraft`, `runtimeConfig.openSheet`. Kept (still used by
`StagePlaceholderPane` / errors): `runtimeConfig.apply`,
`runtimeConfig.model`, `runtimeConfig.effort`, `runtimeConfig.speedTitle`,
`runtimeConfig.failed`, all `effortTier.*`, `draft.*`.

`composer.nextMessageUses` is the polite live-region announcement after a
commit; `composer.runtimePill` is the pill's accessible name prefix, followed
by the current face value ("… — GPT-5.6-Sol, Light").

## 9. Accessibility

- **Pill**: `<button type="button" aria-haspopup="menu" aria-expanded>` with
  the composed label above; `aria-busy` while applying; when capability-
  disabled, `aria-disabled` + reason appended to the label (strip convention).
- **Popover**: `role="menu"`, groups as `role="group"` with
  `aria-labelledby` pointing at the §3.6 group label; tier/model/speed rows
  `role="menuitemradio"` + `aria-checked`; submenu rows `role="menuitem"`
  `aria-haspopup="menu"`.
- **Keyboard**: ArrowDown/ArrowUp cycle rows (wrapping), Home/End jump,
  Enter/Space select, ArrowRight opens a submenu row's panel (focus lands on
  the checked row), ArrowLeft or the back row returns to the root panel
  (focus restored to the submenu row), Esc closes and refocuses the pill.
  First focus on open: the checked reasoning row. Tab is trapped inside
  while open (menu semantics — Tab closes and moves on, per WAI-APG menu
  pattern).
- **Sheet (mobile)**: `role="dialog"` `aria-modal="true"` labeled by
  `composer.runtimePill`; sections as `role="radiogroup"` with radio rows;
  44 px targets; focus moves into the sheet on open and back to the pill on
  close; background scroll locked.
- **Announcements**: each commit updates a polite `role="status"` region with
  `composer.nextMessageUses`; live-tmux apply errors use the composer's
  existing assertive status line.
- **Never color alone**: the active row carries the check glyph +
  `aria-checked`; the applying state carries a spinner + `aria-busy`; the
  error state carries text in the status line.
- **Motion**: popover/sheet use `--motion-base`/`--motion-slow` with
  `--ease-standard`; all transitions disabled under
  `prefers-reduced-motion` (`motion-reduce:` variants, as the codebase
  already does).
- Both palettes (light/dark tokens are live in `tokens.css`) must pass
  contrast on `--surface-raised`: row text `text-primary`, group labels
  `text-secondary` — both ≥4.5:1 by token definition.

## 10. Decision record — settings ride the send

*Status: decided here; hard to reverse once shipped (wire + durable format).*
The `/api/runtime/send` body and the durable structured send effect gain an
optional `runtime: { model?: string, effort?: string, fast?: boolean }`,
validated by the existing `modelFromBody`/`reasoningFromBody` bounds.
Consequences: (a) replays are settings-faithful by construction; (b) the
journal/effect format change must be forward-compatible (absent field =
today's behavior) so a rollback reads old records untouched; (c) hosts
receive settings as part of the delivery entry, keeping `reconfigure` fenced.
Alternative (control-plane reconfigure) rejected — see §2.1.

## 11. Implementation map (file-level)

**Client — new**
- `src/components/RuntimePill.tsx` — pill + popover + sheet + the four
  surface adapters (§5); owns the `:profile` store, clamping, and
  announcements. DOM tests: `RuntimePill.dom.test.tsx` (menu roles, keyboard
  contract, clamp-on-model-switch, per-capability disabled rows, sheet
  behavior at 390 px).
- `src/components/runtimeProfile.ts` — extract `defaults`, `readDraft`,
  `savedResumeProfile`, `resumeKey`, storage-key helpers out of
  `AgentRuntimeControls.tsx` so the pill, `TmuxComposer.resumeProfileBody`,
  and the stage pane share one profile module; add the `:profile` read/write
  with identity adoption.

**Client — changed**
- `src/lib/agent/models.ts` — add `shortLabel` to `AgentModelOption`.
- `src/components/TmuxComposer.tsx` — mount `<RuntimePill file={file}/>` as
  `ComposerBar` `leftSlot` (gated on `caps.controls.runtime`); structured
  `send()` passes the persisted profile as `SendOptions.runtime`.
- `src/components/AgentControlStrip.tsx` — delete `runtimeSlotFor` and the
  `runtimeSlot` prop; `ModeChip` returns null for the `structured` surface.
- `src/components/AgentRuntimeControls.tsx` — delete `AgentRuntimeControls`,
  `ResumeRuntimeControls`, `DisabledRuntimeControls` (superseded by the
  pill); keep `RuntimeControlsView` + `RuntimeDraft`/`RuntimeApplyState` for
  `StagePlaceholderPane`, importing the profile module.
- `src/components/agentCapabilities.ts` — `structured.controls.runtime` →
  `ENABLED`; matrix tests updated.
- `src/hooks/useRuntime.ts` — `SendOptions.runtime`, passed through
  `sendRuntimeMessage`.
- `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` — §8 keys.

**Server / runtime plane**
- `src/lib/runtime/http.ts` (+ `commands.ts`) — accept and validate the
  optional `runtime` field on `send` (reuse `modelFromBody`,
  `isEngineEffort`; reject out-of-catalog values with a 4xx).
- `src/lib/runtime/structuredDeliveryQueue.ts` /
  `structuredMessageDelivery.ts` — carry the runtime snapshot on the send
  effect and the queue entry (forward-compatible: absent = today).
- `src/lib/runtime/codexAppServerHost.ts` — apply per-turn
  `effort`/`model` from the entry on `turn/start` (verify the app-server
  protocol accepts per-turn `model`; if not, advertise
  `runtimeSettings.perTurnModel: false`); advertise the new
  `runtimeSettings` capability in `contracts.ts`.
- `src/lib/runtime/claudeStreamBrokerHost.ts` + `structuredSpawn.ts` —
  phase 2: between-turns succession on profile mismatch (§5). Phase 1 ships
  with `runtimeSettings: { perTurnEffort: false, perTurnModel: false }` for
  claude-broker and the disabled-with-reason rows.
- `src/lib/runtime/contracts.ts` — `runtimeSettings` session capability.

**Tests to update**: `AgentControlStrip.dom.test.tsx` (no runtime slot, no
structured badge), `TmuxComposer.dom.test.tsx` (leftSlot pill, runtime on
send), `agentCapabilities.test`, host tests for per-turn settings, delivery
queue snapshot round-trip, `StagePlaceholderPane.dom.test.tsx` (unchanged —
guards the kept `RuntimeControlsView`).

**Sequencing**: 1) profile module + pill UI replacing the three conversation
controls (client-only; structured commits persist but only resume/live-tmux
actuate) → 2) send-carried settings for codex-app-server → 3) claude-broker
succession. Each step is independently shippable; the pill is honest at every
step via the capability rows.

## 12. Visual acceptance (required before merge)

Screenshots at desktop 1440 and mobile 390, EN and UK, light and dark:

1. Composer bottom row with the pill at rest (codex `⚡ 5.6-Sol · Light ▾`
   and claude `⚡ Fable · High ▾`), showing the strip **without** the
   structured badge and **without** selects/Apply anywhere.
2. Popover open — Reasoning group with check on the active tier (a sol
   conversation showing all six tiers).
3. Model panel (drill-down) with back row and checked model.
4. Speed panel on a codex conversation; absence of the Speed row on claude.
5. Claude-broker conversation with per-turn-model disabled rows showing the
   disabled-with-reason treatment (phase 1).
6. Mobile 390 sheet with the three stacked sections, 44 px rows, safe-area
   padding.
7. Live-tmux applying state (spinner on the pill) and an error state with the
   status line.
8. Before/after pair of the old strip controls vs the new row (the
   review-facing "clutter is gone" shot).

Acceptance walkthrough: select Ultra in the popover, send a message, and
verify the receipt/transcript shows the turn ran at ultra with no Apply step;
refresh the page and confirm the pill face still reads the selection.

## 13. Anti-goals

- No Full access control or anything shaped like one.
- No change to send policies, idempotency, receipts, migration holds, or the
  send menu (quick-ack).
- No changes to `StagePlaceholderPane`'s override-stage controls or the
  builder/draft `ReasoningControls` (launch surfaces keep their selects).
- No new dependencies; popover/sheet are hand-rolled like `SendMenu` and the
  existing sheet.
