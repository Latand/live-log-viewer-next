import { selectHeadlessAccount } from "./headlessSelection";
import type { DurableQuotaObservation } from "./migration/contracts";
import {
  allowedAccountIdsForProject,
  type AccountProjectBinding,
  type BindingEngine,
} from "./projectBindings";

/**
 * #1279's automatic rule, and the inventory of everything that obeys it.
 *
 * Four rounds each closed one account-selecting path and the next round found
 * another, so this file exists to make the SET the thing under review rather
 * than the next member of it. Eight places choose an account without being
 * told which. Every one of them reaches one of the two functions below, and
 * nothing here re-derives a pool or a capacity bar of its own:
 *
 * 1. **The direct launch** — `resolveHealthySpawnAccount`, which is `/api/spawn`
 *    and everything riding on it: the board's spawn button, the MCP spawn tool,
 *    the orchestrator seat, the scheduled launchers. → `selectProjectAccount`,
 *    with the Claude health pass narrowing what the rule already allowed.
 * 2. **The project-owned launch** — `AccountManager.resolveProjectSpawn`, reached
 *    by the task launch, the pipeline stage, the workflow stage and the flow's
 *    pane reviewer. → `selectProjectAccount`.
 * 3. **The capacity-rotating launch** — `AccountManager.resolveHeadlessSpawn`,
 *    reached by the flow's headless reviewer rotation (which excludes the
 *    accounts this round already tried) and the orchestrator handoff digest.
 *    → `selectProjectAccount`, whose UNBOUND branch stays rate-limit aware here.
 * 4. **The resume** — `resolveContinuityAccount`. Work that records an account
 *    continues on it, which is continuity and not a choice; work that records
 *    none was silently taking the engine's routing account and now → (2).
 * 5. **The engine-wide automatic migration** — `commitMigrationIntent` with an
 *    automatic origin. → `admitAutomaticAccountTarget`, per conversation.
 * 6. **The lazy active-account migration** on the delivery path —
 *    `requestConversationMigrationToActiveAccount`. → same, for one conversation.
 * 7. **The one-click reseat** — `chooseProjectReseatTarget`. Drawn from the pool;
 *    it keeps its own STRICTER capacity bar (real headroom, not merely "not
 *    exhausted"), because a successor seat picked on a nearly spent account is
 *    the failure it exists to avoid, and a stricter bar cannot escape this one.
 * 8. **Auto-balance** — `chooseAutoBalance`, the only producer of an automatic
 *    engine-wide target. It has no production caller at this commit, and its
 *    decision can only ever reach conversations through (5).
 *
 * Four neighbours are NOT on this list because they never choose an account for
 * any work: `selectHeadlessAccount` classifies capacity for a candidate set it
 * is handed, `selectHealthyClaudeAccount` narrows a candidate set and never
 * widens one, `contextForSpawn` resolves an id somebody already settled on into
 * a home, and `retireAccount` resets the engine default after an operator
 * DELETES the account it pointed at — it refuses while anything is live there
 * and moves no conversation, and the engine default only ever ORDERS a bound
 * project's candidates, so it cannot carry work out of a pool.
 *
 * A new automatic seam belongs on this list and behind one of the two functions
 * below. A new one that reads the pool itself is the defect coming back.
 */

/** What #1279's rule decides for one launch, before any home or env is resolved. */
export type ProjectAccountSelection =
  /** `accountId: null` means nothing constrained or preferred the choice, so the
      engine's own default account stands. */
  | { kind: "available"; accountId: string | null }
  | { kind: "not_allowed"; accountId: string; allowedAccountIds: string[] }
  | { kind: "exhausted"; resetsAt: number | null; allowedAccountIds: string[] }
  | { kind: "unavailable"; allowedAccountIds: string[] };

export interface ProjectAccountSelectionInput {
  project: string | null;
  engine: BindingEngine;
  accounts: readonly { id: string; authPresent: boolean }[];
  observations: readonly DurableQuotaObservation[];
  bindings: readonly AccountProjectBinding[];
  /** The account the launch named, if it named one. */
  requestedId?: string | null;
  /** The engine's current routing choice, used only to order candidates. */
  preferredId?: string | null;
  excludedIds?: readonly string[];
  /**
   * What an UNBOUND project does when nothing was named. The two launch paths
   * differ here and always have, so the binding must not quietly unify them:
   * `engine-default` is the pipeline seam's historical answer (the engine's
   * active account, with no capacity arithmetic), `capacity` is the headless
   * reviewer path's (rate-limit-aware selection across every account). Each
   * caller keeps its own, which is what "an unbound project is unchanged"
   * means at this seam.
   */
  unbound?: "engine-default" | "capacity";
  now?: number;
}

