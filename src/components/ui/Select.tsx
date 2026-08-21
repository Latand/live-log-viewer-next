"use client";

import type { SelectHTMLAttributes } from "react";

/**
 * The design system's ONE select recipe (issue #221 §6): every dropdown in the
 * builder — role, role params, engine-adjacent runtime pickers (model, effort,
 * speed), account — renders this exact face so the controls read as one
 * family. Tokens only; sizing leaves room for a 44px hit area on touch via the
 * surrounding row.
 */
export const SELECT_RECIPE =
  "h-7 min-w-0 rounded-control border border-border bg-card px-1.5 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";

/** The same face at the design system's 32px control height (§2 «visual height
    32px»), for surfaces whose controls carry the composition rather than ride a
    dense strip — the orchestrator dock's full-height draft column (issue #977).
    Same tokens, same states; only height, padding and type step change. */
export const SELECT_RECIPE_ROOMY =
  "h-8 min-w-0 rounded-control border border-border bg-card px-2 text-body text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";

export function Select({ roomy, className, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { roomy?: boolean }) {
  const recipe = roomy ? SELECT_RECIPE_ROOMY : SELECT_RECIPE;
  return <select {...rest} className={className ? `${recipe} ${className}` : recipe} />;
}
