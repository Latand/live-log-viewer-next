# Issue #1018: Reconcile sidebar quota provenance

The sidebar limits strip must present one coherent quota observation for each account and window. The reported failure combined an account-check capacity chip with transcript-derived 5h/Week rows, producing contradictory remaining percentages inside one engine block and inside the Accounts panel. A provider `usage_limit_exceeded` rejection establishes active exhaustion through its reset even when a newer app-server quota probe reports available capacity.

The implementation must reconcile structured account checks and transcript observations per account and window, derive every compact summary from the selected rows, preserve stale-age disclosure, keep reset ETA rounding consistent, and retain the active-account ownership mask. Product changes stay inside the assigned limits surfaces and payload merge helpers. Deployment is outside this task.

## Acceptance criteria

AC1: For one account and quota window, ordinary conflicting observations select the newer observation using the full-precision window observation timestamp. Events within the same second retain their millisecond ordering. Every rendered consumer receives that selected value and per-window provenance, including after payload serialization and client parsing.

AC2: An active exhausted observation (`usedPercent >= 100` with an unknown or future reset) governs a conflicting available-capacity observation through its reset. After the reset, ordinary timestamp ordering resumes.

AC3: A newly observed `usage_limit_exceeded` transcript rejection immediately marks the governing window as 100% used and records the rejection time as that window's observation time. A standalone rejection can use the live or cached window shape when its preceding transcript quota event is outside the readable tail. If its preceding reset already passed before the rejection, the reset becomes unknown so the fresh rejection remains authoritative. Both the root and nested Codex rejection envelopes are accepted. The account-wide transcript scan selects rejection and quota observations globally by event timestamp across a bounded candidate index. Recent history keeps active long-running sessions discoverable across start-date directories.

AC4: The meter diagnosis is explicit: the Codex app-server probe reads `account/rateLimits/read`, whose response carries the same 10,080-minute weekly quota horizon and pro-lite tier as the Codex transcript rate-limit event. Credit balance events are a separate event family with no quota windows. The app-server quota observation can therefore conflict with the provider rejection for the same weekly meter.

AC5: Each engine header capacity chip is derived from the reconciled window rows. Its rounded percentage equals a percentage visible in the same engine block.

AC6: The Accounts panel derives each account chip from its own rendered window rows. When opened from the limits footer, the active account receives the footer's exact reconciled quota model, preventing the modal from reviving a conflicting account snapshot.

AC7: Any rendered quota observation older than the 20-minute freshness threshold has a visible `as of HH:MM` hint. Distinct stale window timestamps remain visible beside their own rows, and timestamp-less stale rows retain a visible last-known label. Cached payloads preserve their original `staleSince` time when `capturedAt` is unavailable. Per-window observation times survive server payload serialization and client account parsing. Presentation time advances after failed polls and while either Accounts panel entry path remains mounted; payload receipt time remains fixed, so stale thresholds and elapsed resets still take effect.

AC8: Reset ETA formatting uses one shared upward-rounding rule in the strip and modal for minute, hour, and day scales.

AC9: Invariant 19 remains intact for Claude and Codex: limits payload values render only when the payload account ID equals the active account ID. A payload for account B cannot override account A at the rendered merge seam.

AC10: Focused regression coverage proves newer-source selection, sub-second ordering, provider-exhaustion precedence, post-reset behavior through failed polls, direct rejection handling, bounded transcript discovery, chip/row equality, per-window stale hints, reset rounding, and account masking.

AC11: Scope holds to `LimitsFooter.tsx`, `AccountsPanel.tsx`, shared rate-limit formatting/reconciliation, the limits payload types and server read, their focused tests, and this spec. No `src/lib/{flows,agent,runtime}` source, API route behavior, dependency, or deployment changes are included.

AC12: Every touched test file passes independently, TypeScript type checking passes, scoped ESLint passes, and the publication privacy gate passes. No suite that sweeps the operator's live runtime or registry state is run.

## Validation gates

- `bun test src/lib/rateLimit.test.ts`
- `bun test src/lib/limits.test.ts`
- `bun test src/hooks/useEngineAccounts.test.ts`
- `bun test src/components/rateLimit.test.ts`
- `bun test src/components/AccountsPanel.dom.test.tsx`
- `bun test src/components/LimitsFooter.dom.test.tsx`
- `bun test src/components/LimitsFooter.test.ts`
- `bunx tsc --noEmit`
- `bunx eslint` over the touched TypeScript files
- `bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD origin/main)`
