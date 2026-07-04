# Spec: agent questions UI — answer blocking agent prompts from the viewer

Target repo: `~/.agents/tools/live-log-viewer-next` (this repo). Next.js 16 App Router,
Tailwind v4, bun, TypeScript strict. Server runs on Linux only — `/proc` and a local
tmux server are available.

Read `AGENTS.md` first (Next.js version differs from training data; check
`node_modules/next/dist/docs/` when unsure about an API).

Do NOT commit. Keep named exports and the existing file layout conventions
(`src/lib/*` for server logic, `src/components/*` for UI, `src/app/api/*` for routes).

## Problem summary

Agents spawned by the viewer run as interactive CLIs inside tmux panes
(`src/lib/tmux.ts`). When such an agent blocks on an interactive prompt —
Claude Code's `AskUserQuestion`, a plan-mode approval, a Codex approval dialog —
the viewer shows nothing: the feed goes quiet and the agent waits forever unless
the user happens to attach to the pane. Today the only prompt handling is the
blind `Enter` auto-answer for trust-folder and resume-picker screens inside
`spawnAgentWithPrompt` (`src/lib/tmux.ts`).

This spec covers the full lifecycle: **detect** a blocked agent, **surface** the
question in the UI (desktop and phone), let the user **answer** from the viewer,
and **notify** the user when the viewer is not open.

Out of scope (handled by separate work): orchestration of implement→review
loops, spawning reviewers, round tracking. This feature must not assume any
loop context — it applies to every live agent session the scanner already
tracks.

## Decisions log (agreed with the user, 2026-07-04)

1. **Two-channel scheme**: a structured transcript-driven channel renders native
   answer cards for Claude agents; a screen-scrape fallback marks everything
   else (Codex, unrecognized prompts) as "waiting for input".
2. **Card scope**: `AskUserQuestion` and `ExitPlanMode` (plan approval) only.
   Permission dialogs are irrelevant — the viewer spawns Claude with
   `--dangerously-skip-permissions`. Trust/permission cards are deferred.
3. **Delivery**: verify→send→confirm. Keystrokes are never fired blind; the
   answer is confirmed against the transcript, and a stale card collapses into
   the answer that actually happened.
4. **Notifications**: in-app (title badge, banner, existing chime) plus Web
   Push via a service worker for closed-tab/phone delivery. Web Push requires a
   secure context — HTTPS via `tailscale serve` is the documented prerequisite.
5. Questions are treated as **exceptions, not workflow**: one-shot agents
   (`codex exec`, `claude -p`) cannot ask; only long-lived interactive agents
   produce these cards.

## Feature 1 — pending-question detection, transcript channel (server)

New module `src/lib/scanner/questions.ts`.

A Claude session (`claude-projects` root, JSONL transcript) is **blocked on a
question** when all of these hold:

- The session's process is alive (`FileEntry.proc === "running"`, reuse the
  existing pid machinery from `src/lib/scanner/process.ts` /
  `assignTranscriptPids`).
- The last assistant message in the transcript contains a `tool_use` block with
  `name` of `AskUserQuestion` or `ExitPlanMode`.
- No later record carries the matching `tool_result` for that `tool_use` id.

Parse from the `tool_use.input`:

- `AskUserQuestion`: the `questions` array — each item has `question`, `header`,
  `multiSelect`, `options[{label, description}]`. The "(Recommended)" suffix on
  a label is a plain-text convention; strip it for display and set a
  `recommended` flag on that option.
- `ExitPlanMode`: the `plan` markdown string.

Expose a `PendingQuestion` record:

```
{
  kind: "question" | "plan",
  toolUseId: string,
  transcriptPath: string,
  pid: number,
  askedAt: string,           // timestamp of the tool_use record
  questions?: [...],         // AskUserQuestion payload, normalized
  plan?: string,             // ExitPlanMode markdown
}
```

Detection runs inside the existing scan pipeline (`src/lib/scanner/index.ts`)
so it costs one tail-read per live transcript, cached with the same TTL
discipline as the other scanners. Only the transcript **tail** is read — a
pending question is by definition at the end of the file.

