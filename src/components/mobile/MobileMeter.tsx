"use client";

/*
 * The one meter (docs/design/mobile-v2/README.md §5): its fill is what
 * remains, coloured by what remains — accent above 30 %, warning at or under
 * 30 %, danger at or under 10 %. Context reads «76 % left of 100k»; an
 * account window reads «38 % left / Week». Every phone surface that shows a
 * remaining quantity renders this, so the two meanings a meter used to carry
 * (used vs. left) cannot come back.
 */

export type MeterTone = "accent" | "warning" | "danger";

export const METER_WARNING_AT = 30;
export const METER_DANGER_AT = 10;

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Colour by what remains. */
export function meterTone(left: number): MeterTone {
  const pct = clampPercent(left);
  if (pct <= METER_DANGER_AT) return "danger";
  if (pct <= METER_WARNING_AT) return "warning";
  return "accent";
}

const FILL: Record<MeterTone, string> = {
  accent: "bg-accent",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function MobileMeter({
  left,
  label,
  className = "",
}: {
  /** Percent remaining, 0–100. */
  left: number;
  /** What the meter measures, for assistive readers. */
  label?: string;
  className?: string;
}) {
  const pct = clampPercent(left);
  const tone = meterTone(pct);
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
      data-mobile2-meter
      data-mobile2-meter-tone={tone}
      className={`block h-[5px] w-full overflow-hidden rounded-[3px] border border-border bg-sunken ${className}`}
    >
      <span data-mobile2-meter-fill className={`block h-full rounded-[3px] ${FILL[tone]}`} style={{ width: `${pct}%` }} />
    </span>
  );
}
