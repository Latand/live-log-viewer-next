# Issue #1011: Per-project orchestrator dock width

Each project's orchestrator dock should remember its own width. Today the width is one global preference: `OrchestratorDock` reads it from `localStorage` under a single `WIDTH_KEY` on mount and the pointer-up handler writes that same key, so dragging the dock wide for one mandate-heavy project resizes the dock in every other project. Projects are isolated surfaces and their dock width should be too.

The fix is the one the issue specifies, no alternative: key the stored width by project (`WIDTH_KEY:<project>`), fall back to the legacy global key and then `DEFAULT_WIDTH` when the scoped key is absent so existing operators keep their current width as the seed everywhere, write only the scoped key, and re-read on a project switch. The component already receives `project` as a prop, so the change is contained to it.

## Acceptance criteria

AC1: The width the drag lands on is written under the project's own key, `llvOrchestratorPanelWidth:<project>`, and nowhere else — the legacy global key is left exactly as the operator had it.

AC2: A project that has never been sized opens at the legacy global width when one exists, so an operator arriving from the single shared preference keeps that width in every project; with neither key present it opens at `DEFAULT_WIDTH`. The legacy key answers only for **absence** of the scoped one — a scoped value that is unusable (non-numeric, or below `MIN_WIDTH`) falls to `DEFAULT_WIDTH`, which is `storedDockWidth`'s existing contract.

AC3: Two projects hold independent widths: resizing project A leaves project B's stored width untouched, and each reload restores its own.

AC4: Switching projects while the dock is open re-reads the new project's width, and the `shellLayout` row the preview sheet budgets around follows the switch. Switching back finds the first project's width unchanged.

AC5: Every clamp is unchanged — `MIN_WIDTH`, `RESERVED_BESIDE_DOCK`, `dockWidthForPointer`, and the CSS `max()/min()` floor — and the dock still publishes `RAIL_WIDTH + width` through `setLeftShellInset`, giving the row back on unmount. The board keeps `MIN_BOARD` with the preview sheet open, exactly as before.

AC6: The DOM test file covers the scoped write, the legacy-key fallback seed, independence across two projects, and the project-switch re-read.

AC7: Scope holds — only `src/components/orchestrator/OrchestratorDock.tsx` and its DOM test file change (plus this spec). No `src/lib/{flows,agent,runtime}`, no API routes, no mobile surfaces, no new dependency, no new setting, no refactor beyond the fix.

AC8: Focused tests, TypeScript type checking, scoped linting and the publication privacy gate pass; no repo suite that sweeps the operator's live runtime/registry state is run.

## Validation gates

- `bun test src/components/orchestrator/OrchestratorDock.dom.test.tsx`
- `bun test src/components/Viewer.orchestratorDock.dom.test.tsx src/components/orchestrator/OrchestratorPanel.dom.test.tsx` (the changed module's consumers)
- `bunx tsc --noEmit`
- `bunx eslint` over the changed TypeScript files
- `bun scripts/privacy-publication-gate.ts --base origin/main`
