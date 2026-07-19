# PR #439 visual evidence — pipeline stage graph navigation repair

The stage graph now opens **valid path-only attempts** — a launch that recorded a
transcript path but never adopted a stable conversation id. Every navigable
surface (primary nodes, retry stacks, review-cycle implementer/reviewer roles)
resolves the current non-archived conversation generation first and falls back to
`agentPath`, instead of leaving the control disabled when no conversation id is
present. The truly unavailable state (neither id nor path) stays disabled, and the
prior good graph / editable-stage behaviour is unchanged.

These images were server-rendered from a **synthetic** pipeline over the compiled
production Tailwind bundle. Stage ids (`plan`, `build`, `review`, `verify`), the
model label `gpt-5.6-sol`, and every attempt path (`/synthetic/…`) are fabricated
for this acceptance pass — no real project names, filesystem paths, account names,
transcripts, or personal data appear in either frame.

- `stage-graph-desktop.png` — the full declared plan. `plan` passed after a retry
  whose first attempt is path-only (the `attempt 2` disclosure keeps that prior
  path-only launch linkable); `build` carries a grouped review cycle at
  `round 1/3`; `verify` stays a clickable pending ghost.
- `stage-graph-390px.png` — the same graph framed in a `390 px` mobile column. The
  node and its retry stack read at full width while the rail scrolls horizontally
  to the downstream stages, matching the board's `overflow-x-auto` container.

Regenerate with:

```
bun run build                      # emits .next/static/css/*.css the shots link
bun docs/acceptance/pr-439/capture.ts
```

The capture server-renders the graph twice with a markup-equality gate, drives
headless Chrome over raw CDP (the pinned mcp/puppeteer container is not available
on every host), re-reads each surface's `innerText` for stability before the shot,
and crops to the graph element so no surrounding chrome or private data is framed.