/**
 * The whole of #1279's selection rule, as a pure function.
 *
 * Three branches, and the middle one is why this exists:
 *
 * - **Unbound project** — `allowedAccountIdsForProject` answers null, and the
 *   caller's own historical strategy decides, untouched.
 * - **Bound project, an account named** — allowed, or refused. It is never
 *   downgraded to a different account: a pin the project forbids is a mistake
 *   worth reporting, not a preference worth working around.
 * - **Bound project, nothing named** — the candidates ARE the allowed set. Every
 *   one of them out of capacity reports `exhausted`; the idle account next door
 *   is not a candidate and is not consulted, which is the whole point.
 */
export function selectProjectAccount(input: ProjectAccountSelectionInput): ProjectAccountSelection {
  const allowed = allowedAccountIdsForProject(input.project, input.engine, input.bindings);
  const requestedId = input.requestedId?.trim() || null;
  if (requestedId && allowed !== null && !allowed.includes(requestedId)) {
    return { kind: "not_allowed", accountId: requestedId, allowedAccountIds: allowed };
  }
  if (requestedId) return { kind: "available", accountId: requestedId };
  if (allowed === null && (input.unbound ?? "engine-default") === "engine-default") {
    return { kind: "available", accountId: input.preferredId?.trim() || null };
  }
  const candidates = allowed === null
    ? [...input.accounts]
    : input.accounts.filter((account) => allowed.includes(account.id));
  /* A preference outside the allowed set only orders candidates, so dropping it
     changes the order and never the set — the set is the fence. */
  const preferred = allowed === null || (input.preferredId && allowed.includes(input.preferredId))
    ? input.preferredId ?? null
    : null;
  const selected = selectHeadlessAccount(
    candidates,
    [...input.observations],
    preferred,
    [...(input.excludedIds ?? [])],
    input.now,
  );
  if (selected.kind === "available") return selected;
  const consulted = allowed ?? candidates.map((account) => account.id);
  return selected.kind === "exhausted"
    ? { kind: "exhausted", resetsAt: selected.resetsAt, allowedAccountIds: consulted }
    : { kind: "unavailable", allowedAccountIds: consulted };
}

/**
 * The other shape of the same question, for the automatic paths that do not
 * get to CHOOSE an account: an engine-wide migration, and the lazy reseat onto
 * the engine's active account, both arrive with a target already decided
 * somewhere else and ask whether one particular piece of work may follow it.
 *
 * `selectProjectAccount` answers "which account may this work use"; this
 * answers "may this work use THAT one" — and both answer the second half,
 * capacity, from the same observations through the same classifier, so no
 * caller can end up with a different definition of having room. Being in the
 * pool is not the same as having capacity, and an automatic move onto a
 * confirmed-exhausted account is the second one failing while the first holds.
 *
 * Never substituted: the caller's whole operation is defined by that target, so
 * a target the project forbids or that has no room PARKS this work and leaves
 * everything else about the operation alone.
 */
export interface AutomaticAccountTargetInput {
  project: string | null;
  engine: BindingEngine;
  /** The account the machine already settled on, for everything at once. */
  targetId: string;
  observations: readonly DurableQuotaObservation[];
  bindings: readonly AccountProjectBinding[];
  now?: number;
}

export function admitAutomaticAccountTarget(input: AutomaticAccountTargetInput): ProjectAccountSelection {
  const allowed = allowedAccountIdsForProject(input.project, input.engine, input.bindings);
  const targetId = input.targetId.trim();
  if (allowed === null) {
    /* An UNBOUND project, which is every project until somebody configures one.
       Nobody drew a boundary here, so nothing is fenced and — exactly as in
       `selectProjectAccount`'s `engine-default` branch — no capacity
       arithmetic is introduced either. Adding one here would change what every
       migration on the machine does the day this ships, on projects that
       opted into nothing. */
    return { kind: "available", accountId: targetId };
  }
  if (!allowed.includes(targetId)) {
    return { kind: "not_allowed", accountId: targetId, allowedAccountIds: allowed };
  }
  const selected = selectHeadlessAccount(
    /* `authPresent` is asserted rather than read from a catalog on purpose:
       this seam judges CAPACITY, and the observation itself reports a signed
       out account as unavailable. Whether the target's home exists at all is
       the migration's own question and it answers it where it resolves the
       account, not here. */
    [{ id: targetId, authPresent: true }],
    [...input.observations],
    targetId,
    [],
    input.now,
  );
  if (selected.kind === "available") return { kind: "available", accountId: targetId };
  return selected.kind === "exhausted"
    ? { kind: "exhausted", resetsAt: selected.resetsAt, allowedAccountIds: allowed }
    : { kind: "unavailable", allowedAccountIds: allowed };
}
