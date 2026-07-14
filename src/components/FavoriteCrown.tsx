"use client";

import { Crown } from "lucide-react";

import { useProximity } from "@/hooks/useProximity";
import { useLocale } from "@/lib/i18n";

import { useFavorites } from "./favorites/FavoritesContext";

/* How close (screen px) the pointer must come to the card before the dashed
   crown fades in. Generous on purpose — the issue asks for a proximity zone
   around the whole card, not a hover on the icon itself. */
export const PROXIMITY_RADIUS = 88;

/**
 * The crown favorite control (issue #185). Idle it is invisible; the pointer
 * nearing the card fades in a dashed gray outline; hovering the crown previews
 * a filled state; a click commits the favorite (a lit gold crown that stays
 * lit, proximity-independent). On touch it is always visible at a 44px target.
 *
 * Renders nothing outside a `FavoritesProvider` (no board to persist to) or
 * without a stable id.
 */
export function FavoriteCrown({
  id,
  cardRef,
  touch = false,
}: {
  /** Durable conversation identity — `conversationIdentity(file)`. */
  id: string;
  /** The card element the proximity zone measures from. */
  cardRef: React.RefObject<HTMLElement | null>;
  /** Touch device: always-visible crown, 44px hit target, no hover preview. */
  touch?: boolean;
}) {
  const favorites = useFavorites();
  const { t } = useLocale();
  const favorited = favorites?.has(id) ?? false;
  /* Only pay for a proximity subscription while the crown is hidden and could
     reveal — a favorited or touch crown is already shown. */
  const near = useProximity(cardRef, PROXIMITY_RADIUS, !touch && !favorited);
  if (!favorites) return null;

  const visible = favorited || touch || near;
  const label = t(favorited ? "branch.unfavorite" : "branch.favorite");
  return (
    <button
      type="button"
      data-scheme-ui
      data-favorite-crown={favorited ? "on" : "off"}
      aria-pressed={favorited}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        favorites.toggle(id);
      }}
      className={`favorite-crown group/crown inline-flex shrink-0 items-center justify-center rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        touch ? "h-11 w-11" : "h-6 w-6"
      } ${visible ? "opacity-100" : "pointer-events-none opacity-0"} ${favorited ? "is-favorite" : ""}`}
    >
      <Crown
        aria-hidden
        className={`${touch ? "h-5 w-5" : "h-4 w-4"} transition-[color,fill,filter,transform] duration-200 ${
          favorited
            ? "fill-warning text-warning drop-shadow-[0_0_5px_color-mix(in_srgb,var(--color-warning)_65%,transparent)]"
            : "text-muted [stroke-dasharray:2_3] group-hover/crown:fill-warning group-hover/crown:text-warning group-hover/crown:[stroke-dasharray:0]"
        }`}
      />
    </button>
  );
}
