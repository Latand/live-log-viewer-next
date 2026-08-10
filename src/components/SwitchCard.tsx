"use client";

import { CornerDownRight } from "lucide-react";

import { X } from "@/components/icons";
import { projectDisplayName } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { AccountSwitchChip, CardIdentityChip } from "./cardAnatomy";
import { CardStatusBadge } from "./CardStatusBadge";
import { EffortPills } from "./EffortPills";
import { CtxChip } from "./PlanChip";
import { ProcessStatusControls } from "./TaskHeader";
import { RateLimitBadge } from "./RateLimitBadge";
import { WakeupChip, wakeupChipKey } from "./WakeupChip";
import { activityDot, cleanTitle, fmtAge } from "./utils";

export type SwitchCardSize = "large" | "small";
export type SwitchCardTone = "waiting" | "stalled" | "working" | "quiet";

interface Props {
  file: FileEntry;
  title: string;
  project: string;
  currentProject: string;
  descendants: number;
  statusLine: string;
  size: SwitchCardSize;
  tone: SwitchCardTone;
  onOpen: (file: FileEntry) => void;
  onArchive: (file: FileEntry) => void;
}

/*
 * Issue #700: the emphasis used to run the wrong way — a "working" card, which
 * needs nothing from the operator, carried the halo ring while the two tones
 * that are BLOCKED ON THE OPERATOR (an unanswered question, an interrupted run)
 * got a plain border. The ring now marks what needs attention; routine activity
 * keeps its tint and drops to the quiet treatment.
 */
function toneClass(tone: SwitchCardTone): string {
  if (tone === "stalled") return "border-danger/45 bg-danger-soft shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_18%,transparent)]";
  if (tone === "waiting") return "border-warning/55 bg-warning-soft shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-warning)_18%,transparent)]";
  if (tone === "working") return "border-success/40 bg-success-soft";
  return "border-border bg-card";
}

/** The status line takes the tone's own color when the tone means "you". */
function statusToneClass(tone: SwitchCardTone): string {
  if (tone === "stalled") return "text-danger";
  if (tone === "waiting") return "text-warning";
  return "text-primary/75";
}

export function SwitchCard({ file, title, project, currentProject, descendants, statusLine, size, tone, onOpen, onArchive }: Props) {
  const { t } = useLocale();
  const large = size === "large";
  return (
    <article
      /* reasoning-host (issue #270): the card's width is an explicit constant,
         so the container query costs nothing — small (220px) cards collapse the
         effort meter below the 260px threshold; the tier stays readable in the
         model chip's tooltip. */
      /* Small cards hold the same three-row anatomy as large ones, so their
         fixed height budgets a two-line title + the ops row + the status line
         without clipping (#964). */
      className={`reasoning-host group relative flex ${large ? "h-[150px] w-[300px]" : "h-[128px] w-[220px]"} shrink-0 flex-col rounded-[8px] border p-3 shadow-1 transition-colors hover:border-accent/45 ${toneClass(tone)}`}
      role="button"
      tabIndex={0}
      aria-label={t("switchCard.openColumn", { title: cleanTitle(title, 80) })}
      onClick={() => onOpen(file)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(file);
      }}
    >
      {file.activity === "live" ? null : (
        <button
          type="button"
          className="absolute right-1.5 top-1.5 z-10 hidden h-5 w-5 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:border-danger/50 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover:flex group-focus-within:flex"
          aria-label={t("switchCard.remove")}
          onClick={(event) => {
            event.stopPropagation();
            onArchive(file);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
      {/* Fixed anatomy (issue #964): identity/status row — activity, ONE
          identity treatment (model or engine; effort rides beside it and in the
          tooltip), the #961 status word, and where the card lives. */}
      <div data-card-row="identity" className="relative flex min-w-0 items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`} />
        <CardIdentityChip file={file} />
        <EffortPills file={file} />
        {/* The operator-facing status word (issue #961): same vocabulary and
            tones as the board cards, so a switch column reads identically. */}
        <CardStatusBadge file={file} />
        <span
          className={`ml-auto min-w-0 truncate rounded-full border border-border bg-canvas px-1.5 py-0.5 text-[9.5px] font-semibold ${
            project === currentProject ? "text-muted" : "text-primary"
          }`}
          title={project}
        >
          {projectDisplayName(project, file.projectName)}
        </span>
      </div>
      {/* Content row: the title keeps its two lines whatever the card's
          operational state — chips never crowd into this row. */}
      <div data-card-row="content" className={`relative mt-2 min-w-0 ${large ? "text-[14px]" : "text-[12.5px]"} font-bold leading-snug`} title={title}>
        <span className={large ? "line-clamp-2" : "line-clamp-2"}>{title}</span>
      </div>
      {/* Ops row: recency always anchors it; account/switch, rate limit and
          wakeup join only when non-default, so a quiet card's row stays bare.
          The chips are shrink participants: in a fully mixed state each gives
          up label width (icon + tone + ellipsis stay) rather than pushing the
          facts after it out of the clipped row — every fact stays visible on
          the card and complete in its title. */}
      <div data-card-row="ops" className="relative mt-auto flex min-w-0 items-center gap-1.5 overflow-hidden text-[10.5px] font-semibold text-muted">
        <span className="shrink-0">{fmtAge(file.mtime)}</span>
        {file.ctx ? <CtxChip ctx={file.ctx} /> : null}
        {descendants ? (
          <span className="inline-flex shrink-0 items-center gap-0.5">
            <CornerDownRight className="h-3 w-3" aria-hidden /> {descendants}
          </span>
        ) : null}
        <AccountSwitchChip file={file} />
        <RateLimitBadge file={file} shrinkable />
        <WakeupChip key={wakeupChipKey(file.pendingWakeup)} wakeup={file.pendingWakeup} shrinkable />
      </div>
      {statusLine ? (
        <div
          className={`relative mt-1 min-w-0 truncate font-semibold ${
            tone === "waiting" || tone === "stalled" ? (large ? "text-[12.5px]" : "text-[11.5px]") : large ? "text-[11.5px]" : "text-[10.5px]"
          } ${statusToneClass(tone)}`}
          data-tone={tone}
        >
          {statusLine}
        </div>
      ) : null}
      {file.pid && file.proc === "running" ? (
        <div className="relative mt-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <ProcessStatusControls file={file} compact />
        </div>
      ) : null}
    </article>
  );
}