`FileEntry` gains `pendingQuestion: PendingQuestion | null` (default `null`),
so `/api/files` and the existing `useFiles` polling deliver it to the UI with
no new transport.

## Feature 2 — waiting-input detection, scrape fallback (server)

For live agents that have a resolvable tmux pane (`resolveTarget(pid)`) but no
structured pending question, a lightweight pane probe decides between `busy`
and `waiting-input`:

- Capture the pane (`capture-pane -p`, machinery already in `src/lib/tmux.ts`).
- `waiting-input` when the screen has been byte-identical across two probes
  ≥ 15 s apart AND the visible tail matches a prompt-pattern bank. Start the
  bank with: Codex approval prompts (`Allow command?`, `y/n`,
  `Press enter to approve`), the trust-folder regex already defined as
  `TRUST_FOLDER_PROMPT`, and a generic `❯.*\d\.\s` numbered-menu shape.
- A screen matching `READY_MARKERS` (composer idle, nothing asked) is `idle`,
  not `waiting-input` — an idle composer is normal, not blocking.

Keep the pattern bank in one exported constant next to `READY_MARKERS` in
`src/lib/tmux.ts` so all TUI regexes live in one place; they are the fragile
part and will need updating together when the CLIs change.

Probing is on-demand and cheap: run it only for entries that are `running`,
have a pane, and whose transcript has been silent for ≥ 15 s. Result surfaces
as `FileEntry.waitingInput: boolean`.

## Feature 3 — UI cards (client)

Rendered by the feed (`src/components/LogFeed.tsx` + a new
`src/components/feed/QuestionCard.tsx`), pinned as the last element of a live
session's feed while pending.

**Question card** (`kind: "question"`):

