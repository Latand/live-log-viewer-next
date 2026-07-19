# Issue #448 — historical blob and edit-history retention

The current-head remediation replaces exposed media and text at every reachable
tip. It does **not** rewrite shared Git history or delete public discussion,
because both are destructive and would erase project evidence without an agreed
strategy. This document records what remains reachable and the explicit, safe
options for fuller removal, so the operator can decide deliberately.

## What remains reachable after current-head remediation

- **Committed media in ancestor commits.** The live-capture screenshots that the
  redacted placeholders now overwrite still exist as blobs in older commits, and
  in the histories of already-merged and still-open branches. Anyone with the
  blob SHA or an ancestor commit can fetch them.
- **GitHub pull-request commit blobs.** GitHub retains force-pushed and
  superseded commits for pull requests. A blob referenced by an old PR push can
  stay fetchable through its object SHA even after the branch head moves.
- **GitHub edit history for issues and comments.** Editing an issue body, a
  pull-request body, or a comment does not purge the prior revision. GitHub keeps
  previous versions behind the edit-history control, viewable by anyone who can
  read the thread. The in-place sanitization therefore lowers casual visibility
  but does not by itself erase the original value from GitHub's servers.

## Safe removal options (operator decision required)

None of the following is performed implicitly. Each has a distinct cost.

1. **Leave history, rely on current-head redaction (default).** No history
   rewrite, no deletion. Exposure persists in ancestor blobs and edit history but
   is absent from every current tip. Lowest risk, incomplete purge.
2. **Delete the highest-severity comments.** For threads that published dense
   identifier or path dumps, deleting the individual comments removes them and
   their edit history. This loses discussion content and must be chosen per
   comment, not in bulk.
3. **Ask GitHub Support to purge blobs and edit history.** Full removal of
   force-pushed blobs and prior edit revisions requires a GitHub Support request
   referencing the specific objects. This is the only route that removes values
   already retained server-side.
4. **Rewrite Git history.** Filtering the affected media out of history and
   force-pushing every branch would remove the committed blobs, but it rewrites
   shared history, breaks outstanding clones and open PRs, and must never be run
   without coordinated operator approval. It is documented here only for
   completeness and is out of scope for this change.

## Recommendation

Adopt option 1 now (already in force through current-head remediation), and
escalate the issue #282 comment thread and the PR #438 / PR #441 ancestor
capture blobs through option 2 or option 3 if the operator requires the retained
copies to be purged. Do not run option 4 without an explicit, coordinated
history-rewrite decision.
