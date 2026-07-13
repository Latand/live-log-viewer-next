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
 */
export function EffortPills({ file }: { file: FileEntry }) {
  const { level, slots } = effortMeter(file);
  if (!level) return null;
  const { color } = effortTint(file);
  const title = effortTitle(file);
  return (
    <span
      className="inline-flex h-[12px] shrink-0 items-end gap-px"
      role="img"
      aria-label={title}
      title={title}
      style={{ transform: "scale(clamp(1, var(--inv-z, 1), 5))", transformOrigin: "left bottom" }}
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
