"use client";

import { getLocale, translate } from "@/lib/i18n";
import type { SelectedContextPreview } from "@/lib/selection/selectedContext";

import { Eye } from "./icons";

const tr = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(getLocale(), key, params);

/**
 * The one badge for "which card this turn points at" (#844 §render).
 *
 * Rendered in TWO places from this single component on purpose: in the composer
 * BEFORE the operator submits, and on the persisted transcript row afterwards.
 * Those are the two moments the operator can be wrong about what they pointed
 * at, and if the two surfaces rendered the reference differently the badge would
 * stop being evidence of anything. Same input, same pixels, same words.
 *
 * It is deliberately small and says one thing. What it never shows is the
 * selected card's transcript — there is none in the reference to show, which is
 * the design, not a rendering choice.
 *
 * What it renders, and what it deliberately does not:
 * - a selected card, named by its label or, failing that, by its identity;
 * - the same card struck through when the reference is stale — the view has
 *   moved on since capture, and that is shown, never silently corrected;
 * - NOTHING for an explicit empty selection (#1148). "I asked with nothing
 *   selected" stays a fact of the persisted reference and is still read from
 *   there, but a chip repeating it over every bare operator row is noise. The
 *   composer suppressed that chip already; the rule lives here now, in one
 *   place, so both surfaces stay identical by construction.
 */
export function SelectedContextBadge({
  reference,
  stale = false,
  className = "",
}: {
  /** A full `SelectedContextRef` satisfies this structurally, so the composer
      preview and the persisted transcript record render through one path. */
  reference: SelectedContextPreview | null;
  /** The view has moved on since capture — shown, never silently corrected. */
  stale?: boolean;
  className?: string;
}) {
  if (!reference || reference.state !== "selected") return null;
  /* A selected variant with no canonical identity names no card: parsing
     rejects one, and a preview that has neither label nor id says nothing. */
  const name = reference.label || reference.conversationId;
  if (!name) return null;
  /* The accessible name carries the whole sentence — role, card, project and
     staleness — because the visible chip is a fragment by design and a screen
     reader must not have to assemble it from neighbouring pixels. */
  const described = tr("selectedContext.ariaSelected", { name, project: reference.project ?? "—" });
  const label = stale ? `${described} — ${tr("selectedContext.stale")}` : described;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-tight ${
        stale ? "bg-sunken text-muted line-through decoration-1" : "bg-sunken text-secondary"
      } ${className}`}
      aria-label={label}
      title={label}
      data-selected-context={reference.state}
      {...(stale ? { "data-selected-context-stale": "true" } : {})}
    >
      <Eye className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
