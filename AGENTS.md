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
# Local hooks mirror the publication gate

Run `git config core.hooksPath .githooks` once per clone (worktrees inherit it
from their parent repo's config). `pre-push` runs the real
`privacy-publication-gate` (sub-second) from the merge base with commit
checking, and warns when the branch is behind `origin/main` — the state in
which the hosted gate flags main-only commits. `LLV_SKIP_HOOKS=1` skips it
for a false positive.

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

One exemption, and only in a trailer: a `Co-Authored-By:` / `Signed-Off-By:`
whose address has the local part exactly `noreply` or `no-reply` names a tool
and identifies nobody, so agent attribution stays and the gate passes it
(`MACHINE_ATTRIBUTION_TRAILER`). It is the standing attribution trailer on
agent-written commits here — do not strip it, from your own commit or anyone
else's. The exemption is that narrow on purpose: a GitHub `users.noreply`
address reads as a no-reply address and is an account handle with a number in
front of it, and the same address written into prose is not attribution, so
both are still violations.

The identity git records on a commit is read by a separate rule. A squash merge
composes those identities into a `Co-authored-by:` trailer on the default
branch, and there an address on the `users.noreply` host of the forge passes:
the forge issues it so an account's own address is not what its commits carry.
That reading is the merge boundary only — it changes nothing about what you may
write into a message, a doc or a fixture, where the paragraph above still holds.

`privacy-publication` on CI enforces this with a fingerprint list the repo does
not carry, so it fails **after** you have pushed. Scrub before the push:
`bun scripts/privacy-publication-gate.ts --base <merge-base>` locally catches the
generic classes, and re-read every table and quote you lifted out of logs.
<!-- END:live-state-and-publication -->

<!-- BEGIN:runtime-host-verification -->
# Two processes run under Bun here, and only one of them was ever checked

The Viewer and the **runtime host** (`src/runtime-host/`) both run under the
Bun pinned in the `Dockerfile`. The runtime host owns the stable listener and
performs the release succession, so when it crash-loops, that is an outage no
Viewer health check can see. Moving the pin to 1.4.0 was verified thoroughly
and only on the Viewer; the host had never been started under the new runtime
when it was promoted, and it died on its first failing socket write (#1254).

**A change to a Bun pin is not verified until the runtime host has run under
it.** Before such a change is proposed for promotion, run:

```
bun scripts/verify-runtime-host.ts --runtime <the bun binary being pinned>
```

It starts two runtime-host generations under that interpreter, drives one
singleton-fence succession, and holds both endpoints the succession handed
over while peers come and go — in a private state directory on an ephemeral
port, never the stable one. Half the callers walk away mid-answer without
reading a byte of a snapshot-sized reply, which is the write that took
production down: run against the host as it was, the rehearsal kills it
within a second under 1.4.0 and passes under 1.3.3, exactly as the incident
did. The same rehearsal runs inside a container built from the candidate image
during `verify-candidate`, so a candidate whose host cannot boot, cannot take
the fence, or cannot hold what it took is refused before promotion rather than
after.

**Both halves now run on CI**, in the `bun-runtime` job, at the pull request's
own commit. `scripts/verify-viewer-runtime.ts` is the Viewer half: it loads
every compiled server runtime the build produced — `app-page.runtime.prod.js`
among them, the module whose load failure answered 500 on every route — and
then serves the build and requires `GET /` to answer 200. The job reads its Bun
version out of the `Dockerfile`, so moving the pin is itself what re-runs the
verification, and a rehearsal or a load that fails ends the job. The job also
proves each of those checks can go red rather than only reporting that it went
green: the tests holding both verdicts run inside it, and then each half is
handed a subject that does not hold — no build at all, the incident's own
`app-page.runtime.prod.js` made unloadable on purpose, a root with no runtime
host in it — and a check that stays green against one of those fails the job.
A green check whose red path nobody has seen is the same unattributable claim
one level up. Run both locally to find out early; the job is what a reviewer
can point at, which three rounds of #1248 spent on a local claim nobody could
reproduce. What the job deliberately leaves out is the image build — the
runtime stage installs apt packages and a Python whisper environment and sets
the setuid bit on nsenter, which is far heavier than a pull request check — so
the in-image rehearsal under `bun-container` stays where it is, in
`verify-candidate`, before any promotion.

Three consequences worth keeping:

- **A failing socket write is a connection event, never a process event.**
  Every long-lived listener in the runtime host attaches its `error` handler
  to a connection before the first byte can be written to it. Bun 1.3.3 dropped
  failed writes silently, which is why the missing handlers survived so long;
  1.4.0 reports them, and an unhandled `error` on a connection kills the
  process that owns 8898. Tests must not paper over this: a test harness that
  attaches its own listener to each accepted connection hides exactly the
  defect the production server has.
- **Verification has to name the process it exercised.** "Loaded every built
  server module and requested real routes" is a statement about the Viewer. Say
  which process, or the gap comes back.
- **Inside the image, the interpreter is `bun-container`.** `bun` there is an
  nsenter shim onto the operator's own bun, for the agent CLIs; in a container
  without the host PID namespace it cannot run at all, and it is never the
  interpreter being promoted. Anything that starts a first-party process inside
  the image names `bun-container`, and the rehearsal passes that name down to
  the generations it starts.
<!-- END:runtime-host-verification -->
