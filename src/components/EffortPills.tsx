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
 * Layout contract (issue #270): the meter is a plain in-flow flex item — it
 * occupies exactly the space flexbox reserves for it and never paints outside
 * that box. The old `scale(var(--inv-z))` counter-zoom grew the bars visually
 * while their flex slot stayed 11px, so on the scheme board they stacked over
 * the neighboring model/effort cluster; far-zoom identity is FarLabel's job
 * (LABEL_Z takeover), so the meter renders at its natural size everywhere and
 * wraps/scrolls/truncates with its host row like any sibling chip. The
 * `reasoning-slot` class lets width-capped hosts that declare the
 * `reasoning-host` container (globals.css) collapse the meter below their
 * threshold instead of crowding it.
 */
export function EffortPills({ file }: { file: FileEntry }) {
  const { level, slots } = effortMeter(file);
  if (!level) return null;
  const { color } = effortTint(file);
  const title = effortTitle(file);
  return (
    <span
      data-effort-pills
      className="reasoning-slot inline-flex h-[12px] shrink-0 items-end gap-px"
      role="img"
      aria-label={title}
      title={title}
    >
      {Array.from({ length: slots }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="shrink-0 rounded-full"
          style={{
            width: "3px",
            height: `${7 + i}px`,
            backgroundColor: i < level ? color : "var(--color-border)",
          }}
        />
      ))}
    </span>
  );
}
