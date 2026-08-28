# Contributing

Outside pull requests are welcome. This page covers the one thing that is
easier to get right before you commit than after: the identity your commits
carry.

## Your commit identity reaches the default branch

Git records an author and a committer on every commit, and a squash merge lifts
both into a `Co-authored-by:` trailer on the commit that lands on `main`. This
repository is public, so that trailer is published — and the
`privacy-publication` check reads it before the merge composes it.

An identity passes when its address is on the forge's
`users.noreply.github.com` host, which GitHub issues for exactly this reason,
or when it is a machine-attribution mailbox. A personal address is reported as
`email_address` with a `merge_boundary:` line naming the commit, and the merge
is blocked until the branch is re-authored.

To use your no-reply address, turn on **Keep my email addresses private** under
GitHub's email settings, then point the checkout at the address it shows you:

```sh
git config user.email '<the no-reply address GitHub shows you>'
git config user.name '<your name or handle>'
```

Commits already written can be re-authored with `git rebase --exec`, or with
`git commit --amend --reset-author` for a single one.

## Everything else the check reads

The same check reads the files you changed and the commit messages you wrote.
Keep account handles, addresses, tokens, absolute home paths, and transcript
excerpts out of both — [docs/privacy-publication.md](docs/privacy-publication.md)
describes what it looks for and why. Run it before you open the pull request:

```sh
bun run privacy:check
```

Findings name a class and a count, never the value that matched, so a failing
run tells you where to look without republishing what it found.
