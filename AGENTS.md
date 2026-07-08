<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:worktree-grouping -->
# Worktree → project grouping (canonical — do not re-break)

Agents run tasks inside **worktree checkouts**. Every session that runs from a
worktree MUST group in the sidebar under its **parent repo's** project — never
as its own lookalike project. This is one algorithm, enforced in
`src/lib/scanner/describe.ts` by `projectInfoFromCwd(cwd)`, which resolves the
parent repo by trying these recognizers in order:

The **pure path recognizers** run first — they need nothing on disk, so they
work identically for live and deleted checkouts:

1. `worktreeFromPath` — Claude worktrees at `<repo>/.claude/worktrees/<name>/…`
2. `worktreeFromNested` — the `git worktree add worktrees/<name>` (and dotted
   `.worktrees/<name>`) convention: the checkout nests inside the repo, so the
   repo is the path prefix before the first `worktrees`/`.worktrees` segment (a
   `worktrees` segment directly under `.claude`/`.codex` is left to #1/#3). The
   first container wins, so a worktree-of-a-worktree groups under the outermost repo.
3. `worktreeFromCodexPath` — Codex worktrees at `~/.codex/worktrees/<hash>/<Repo>`

Only then the **disk-dependent** resolvers, as fallbacks:

4. `worktreeFromGitFile` — any linked git worktree, resolved from its `.git`
   **file** (`gitdir:` pointer) — works **only while the checkout exists on
   disk**. Every live resolution here is written to a persistent map (below).
5. `worktreeFromMemory` — replays a `worktreeFromGitFile` resolution recorded
   (to `state/worktree-map.json`) while the checkout was alive. This is the only
   thing that saves an **arbitrary-path** `git worktree add ../sibling` checkout
   (e.g. `~/.agents/tools/live-log-viewer-<branch>`), which has NO recognizable
   path layout, once it is deleted. Consulted only when no path recognizer
   matched and the cwd is gone.

**The invariant that keeps biting:** a worktree's grouping must survive the
checkout being **deleted**. Any mapping that finds the parent repo only by
reading on-disk git metadata (#4) silently fails afterward and the session
fragments into a phantom lookalike project (`-codex-worktrees-<hash>-<Repo>`,
`…-Projects-<Repo>-worktrees-<name>`, `…-<branch>`, …). Recognize each layout by
**path** (#1–#3) wherever the path reveals the repo; fall back to the persisted
resolution (#5) only for arbitrary sibling paths that cannot. Live and dead
checkouts of the same repo must resolve to the **same** project name.

When adding a new agent/worktree layout: prefer a pure path recognizer beside
#1–#3 and wire it into `projectInfoFromCwd`; only reach for the persisted map
when the path genuinely cannot name the repo. Add a "deleted worktree still
groups under its parent repo" case to `describe.test.ts`. Don't rely on the
checkout being present, and don't invent a second naming scheme.
<!-- END:worktree-grouping -->
