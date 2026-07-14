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

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={className ? `${SELECT_RECIPE} ${className}` : SELECT_RECIPE} />;
}
