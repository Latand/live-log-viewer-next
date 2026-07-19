# Issue #448 — public tracker remediation inventory

This inventory records the sanitization of public GitHub issue bodies, issue
comments, and pull-request bodies performed for issue #448. It names each
remediated surface and the exposure class that was replaced. It never records a
matched private value. Every replacement swapped a real value for a neutral
synthetic placeholder while preserving the surrounding technical meaning.

## Exposure classes and placeholders

| Class | Real value replaced | Neutral placeholder |
| --- | --- | --- |
| `home_path` | Absolute local home paths, OS username, encoded per-conversation project directories, incident filenames carrying the username | `/home/user/…`, `/Users/user/…`, `-home-user-…` |
| `project_name` | Unrelated private project names unrelated to this repository | `example-project-a`, `example-project-b` |
| `resource_identifier` | Real conversation, session, and board task identifiers (v1–v5 UUIDs) | `00000000-0000-0000-0000-000000000000` |
| `private_network` | Docker bridge host in a dev-origin example | `<docker-bridge-host>` |

Synthetic all-zero UUID placeholders are intentionally exempt from the
identifier pattern, so re-running the sanitizer is idempotent and never rewrites
an already-redacted placeholder. The repository owner's public GitHub handle and
display name were left untouched: they are the owner's existing public identity,
not a leak. Domain vocabulary such as `tmux`, `session`, and `pid` was left
untouched: these are product concepts for this agent-log viewer, not runtime
disclosures.

## Remediated surfaces

Replacement counts are class counts, not values.

### Pull-request bodies

| Surface | Classes replaced |
| --- | --- |
| PR #437 | `resource_identifier`=1 |
| PR #438 | `resource_identifier`=1 |
| PR #439 | `resource_identifier`=1 |
| PR #441 | `resource_identifier`=1 |
| PR #443 | `resource_identifier`=1 |
| PR #447 | `resource_identifier`=1 |

### Issue bodies

| Surface | Classes replaced |
| --- | --- |
| Issue #28 | `private_network`=1 |
| Issue #32 | `home_path`=14, `project_name`=4 |
| Issue #63 | `home_path`=1 |
| Issue #277 | `resource_identifier`=2 |
| Issue #282 | `resource_identifier`=2 |
| Issue #284 | `resource_identifier`=2 |
| Issue #286 | `resource_identifier`=2 |
| Issue #344 | `resource_identifier`=2 |
| Issue #389 | `project_name`=1 |

### Issue comments

Comment-level surfaces were remediated across issues #28, #32, #37, #45, #56,
#282, #288, #297, #299, #326, #337, #340, and #389. The heaviest concentration
was issue #282, whose comment thread published real conversation-log filenames,
unrelated private project names, and per-conversation project directories. All
were replaced with the neutral placeholders above.

## Verification

- A re-fetch of every remediated surface followed by a fresh detection pass
  reports zero residual real home paths, encoded home directories, unrelated
  project names, private-network addresses, or live identifiers.
- The sanitizer is idempotent: a second dry run produces no content-changing
  replacements.
- Detection output and this inventory emit only exposure classes, surface
  locators, and counts. Matched private values remain redacted everywhere.

## Excluded false positives

Two candidate classes were reviewed and deliberately excluded from
auto-remediation:

- `process_metadata`: every match was the product term `tmux` or `session`,
  which are core concepts of this agent-log viewer rather than runtime leaks.
- `known_value`: matches were the repository owner's own public GitHub handle
  and display name in their own tracker, which are not a disclosure.
