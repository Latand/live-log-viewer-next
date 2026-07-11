import type { AccountContext, HeadlessSpawnAvailability } from "@/lib/accounts/contracts";

import type { RoleConfig } from "./types";

export type HeadlessReviewerDecision =
  | { kind: "available"; role: RoleConfig; account: AccountContext }
  | { kind: "exhausted"; resetsAt: number | null }
  | { kind: "unavailable" };

type AvailabilityResolver = (
  engine: RoleConfig["engine"],
  requestedId?: string | null,
  excludedIds?: string[],
) => HeadlessSpawnAvailability;

/** Chooses the primary reviewer when capacity exists, then its configured fallback. */
export function chooseHeadlessReviewer(
  primary: RoleConfig,
  fallback: RoleConfig | null | undefined,
  attemptedAccounts: string[],
  resolve: AvailabilityResolver,
): HeadlessReviewerDecision {
  const roles = [primary, ...(fallback && fallback.engine !== primary.engine ? [fallback] : [])];
  const exhaustedResets: number[] = [];
  let attemptedChoice: Extract<HeadlessReviewerDecision, { kind: "available" }> | null = null;
  let exhausted = 0;
  for (const role of roles) {
    const prefix = `${role.engine}:`;
    const excludedIds = attemptedAccounts.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    const availability = resolve(role.engine, null, excludedIds);
    if (availability.kind === "available") {
      const choice = { kind: "available" as const, role, account: availability.account };
      if (!attemptedAccounts.includes(`${availability.account.engine}:${availability.account.accountId}`)) return choice;
      attemptedChoice ??= choice;
      continue;
    }
    if (availability.kind === "exhausted") {
      exhausted += 1;
      if (availability.resetsAt !== null) exhaustedResets.push(availability.resetsAt);
    }
  }
  if (attemptedChoice) return attemptedChoice;
  if (exhausted !== roles.length) return { kind: "unavailable" };
  return { kind: "exhausted", resetsAt: exhaustedResets.length ? Math.min(...exhaustedResets) : null };
}

export function rateLimitStateDetail(resetsAt: number | null): string {
  const reset = resetsAt === null ? "unknown" : new Date(resetsAt * 1_000).toISOString();
  return `reviewer rate limited; all accounts exhausted; resetsAt=${reset}`;
}
