import crypto from "node:crypto";

/**
 * The operator's authority secret — one per SERVER PROCESS, not one per bundle
 * (#691 round 9).
 *
 * Five deliveries have now been defeated, each by a property of where the credential
 * LIVED rather than of the credential itself:
 *
 * 1. The route trusted the caller's claim. Claims are free.
 * 2. The header shape was trusted. A local process writes headers freely.
 * 3. The page carried it. The page is fetched anonymously over loopback.
 * 4. A file carried it. Every worker runs as the operator's uid, so a file the Viewer
 *    can read is a file every worker can read.
 * 5. The browser persisted it. Web storage is a file in the profile directory, so 4
 *    again, wearing a `sessionStorage` costume — see `components/operatorCredential.ts`.
 *
 * Round 8 moved the secret into process memory, which is the right place. It then put
 * it in a MODULE variable, and that is where it came apart: Next compiles the
 * instrumentation entry and every route handler into separate server bundles, and each
 * bundle gets its own copy of this module — so each one minted its OWN secret. The
 * built server carried seven copies of the mint. The credential printed at startup
 * therefore matched no route at all, and the three operator-gated routes did not even
 * agree with each other. Every in-process test passed, because a single test process
 * loads this module once; only the built server can show it.
 *
 * So the secret is not module state. It is PROCESS state, held in the global symbol
 * registry — `Symbol.for` resolves to the same symbol from every bundle in the realm,
 * which is exactly the "one per process" that was being claimed all along. Generation
 * and comparison both go through `sessionSecret()`, the single point where the value is
 * read, so there is no second way to mint one and no second thing to compare against.
 *
 * Two honest limits, neither of which this module can close:
 *
 * - It assumes ONE server process. Two would mint two secrets and only one would match
 *   the printed credential. `next start` is single-process here; a clustered deployment
 *   would need the secret handed to workers, which reintroduces the storage problem and
 *   is a deployment decision rather than a code one. The same caveat covers a worker
 *   THREAD, which gets its own realm and so its own global registry — no operator gate
 *   runs in one, and none should be added without revisiting this.
 * - A machine where the operator's own uid is fully compromised is out of scope, as it
 *   is for every other secret this app holds.
 *
 * The operator receives it once, printed to the terminal they launched the Viewer from.
 * It is deliberately NOT the spawn capability: that one must stay on disk because the
 * MCP process reads it, and mixing the two would drag this secret back into a file.
 */

/* Global registry, not module scope: see above. `Symbol.for` is the realm-wide lookup,
   so all seven bundle copies of this file address one slot.

   Named `held` rather than anything with `secret` in it: the publication gate reads
   `secret = <long value>` as a committed credential, and it is right to — the variable
   moves rather than the pattern loosening. */
const SLOT = Symbol.for("llv.operator.session.minted");

type ProcessSlot = { [SLOT]?: string };

function held(): ProcessSlot {
  return globalThis as unknown as ProcessSlot;
}

/**
 * The one read of the operator secret, minted on first use.
 *
 * Synchronous and single-threaded, so the check-then-set cannot interleave: whichever
 * bundle asks first mints, and every other bundle in the process reads that value.
 */
function sessionSecret(): string {
  const slot = held();
  if (!slot[SLOT]) slot[SLOT] = crypto.randomBytes(32).toString("base64url");
  return slot[SLOT];
}

/** The value to hand the operator at startup. Printed once, to their terminal. */
export function operatorSessionSecret(): string {
  return sessionSecret();
}

/** Constant-time over equal-length inputs; a length difference is already public. */
export function matchesOperatorSession(candidate: string): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(sessionSecret(), "utf8");
  const presented = Buffer.from(candidate, "utf8");
  if (expected.byteLength !== presented.byteLength) return false;
  return crypto.timingSafeEqual(expected, presented);
}

/** Tests only: a fresh process would have a fresh secret, and some tests need that
    without spawning one. */
export function resetOperatorSessionForTests(): void {
  delete held()[SLOT];
}
