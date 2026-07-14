/**
 * Which account a conversation currently runs under, for the header account
 * badge (issue #229).
 *
 * Managed accounts nest their transcripts under `…/accounts/<engine>/<id>/…`
 * (see `claudeAccountsRoot` / `codexAccountsRoot`); the legacy home has no such
 * segment and maps to the default account. This reads the *live* transcript
 * path, so when a migration commits (issue #40) and the transcript rotates onto
 * the target account's home, the derived id follows — no spawn-time snapshot is
 * cached, and the badge updates with the projection.
 */

/** The legacy (default) home carries no managed-account path segment. */
export const DEFAULT_ACCOUNT_ID = "default";

const ACCOUNT_PATH = /[/\\]accounts[/\\](?:claude|codex)[/\\]([^/\\]+)[/\\]/;

/** The account id owning a transcript path, or {@link DEFAULT_ACCOUNT_ID}. */
export function accountIdFromPath(path: string | null | undefined): string {
  if (!path) return DEFAULT_ACCOUNT_ID;
  const match = ACCOUNT_PATH.exec(path);
  return match ? match[1]! : DEFAULT_ACCOUNT_ID;
}
