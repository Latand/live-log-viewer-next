import type { FileEntry } from "@/lib/types";

import { effortMeter, effortTint, effortTitle } from "./utils";

/**
 * Slim vertical pills next to a model chip — one slot per tier of the entry's
 * own engine+model reasoning scale, filled up to the recorded tier (lowest
 * tier = one bar, top tier fills the meter). The filled bars carry the same
 * effort-shifted tint as the chip so the two read as one identity unit; empty
 * slots stay faint. Renders nothing when no reliable effort exists, keeping the
 * chip exactly as it looks today. The tier reads out through the shared
 * `util.effortTitle` tooltip with no visible label.
 *
 * In-flow slot (issue #270): every dimension is in em off one font-size that
 * follows the board's inverse zoom, so the meter's layout box always equals its
 * visual box and the flex row reserves real space — a scale() transform here
 * used to blow the bars up over the neighboring model chip inside a zoomed-out
 * scheme node while the row still laid out the tiny unscaled box. The zoom cap
 * matches the 2.6× ceiling every other in-world text uses; past it the node's
 * FarLabel is the identity anyway. When the identity row gets too narrow to
 * seat the meter beside its chips (small switch cards, skinny panes), the slot
 * collapses entirely via container query instead of colliding — the tier stays
 * reachable through the model chip's tooltip.
 */
export function EffortPills({ file }: { file: FileEntry }) {
  const { level, slots } = effortMeter(file);
  if (!level) return null;
  const { color } = effortTint(file);
  const title = effortTitle(file);
  return (
    <span
      data-effort-slot
      className="inline-flex h-[1.2em] shrink-0 items-end gap-[0.1em] @max-[240px]:hidden"
      role="img"
      aria-label={title}
      title={title}
      style={{ fontSize: "calc(10px * min(var(--inv-z, 1), 2.6))" }}
    >
      {Array.from({ length: slots }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="shrink-0 rounded-full"
          style={{
            width: "0.3em",
            height: `${(7 + i) / 10}em`,
            backgroundColor: i < level ? color : "var(--color-border)",
          }}
        />
      ))}
    </span>
  );
}
