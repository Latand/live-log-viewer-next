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

1. `projectInfoFromClaudeTaskCwd` — Claude scratchpad descendants at
   `<tmp>/claude-<uid>/<encoded-cwd>/<session>/scratchpad/…`; dotted worktree
   containers survive in the encoded cwd and recover the parent project.
2. `worktreeFromPath` — Claude worktrees at `<repo>/.claude/worktrees/<name>/…`
3. `worktreeFromNested` — the `git worktree add worktrees/<name>` (and dotted
   `.worktrees/<name>`) convention: the checkout nests inside the repo, so the
   repo is the path prefix before the first `worktrees`/`.worktrees` segment;
   specialized `.claude`/`.codex` containers are left to #2/#4. The
   first container wins, so a worktree-of-a-worktree groups under the outermost repo.
4. `worktreeFromCodexPath` — Codex worktrees at `~/.codex/worktrees/<hash>/<Repo>`

Only then the **disk-dependent** resolvers, as fallbacks:

5. `worktreeFromGitFile` — any linked git worktree, resolved from its `.git`
   **file** (`gitdir:` pointer) — works **only while the checkout exists on
   disk**. Every live resolution here is written to a persistent map (below).
6. `worktreeFromMemory` — replays a `worktreeFromGitFile` resolution recorded
   (to `state/worktree-map.json`) while the checkout was alive. This is the only
   thing that saves an **arbitrary-path** `git worktree add ../sibling` checkout
   (e.g. `~/.agents/tools/live-log-viewer-<branch>`), which has NO recognizable
   path layout, once it is deleted. Consulted only when no path recognizer
   matched and the cwd is gone.

**The invariant that keeps biting:** a worktree's grouping must survive the
checkout being **deleted**. Any mapping that finds the parent repo only by
reading on-disk git metadata (#5) silently fails afterward and the session
fragments into a phantom lookalike project (`-codex-worktrees-<hash>-<Repo>`,
`…-Projects-<Repo>-worktrees-<name>`, `…-<branch>`, …). Recognize each layout by
**path** (#1–#4) wherever the path reveals the repo; fall back to the persisted
resolution (#6) only for arbitrary sibling paths that cannot. Live and dead
checkouts of the same repo must resolve to the **same** project name.

When adding a new agent/worktree layout: prefer a pure path recognizer beside
#1–#4 and wire it into `projectInfoFromCwd`; only reach for the persisted map
when the path genuinely cannot name the repo. Add a "deleted worktree still
groups under its parent repo" case to `describe.test.ts`. Don't rely on the
checkout being present, and don't invent a second naming scheme.
<!-- END:worktree-grouping -->

<!-- BEGIN:live-state-and-publication -->
# Two ways to do real damage here (both happened, 2026-07-24)

## Never run this repo's suites against the operator's live state

`bun test src/lib/agent/ src/app/api/runtime/` and anything else that sweeps
whole runtime/registry directories exercises host lifecycle code against the
**shared** registry under `$XDG_CONFIG_HOME/agent-log-viewer/state`. Running it
on the operator's machine killed the structured host that owned the session the
operator was talking to. Their composer started answering `structured host
ownership is unavailable` and they had to recover the conversation by pasting an
attach command into a terminal.

Run the specific test files you touched, by path. If a change genuinely needs a
broad sweep, point the run at an isolated state directory first and say so; do
not sweep the live one. The same applies to any command that enumerates and acts
on runtime processes — `pgrep -f <pattern>` matches your own command line too.

## This repository is public — publication surfaces carry no identities

Docs, issues, PR bodies, commit messages, fixtures, and test data are public the
moment they are pushed. Never put an account handle, email, account id, token,
or absolute home path into any of them, including evidence tables pasted from a
live investigation. Distinguish accounts as "account A / account B" with their
plan tier, and keep paths repo-relative or `$HOME`-relative.

`privacy-publication` on CI enforces this with a fingerprint list the repo does
not carry, so it fails **after** you have pushed. Scrub before the push:
`bun scripts/privacy-publication-gate.ts --base <merge-base>` locally catches the
generic classes, and re-read every table and quote you lifted out of logs.
<!-- END:live-state-and-publication -->
