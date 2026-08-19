/**
 * What a deploy request may name, in one place (#1033).
 *
 * A SHA that travels through a human's or an agent's notes is a SHA that can be
 * mangled: #1032 burned six hours redeploying `0afe3c29238ac2d2…` — a revision
 * that never existed, one retyped tail away from the real main tip. Callers may
 * therefore name a branch of the canonical repository instead, and the exact
 * commit is resolved machine-to-machine against the canonical mirror.
 *
 * An explicit SHA stays accepted for pinned redeploys and rollbacks; what
 * changes is that carrying one is no longer the only way to deploy.
 */

export const CANONICAL_MAIN_REF = "refs/heads/main";

/** Branch refs of the canonical repository, and nothing else: no tags, no
    remote-tracking refs, no `..` traversal, and no leading `-` that git would
    read as an option. */
export function isCanonicalBranchRef(value: string): boolean {
  return value.length <= 200 && /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value);
}

export function isExactRevision(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The `git rev-parse` query for a requested revision, or `null` when the
    request names something this deploy path refuses to resolve. */
export function canonicalRevisionQuery(requested: string): string | null {
  if (requested === "origin/main") return `${CANONICAL_MAIN_REF}^{commit}`;
  if (isExactRevision(requested) || isCanonicalBranchRef(requested)) return `${requested}^{commit}`;
  return null;
}

export const REQUESTED_REVISION_REFUSAL = "deployment revision must be origin/main, a canonical branch ref, or a full commit SHA";

/** #1032: the admission failure named neither the revision nor where it looked,
    so a mangled SHA read as broken infrastructure for five hours. */
export function revisionNotFoundMessage(requested: string, remote: string): string {
  return `revision ${requested} not found in the canonical repository (fetched from ${remote})`;
}
