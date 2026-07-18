"use client";

import { CornerDownRight } from "lucide-react";

import { X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { EffortPills } from "./EffortPills";
import { CtxChip } from "./PlanChip";
import { ProcessStatusControls } from "./TaskHeader";
import { RateLimitBadge } from "./RateLimitBadge";
import { WakeupChip, wakeupChipKey } from "./WakeupChip";
import { activityDot, cleanTitle, effortTint, effortTitle, engineBadge, fmtAge } from "./utils";

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

function toneClass(tone: SwitchCardTone): string {
  if (tone === "working") return "border-success/40 bg-success-soft shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-success)_16%,transparent)]";
  if (tone === "stalled") return "border-danger/35 bg-danger-soft";
  if (tone === "waiting") return "border-warning/45 bg-warning-soft";
  return "border-border bg-card";
}

export function SwitchCard({ file, title, project, currentProject, descendants, statusLine, size, tone, onOpen, onArchive }: Props) {
  const { t } = useLocale();
  const badge = engineBadge(file);
  const large = size === "large";
  return (
    <article
      /* reasoning-host (issue #270): the card's width is an explicit constant,
         so the container query costs nothing — small (220px) cards collapse the
         effort meter below the 260px threshold; the tier stays readable in the
         model chip's tooltip. */
      className={`reasoning-host group relative flex ${large ? "h-[150px] w-[300px]" : "h-[108px] w-[220px]"} shrink-0 flex-col rounded-[8px] border p-3 shadow-1 transition-colors hover:border-accent/45 ${toneClass(tone)}`}
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
      <div className="relative flex min-w-0 items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`} />
        {/* One identity chip: the model when known (engine lives in the tint
            and the tooltip), the engine label as fallback. */}
        {file.model ? (
          <span
            className="min-w-0 truncate rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold"
            style={{ backgroundColor: effortTint(file).soft, color: effortTint(file).color }}
            title={[badge.label, effortTitle(file)].filter(Boolean).join(" · ")}
          >
            {file.model}
          </span>
        ) : (
          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold" style={badge.style} title={effortTitle(file)}>{badge.label}</span>
        )}
        <EffortPills file={file} />
        <RateLimitBadge rateLimit={file.rateLimit} />
        <WakeupChip key={wakeupChipKey(file.pendingWakeup)} wakeup={file.pendingWakeup} />
        <span
          className={`ml-auto min-w-0 truncate rounded-full border border-border bg-canvas px-1.5 py-0.5 text-[9.5px] font-semibold ${
            project === currentProject ? "text-muted" : "text-primary"
          }`}
          title={project}
        >
          {project}
        </span>
      </div>
      <div className={`relative mt-2 min-w-0 ${large ? "text-[14px]" : "text-[12.5px]"} font-bold leading-snug`} title={title}>
        <span className={large ? "line-clamp-2" : "line-clamp-2"}>{title}</span>
      </div>
      <div className="relative mt-auto flex min-w-0 items-center gap-2 text-[10.5px] font-semibold text-muted">
        <span className="shrink-0">{fmtAge(file.mtime)}</span>
        {file.ctx ? <CtxChip ctx={file.ctx} /> : null}
        {descendants ? (
          <span className="inline-flex shrink-0 items-center gap-0.5">
            <CornerDownRight className="h-3 w-3" aria-hidden /> {descendants}
          </span>
        ) : null}
      </div>
      {statusLine ? (
        <div className={`relative mt-1 min-w-0 truncate ${large ? "text-[11.5px]" : "text-[10.5px]"} font-semibold text-primary/75`}>
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
