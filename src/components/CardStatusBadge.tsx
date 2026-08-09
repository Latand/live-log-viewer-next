"use client";

import { useLocale, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { cardStatus, type CardStatus } from "./cardStatus";
import { humanizeDuration } from "./turnDuration";

/**
 * The board's one textual status word (issue #961): word plus colour, never
 * colour alone. One badge per card at most; a quiet card renders nothing.
 *
 * Tones reuse the existing semantic tokens: attention keeps the warning tone
 * the waiting cards already wear, held keeps the accent of the account-switch
 * surfaces, running keeps the success of the live treatments, and queued stays
 * muted. The only motion is the restrained attention breath on `needs-you`
 * (`card-status-attention`), disabled under prefers-reduced-motion. Text sits
 * at the 10px caption floor; a scaled host (the far-zoom label) passes its own
 * em-based size instead.
 */
const TONE: Record<CardStatus["kind"], string> = {
  "needs-you": "card-status-attention border-warning/50 bg-warning-soft text-warning",
  held: "border-accent/45 bg-accent-soft text-accent",
  running: "border-success/45 bg-success-soft text-success",
  queued: "border-border bg-canvas text-muted",
};

/** The status word (uppercased by the badge) and its detail, per kind. */
export function cardStatusText(t: TFunction, status: CardStatus): { word: string; detail: string | null } {
  if (status.kind === "needs-you") return { word: t("cardStatus.needsYou"), detail: null };
  if (status.kind === "held") return { word: t("cardStatus.held"), detail: `×${status.count}` };
  if (status.kind === "running") {
    return {
      word: t("cardStatus.running"),
      detail: status.elapsedSeconds === null ? null : humanizeDuration(status.elapsedSeconds),
    };
  }
  return { word: t("cardStatus.queued"), detail: null };
}

export function CardStatusBadge({ file, fontClassName = "text-caption" }: {
  file: FileEntry;
  /** Overrides the caption-floor font for hosts that scale in em (far label). */
  fontClassName?: string;
}) {
  const { t } = useLocale();
  const status = cardStatus(file);
  if (!status) return null;
  const { word, detail } = cardStatusText(t, status);
  const label = detail ? `${word} ${detail}` : word;
  return (
    <span
      data-card-status={status.kind}
      title={label}
      className={`inline-flex min-w-0 shrink-0 items-center gap-[0.35em] rounded-full border px-[0.6em] py-[0.15em] font-bold ${fontClassName} ${TONE[status.kind]}`}
    >
      <span className="truncate uppercase tracking-wide">{word}</span>
      {detail ? <span className="shrink-0 tabular-nums opacity-90">{detail}</span> : null}
    </span>
  );
}
