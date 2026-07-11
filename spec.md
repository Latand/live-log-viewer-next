# Issue #40 — in-UI multi-account switching

## Task statement

Provide one shared account panel for Claude and Codex that lists stored accounts,
shows authentication and quota state, supports direct active-account selection,
and exposes add-account and quick-login flows with clear operation progress.
Account selection updates the engine routing used by future launches while every
existing pane, conversation generation, transcript path, migration intent, and
held delivery retains its current ownership and content.

## Acceptance criteria

- AC1: The Accounts panel lists Claude and Codex accounts with labels,
  authentication state, active state, and available quota capacity.
- AC2: Selecting an authenticated account updates the engine routing and
  compatibility account catalog through the existing active-account endpoint.
- AC3: Account selection leaves conversation records, transcript files,
  migration intents, held deliveries, and running panes unchanged.
- AC4: Active-account endpoints reject legacy preview and transcript-migration
  selection modes.
- AC5: Future launches resolve the newly selected account through the shared
  account manager.
- AC6: Add-account and quick-login entry points remain available for both
  engines, including Codex device authorization and Claude browser/code login.
- AC7: Authentication, add, switch, login, removal, refresh, failure, retry, and
  empty/loading states remain visible and actionable in the panel.
- AC8: Account mutations are serialized, account selection is optimistic, and a
  failed selection restores the prior active account before offering retry.
- AC9: Signed-out accounts and accounts with an active login remain unavailable
  as launch targets in the UI and active-account endpoints.
- AC10: Quota polling records fresh per-account observations without changing
  engine routing or creating transcript-migration intents.
- AC11: English and Ukrainian account-panel copy describes direct routing and
  operation progress.
- AC12: Regression tests cover route-only selection for both engines and assert
  unchanged conversations, migration intents, held deliveries, and transcript
  ownership.
- AC13: A response lost after server commit reconciles as success, and a failed
  routing-registry write restores both durable active-account values.
- AC14: `bun test` passes.
- AC15: `bunx tsc --noEmit` completes without diagnostics.
- AC16: Verification uses unit and integration tests only; the live Viewer on
  port 8898 receives no account switch or login requests.
