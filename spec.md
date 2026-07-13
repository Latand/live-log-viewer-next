# Issues #173 and #174: Project CWD prefills and global conversation cache

Review PR #176 on `agent/issues-173-174-cwd-cache` against both user-facing issues.

## Acceptance criteria

AC1: Every agent draft opened inside a project starts with an editable working directory derived from that project's canonical repository root.

AC2: Canonical project roots are derived from conversation CWD metadata across the full scan, including projects whose conversations fall outside the capped response rows.

AC3: Handoff drafts inherit the source conversation's exact CWD. Board agent drafts, task-to-agent drafts, project views, and handoffs share the same prefill behavior.

AC4: The client keeps one session-wide cross-project conversation snapshot. Switching projects filters that snapshot immediately and performs zero project-scoped scan request.

AC5: Background revalidation patches changed rows into cached data. URL-specific conditional requests restore their matching cached representation, and delayed responses cannot overwrite newer data.

AC6: Runtime SSE revision hydration and degraded-connection polling continue to refresh the global snapshot.

AC7: The implementation changes no files under `src/lib/flows/`, `src/lib/agent/`, or `src/lib/runtime/`.

AC8: Any newly introduced user-facing copy is present in English and Ukrainian. Existing 44px mobile controls, 390px layouts, and desktop layouts remain intact.

AC9: Tests cover canonical CWD derivation, catalog-only project roots, handoff inheritance, cache hits, stale-while-revalidate patching, URL representation restoration, project-query independence, response ordering, and SSE revision behavior.

AC10: A fresh review uses severity-tagged findings and reaches APPROVE only when every blocking finding is resolved.

## Validation gates

- `bun install`
- `bunx tsc --noEmit`
- `bun test`
- `git diff --check`
- verify the complete diff contains zero changes under the forbidden library directories
