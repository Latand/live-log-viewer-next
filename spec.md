# Issue #1004: Keep the focused mandate field above the fold in the mobile create-orchestrator sheet

On the phone's create-orchestrator sheet, with the keyboard open, the focused Mandate field can sit entirely below the fold: in the intent-error state the error card plus the engine/account/reasoning controls fill the sheet's visible scroller, the "Mandate" label lands at the fold, and the focused textarea starts past it — the operator types into an invisible field. The #979 capture script's geometry gate measures only the confirm button, so the state passes green.

The fix is the one designed by the 2026-08 UX audit (`docs/design/ux-audit-2026-08.md`, finding 5): reveal the field inside the sheet's own scroller on focus while the keyboard inset is > 0, and extend the capture gate to require the focused field above the fold. No alternative design.

## Acceptance criteria

AC1: With the keyboard inset > 0 and the mandate field focused, the sheet scrolls the mandate block — the element carrying the label, not the bare textarea — into view inside its own body scroller with `scrollIntoView({ block: "start" })`.

AC2: Both arrival orders reveal the field: focus first with the keyboard opening after (a tap), and focus moving in while the keyboard is already open.

AC3: The reveal fires once per typing session. A later keyboard resize while the field stays focused does not scroll again, so manual scrolling is never fought after the initial reveal. Focus or the keyboard leaving and returning re-arms it.

AC4: Focus with the keyboard closed (inset 0) scrolls nothing.

AC5: The #979 capture geometry gate additionally requires, in every keyboard-open sheet state it already visits (draft, edited, intent-error) and both schemes, that the focused field's first line sits above whichever fold comes first — the sheet scroller's bottom edge or the keyboard's top — and that the field's top is not above the scroller's own top edge.

AC6: The extended gate fails on the pre-fix component in the state that violates it, and the whole capture run passes with the fix: exit 0, every state × scheme, all frames written.

AC7: Every gate the script already enforced stays green: 44px tap target, pin before the first conversation chip, chat-budget strip height, no horizontal document scroll, confirm above the keyboard, no window scroll to reach the field, sheet body is the one scroller.

AC8: Scope holds — only the mobile create-orchestrator sheet component, the capture script's gates, and the sheet's own DOM test file change. No `src/lib/{flows,agent,runtime}`, no API routes, no desktop surfaces, no new dependency, no new setting, no refactor beyond the fix.

AC9: Focused tests, TypeScript type checking, scoped linting and the publication privacy gate pass; no repo suite that sweeps the operator's live runtime/registry state is run.

## Validation gates

- `bun test src/components/mobile/mobileOrchestratorRow.dom.test.tsx`
- `bun run build && bun scripts/capture-issue-979-mobile-orchestrator.ts` (the capture is the acceptance test: it must exit 0)
- `bunx tsc --noEmit`
- `bunx eslint` over the changed TypeScript files
- `bun scripts/privacy-publication-gate.ts --base origin/main`
