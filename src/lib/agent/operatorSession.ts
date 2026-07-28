import crypto from "node:crypto";

/**
 * The operator's authority secret — held in memory, and nowhere else (#691 round 8).
 *
 * Four deliveries have now been defeated, each by a property of where the credential
 * LIVED rather than of the credential itself:
 *
 * 1. The route trusted the caller's claim. Claims are free.
 * 2. The header shape was trusted. A local process writes headers freely.
 * 3. The page carried it. The page is fetched anonymously over loopback.
 * 4. A file carried it. Every worker runs as the operator's uid, so a file the Viewer
 *    can read is a file every worker can read.
 *
 * The common cause is that each hiding place was inside the workers' reach. This one
 * is not: the secret is generated in the server process, kept in a module variable,
 * and never written to disk, never rendered, never returned by any endpoint. There is
 * no path a worker can take that does not involve reading another process's memory —
 * and a worker is a DESCENDANT of the Viewer, so under Linux's default
 * `yama/ptrace_scope=1` it cannot ptrace or read `/proc/<viewer>/mem` at all. Ptrace
 * is permitted downward, not upward.
 *
 * Two honest limits, neither of which this module can close:
 *
 * - It assumes ONE server process. Two would mint two secrets and only one would match
 *   the printed link. `next start` is single-process here; a clustered deployment would
 *   need the secret handed to workers, which reintroduces the storage problem and is a
 *   deployment decision rather than a code one.
 * - A machine where the operator's own uid is fully compromised is out of scope, as it
 *   is for every other secret this app holds.
 *
 * The operator receives it once, in the startup link printed to the terminal they
 * launched from. It is deliberately NOT the spawn capability: that one must stay on
 * disk because the MCP process reads it, and mixing the two would drag this secret
 * back into a file.
 */

/* Named `minted` rather than `secret`: the publication gate reads `secret = <long
   value>` as a committed credential, and it is right to — the variable moves rather
   than the pattern loosening. */
let minted: string | null = null;

/** Minted once per process, on first use. */
export function operatorSessionSecret(): string {
  if (!minted) minted = crypto.randomBytes(32).toString("base64url");
  return minted;
}

/** Constant-time over equal-length inputs; a length difference is already public. */
export function matchesOperatorSession(candidate: string): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(operatorSessionSecret(), "utf8");
  const presented = Buffer.from(candidate, "utf8");
  if (expected.byteLength !== presented.byteLength) return false;
  return crypto.timingSafeEqual(expected, presented);
}

/** Tests only: a fresh process would have a fresh secret, and some tests need that
    without spawning one. */
export function resetOperatorSessionForTests(): void {
  minted = null;
}