- Header chip (the tool's `header`), question text, options as tappable rows:
  label + description, recommended option visually first/highlighted.
- `multiSelect: true` → checkbox rows plus an explicit «Надіслати» button.
- Always an extra row «✎ Своя відповідь…» that opens the existing composer
  path (free text via `sendText`, which the TUI treats as the "Other" answer).
- Multi-question payloads (the tool allows up to 4 questions): render all
  questions in one card, but answers are delivered **sequentially** — the TUI
  walks questions one at a time, so the card submits question N, waits for the
  screen to advance, then submits N+1 (server-side, see Feature 4).

**Plan card** (`kind: "plan"`):

- Renders the plan markdown (reuse the feed's existing markdown rendering).
- Buttons: «✓ Затвердити» and «✕ Відхилити» with an optional comment field;
  a rejection comment is delivered as free text after the reject keystroke.

**Fallback state** (`waitingInput` without a structured question):

- The session card/header shows a `⏸ чекає на відповідь` badge with elapsed
  time and the captured screen tail (last ~3 lines, like `screenTail`), plus
  the composer for a free-text/keystroke reply and a hint naming the tmux pane.

**Card states**: `pending` → `delivering` (spinner, buttons disabled) →
`answered` (collapsed row: «Відповідено: <label>») / `superseded` (answered in
the terminal or another device — collapse into the actual answer read from the
transcript) / `failed` (delivery error + retry + composer fallback).

**Global visibility**: sessions with a pending question or `waitingInput` sort
to the top of their rail group and get the ⏸ badge in `ProjectRail` /
`Switchboard` cards, so a question is visible from the overview, not only
inside the session.

## Feature 4 — answer delivery, verify→send→confirm (server)

New route `src/app/api/answer/route.ts` (same-origin guarded like
`/api/tmux`). Request: `{ transcriptPath, toolUseId, kind, answers | approve |
text }`.

Pipeline per request:

1. **Verify pending**: re-scan the transcript tail; the `toolUseId` must still
   be pending. If a `tool_result` already exists → `409` with the actual
   answer (client renders `superseded`). No keystrokes are sent.
2. **Verify on screen**: `resolveTarget(pid)` → `capture-pane`; the question
   text (or plan-approval dialog) must be visible in the pane. Mismatch →
   `409 stale` (agent moved on, or user is mid-navigation in the pane).
3. **Send keys**: map the answer to keystrokes:
   - Single-select: the option's number key when the TUI shows numbered
     options; otherwise Down-arrow × (index) from the top + `Enter`. Re-capture
     the pane after navigation and before `Enter` to confirm the highlight is
     on the intended label — abort (no Enter) on mismatch.
   - Multi-select: arrow to each chosen option, `Space` to toggle, then
     `Enter`; same highlight verification per toggle.
   - Free text / "Other": existing `sendText`.
   - Plan approve/reject: number key or arrow+`Enter` on the corresponding
     dialog option; a rejection comment follows via `sendText` once the
     composer is back.
4. **Confirm**: poll the transcript (500 ms cadence, ≤ 10 s) for the matching
   `tool_result`. Found → `200` with the recorded answer. Timeout → `502
   delivery-unconfirmed`; the client shows `failed` with retry + composer.

Concurrency: a per-pane in-flight lock (same pattern as `resumeInFlight` in
`src/lib/tmux.ts`) serializes answer deliveries; a second request for an
already-answered `toolUseId` gets the `409` from step 1, so double-taps from
two devices are safe.

Security: the route only accepts transcripts the scanner already knows
(`knownLivePids` discipline) — an arbitrary path/pid from the request is never
trusted, same as `/api/tmux` today.

## Feature 5 — notifications

**In-app** (tab open):

- Title badge with the count of pending questions across all sessions
  (`(2) Agent Log Viewer`).
- A banner/toast on new pending question, deep-linking to the session.
- Chime through the existing `useAgentChimes` / `SoundToggle` machinery — add
  a distinct "question" chime respecting the current mute state.

**Web Push** (tab closed / phone):

- Service worker + Push API. VAPID keypair generated on first use and stored
  under `~/.claude/viewer-state/push-keys.json`; subscriptions stored in
  `~/.claude/viewer-state/push-subscriptions.json` (one per device).
- Opt-in UI: a bell toggle near `AccessQrButton` (phone onboarding flow
  already exists there); requesting permission explains the HTTPS requirement.
- Server sends one push per `toolUseId` (no repeats), payload: agent
  name/engine, question header or «план на затвердження», deep link
  `/{session}#question`. Sending happens from the scan pipeline the moment a
  new pending question is first observed.
- Documented prerequisite: Web Push needs a secure context, so phone delivery
  works when the viewer is served over HTTPS via `tailscale serve`; over plain
  HTTP the feature degrades silently to in-app only (no error spam).

`waitingInput` fallback states also notify, but with a 60 s debounce — screen
scraping has false positives and a stalled screen often resolves itself.

## Feature 6 — edge cases

- **No pane** (`resolveTarget` returns null — tmux restarted, pane closed):
  card renders read-only with the question and a «відкрити сесію» action that
  reuses the resume flow (`resumeSpecFor`); a resumed session re-asks or
  continues, and the stale card collapses once the transcript moves.
- **Answered in the terminal directly**: the scan pipeline sees the
  `tool_result`, `pendingQuestion` becomes null, the card collapses to
  `superseded` on the next poll. No user action needed.
- **Agent interrupted/killed while pending**: `proc` leaves `running` →
  pending question is dropped, card collapses with «агент завершився».
- **tmux server restart while delivering**: `resolveTarget` fails at step 2 →
  clean `409`, never stray keystrokes into a wrong pane.
- **Prompt UI drift after a CLI update**: step-3 highlight verification fails →
  `502` with the captured screen tail in the error, so the failure is visible
  and diagnosable instead of a silently wrong answer.

## Deferred (explicitly not in v1)

- Native cards for Codex structured prompts (needs a Codex-side protocol or
  much deeper TUI parsing).
- Permission/trust dialog cards (irrelevant while spawns use
  skip-permissions).
- Embedded interactive terminal (xterm.js/pty attach) as a universal fallback.
- Telegram notification channel.
