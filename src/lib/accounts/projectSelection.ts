import { selectHeadlessAccount } from "./headlessSelection";
import type { DurableQuotaObservation } from "./migration/contracts";
import {
  allowedAccountIdsForProject,
  type AccountProjectBinding,
  type BindingEngine,
} from "./projectBindings";

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
