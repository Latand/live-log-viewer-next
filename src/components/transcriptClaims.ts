/*
 * One physical transcript, one identity — at CLAIM time (issue #943 follow-up).
 *
 * Flow rounds and pipeline attempts durably record a member's transcript path in
 * whatever spelling was current when the record was written: a legacy
 * `~/.claude/projects/…` home, or an account-local `accounts/claude/<id>/projects/…`
 * one. The very same file is addressable under all of them, because a cut-over
 * account home keeps `projects` as a symlink into the shared transcript store —
 * and discovery reports exactly one of those spellings, the root it walked. Every
 * claim in the board's fold/collapse path compares those recorded paths against
 * the projected corpus AS STRINGS, so a record written before the cut-over
 * silently misses: its reviewer never folds into the flow's round deck and its
 * stage worker never classifies, and each round renders as a free node instead.
 *
 * `src/lib/scanner/transcriptIdentity.ts` solves the same problem for the
 * scanner's demote and pin sets, but it resolves root aliases through
 * `fs.realpathSync` — server-only, and blind to an account-local `projects`
 * symlink, which never appears among the scan roots it rewrites onto. The board
 * runs in the browser, so the canonical form is derived from the data it already
 * holds: the projected file corpus IS the set of spellings discovery walked.
 *
 * A recorded path is therefore resolved against the corpus by its root-relative
 * tail — the encoded project directory (Claude) or session day (Codex) plus the
 * transcript's own UUID-bearing filename. Only a record that is absent from the
 * corpus verbatim is resolved, only onto a path the corpus actually contains,
 * and only when that tail names exactly ONE transcript. So the resolution can
 * never invent a claim on a file that is not there, and an ambiguous tail (two
 * transcripts of the same name under different roots) stays unresolved rather
 * than folding the wrong card away.
 */

/** Rewrites a durably recorded transcript path onto the spelling the projection
    published, or returns it untouched when there is nothing to resolve. */
export type TranscriptClaimResolver = (recordedPath: string) => string;

export const IDENTITY_CLAIM_RESOLVER: TranscriptClaimResolver = (recordedPath) => recordedPath;

/** Root-relative tail identifying a transcript across root spellings: the
    containing directory plus the file name. Both engines put a UUID in the file
    name, so the pair is an identity everywhere the corpus is not ambiguous. */
function claimTail(pathname: string): string {
  return pathname.split("/").slice(-2).join("/");
}

/**
 * A resolver anchored on the projected corpus. Pure, allocation-bounded by the
 * file set, and safe to rebuild per render.
 */
export function transcriptClaimResolver(files: readonly { path: string }[]): TranscriptClaimResolver {
  const corpus = new Set<string>();
  for (const file of files) corpus.add(file.path);
  /* A tail claimed by more than one transcript resolves to nothing: `null` marks
     it ambiguous so a later lookup falls through to the recorded path. */
  const byTail = new Map<string, string | null>();
  for (const path of corpus) {
    const tail = claimTail(path);
    if (!byTail.has(tail)) byTail.set(tail, path);
    else if (byTail.get(tail) !== path) byTail.set(tail, null);
  }
  return (recordedPath) => {
    if (!recordedPath || corpus.has(recordedPath)) return recordedPath;
    return byTail.get(claimTail(recordedPath)) ?? recordedPath;
  };
}

/** Resolves a whole claim set, keeping both spellings so either still matches —
    the set may be compared against recorded paths as well as corpus ones. */
export function resolveTranscriptClaims(
  paths: ReadonlySet<string>,
  resolve: TranscriptClaimResolver,
): ReadonlySet<string> {
  if (!paths.size || resolve === IDENTITY_CLAIM_RESOLVER) return paths;
  const resolved = new Set<string>();
  for (const path of paths) {
    resolved.add(path);
    resolved.add(resolve(path));
  }
  return resolved.size === paths.size ? paths : resolved;
}
