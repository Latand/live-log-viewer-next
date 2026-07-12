# Issue #33 — User-set custom session titles

## Task statement

Let a user rename any Claude/Codex agent conversation from the viewer UI. The
custom name overrides the auto-derived prompt title everywhere it appears (pane
header, board cards, tree, browser tab, overview, rail tooltips, push/attention
labels), persists durably keyed by stable conversation identity (registry
identity — not the transcript path), survives restarts/resumes/archive-revive and
account-migration path changes, and propagates to the tmux window name where a
live pane exists. A clear/reset control returns to the auto-derived title. The
editing UX is inline and consistent with existing UI idioms.

Scope: main Claude and Codex sessions are renameable. Subagents, background
tasks, and workflow/task cards remain follow-ons.

## Design summary

- Overlay store `state/session-titles.json`: atomic write, per-key revision,
  capped. Key precedence: Viewer conversation id → session UUID (compat) →
  transcript path (bounded fallback). (`src/lib/session/titleStore.ts`)
- Applied as the final word on `FileEntry.title` in the files response, after
  the registry stamps `conversationId`; derived title kept on `autoTitle`,
  `titleRevision` carries the concurrency token.
  (`src/app/api/files/response.ts`)
- `PATCH /api/session/title`: validates an allowed session, title bounds, base
  revision; empty/null clears; mismatch → structured 409. Resolution + tmux
  propagation behind `@/lib/session/titleTarget`.
- tmux window rename via `renameTmuxWindowForPid` (best-effort).
- Inline rename affordance `SessionTitle` in the pane header (also backs board
  cards through `BranchPane`). English/Ukrainian parity.

## Acceptance criteria

- AC1: A user can rename a Claude or Codex session from the pane header (pencil,
  double-click, or F2) with an inline editor that preselects the current title.
- AC2: The custom title overrides the auto-derived title on every surface,
  because it is applied once to `FileEntry.title` in the files response.
- AC3: The override is persisted to `state/session-titles.json` and survives a
  restart (reload from disk yields the same title).
- AC4: The override is keyed by stable conversation identity — Viewer
  conversation id when known, session UUID as the compatibility key, transcript
  path only as a bounded fallback — so it survives archive/revive/move and
  account/compaction succession (successors adopt via the UUID/registry seam).
- AC5: `PATCH /api/session/title` sets a non-empty title and clears on
  empty/null (reset to auto); the derived title remains reachable via
  `autoTitle`.
- AC6: Concurrent edits are guarded by a per-key revision; a base-revision
  mismatch returns a structured 409 carrying the current server record, and the
  client adopts it and retries once.
- AC7: On a successful mutation with a live pid, the tmux window name is renamed
  to match; a missing pane / unvouched pid / tmux error is a silent no-op that
  never fails the durable rename.
- AC8: Editing semantics — Enter and blur save, Escape cancels, empty save and a
  Reset-to-auto control clear the override.
- AC9: Only Claude/Codex sessions are renameable; subagents/background tasks are
  not given the affordance.
- AC10: User-visible strings have English/Ukrainian parity; the editor exposes
  aria labels and a polite live region.
- AC11: DOM tests cover rename, persistence (optimistic display), reset, and
  409 adopt-and-retry; store/route/overlay/tmux-guard tests cover the backend.
- AC12: `bun test` and `bunx tsc --noEmit` pass.
