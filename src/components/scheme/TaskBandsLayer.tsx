"use client";

import { memo } from "react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { CardStatusBadge } from "@/components/CardStatusBadge";
import { TASK_TONES } from "@/components/tasks/taskModel";
import { cleanTitle } from "@/components/utils";

import type { SchemeRect } from "./layout";
import { BAND, type BandMirror, type BandMode, type PlacedBand } from "./taskBands";

/**
 * Band chrome of the task-centered board (#1586): one full-width surface per
 * task with a screen-constant header (title, status, working/unknown counts,
 * Details, local «+ Agent»), reference tiles for conversations whose reader
 * lives in another band, and the «+ Agent» target after the last member. Nodes,
 * slots, decks and drafts inside the band are drawn by the existing layers at
 * the rectangles the band layout assigned them.
 *
 * Everything the operator reads is sized in CSS pixels and counter-scaled by
 * `scale` (1 / zoom), so zoom changes density, never legibility.
 */
export const TaskBandsLayer = memo(function TaskBandsLayer({
  bands,
  mode,
  scale,
  interactive,
  selectedKey,
  mirrorRects,
  onAddAgent,
  onOpenDetails,
  onCycleStatus,
  onSelectMirror,
}: {
  bands: PlacedBand[];
  mode: BandMode;
  scale: number;
  /** Passive on the hand tool and during a selection session. */
  interactive: boolean;
  selectedKey: string | null;
  mirrorRects: ReadonlyMap<string, SchemeRect>;
  onAddAgent: (band: PlacedBand) => void;
  onOpenDetails: (band: PlacedBand) => void;
  onCycleStatus: (task: BoardTask) => void;
  onSelectMirror: (mirror: BandMirror) => void;
}) {
  const { t } = useLocale();
  if (!bands.length) return null;
  const screen = (rect: SchemeRect) => ({ width: rect.w / scale, height: rect.h / scale, transform: `scale(${scale})`, transformOrigin: "top left" as const });
  return (
    <div aria-hidden={false} data-scheme-bands={mode}>
      {bands.map((band) => {
        const { rect, header, addAgent } = band.geometry;
        const color = `hsl(${band.hue} 58% 44%)`;
        const derivedLabel = band.origin === "pipeline"
          ? t("bands.derivedPipeline")
          : band.origin === "flow"
            ? t("bands.derivedFlow")
            : band.origin === "conversation"
              ? t("bands.derivedConversation")
              : band.origin === "draft"
                ? t("bands.derivedDraft")
                : null;
        const selectedInside = selectedKey !== null && (band.members.some((member) => member.key === selectedKey) || band.mirrors.some((mirror) => mirror.ofKey === selectedKey));
        /* Keyboard navigation lands on the band itself through its task key. */
        const headerRinged = selectedKey !== null && (selectedKey === `band::${band.id}` || (band.task !== null && selectedKey === `task::${band.task.id}`));
        return (
          <div
            key={band.id}
            data-scheme-band={band.id}
            data-scheme-band-origin={band.origin}
            data-scheme-band-task={band.task?.id ?? undefined}
            data-scheme-band-working={band.working}
            data-scheme-band-selected={selectedInside ? "true" : undefined}
            className="pointer-events-none absolute"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          >
            {/* Quiet surface: hairline boundary tinted by the band hue, a
                faint well fill, small radius. Selection is a slightly firmer
                boundary, never a filled highlight over readers. */}
            <div
              aria-hidden
              className="absolute inset-0 rounded-[6px] border"
              style={{
                borderColor: `color-mix(in srgb, ${color} ${selectedInside ? 55 : 26}%, var(--border-default))`,
                backgroundColor: `color-mix(in srgb, ${color} 3.5%, var(--surface-well))`,
                borderWidth: Math.max(1, scale),
              }}
            />
            <div
              aria-hidden
              className="absolute left-0 top-0 rounded-l-[6px]"
              style={{ width: Math.max(3 * scale, 1), height: rect.h, backgroundColor: color, opacity: band.working ? 0.9 : 0.35 }}
            />
            {/* Header, screen-constant. */}
            <div
              data-scheme-ui
              data-scheme-band-header={band.id}
              className={`absolute left-0 top-0 flex items-center gap-3 px-4 text-ui ${headerRinged ? "rounded-[6px] ring-2 ring-accent/60 ring-inset" : ""}`}
              style={screen(header)}
            >
              <button
                type="button"
                data-scheme-band-title
                disabled={!interactive}
                className={`min-w-0 truncate text-left text-[13px] font-semibold text-primary ${interactive ? "pointer-events-auto hover:text-accent" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default`}
                style={{ maxWidth: "46%" }}
                title={band.title}
                onClick={() => onOpenDetails(band)}
              >
                {band.title}
              </button>
              {band.task ? (
                <button
                  type="button"
                  data-scheme-band-status={band.task.status}
                  disabled={!interactive}
                  className={`shrink-0 rounded-full px-2 py-[1px] text-[11px] font-semibold ${interactive ? "pointer-events-auto hover:opacity-85" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default`}
                  style={{ backgroundColor: TASK_TONES[band.task.status].soft, color: TASK_TONES[band.task.status].color }}
                  title={t("tasks.statusTitle", { label: t(`tasks.status.${band.task.status}`) })}
                  onClick={() => onCycleStatus(band.task!)}
                >
                  {t(`tasks.status.${band.task.status}`)}
                </button>
              ) : null}
              {derivedLabel ? <span className="shrink-0 truncate text-[11px] text-muted">{derivedLabel}</span> : null}
              {band.task && !band.task.text.trim() ? <span className="shrink-0 text-[11px] text-muted">{t("bands.namePending")}</span> : null}
              <span data-scheme-band-counts className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-secondary">
                <span className={band.working ? "font-semibold text-success" : ""}>{t("bands.working", { count: band.working })}</span>
                {band.unknown ? <span className="text-warning"> · {t("bands.unknown", { count: band.unknown })}</span> : null}
                <span className="text-muted"> · {t("bands.conversations", { count: band.conversations })}</span>
                {band.planned ? <span className="text-muted"> · {t("bands.planned", { count: band.planned })}</span> : null}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  data-scheme-band-details
                  disabled={!interactive}
                  className={`h-7 rounded-[8px] border border-border bg-card px-2.5 text-[11px] font-semibold text-muted shadow-1 ${interactive ? "pointer-events-auto hover:border-accent/45 hover:text-accent" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default`}
                  onClick={() => onOpenDetails(band)}
                >
                  {t("bands.details")}
                </button>
                {mode === "overview" ? (
                  <button
                    type="button"
                    data-scheme-band-add={band.id}
                    aria-label={t("bands.addAgentAria", { title: band.title })}
                    disabled={!interactive}
                    className={`inline-flex h-7 items-center gap-1 rounded-[8px] border border-border bg-card px-2.5 text-[11px] font-bold text-primary shadow-1 ${interactive ? "pointer-events-auto hover:border-accent/45 hover:text-accent" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default`}
                    onClick={() => onAddAgent(band)}
                  >
                    <span className="text-[13px] leading-none text-accent">+</span> {t("dash.agent")}
                  </button>
                ) : null}
              </div>
            </div>
            {/* Reference tiles for conversations whose reader is in another band. */}
            {band.mirrors.map((mirror) => {
              const tile = mirrorRects.get(mirror.key);
              if (!tile) return null;
              const chip = mode === "overview";
              return (
                <button
                  key={mirror.key}
                  type="button"
                  data-scheme-ui
                  data-scheme-mirror={mirror.ofKey}
                  data-scheme-mirror-band={band.id}
                  disabled={!interactive}
                  title={t("bands.sameConversation", { title: mirror.primaryTitle })}
                  className={`absolute rounded-[8px] border border-dashed border-border bg-card/80 text-left shadow-1 ${interactive ? "pointer-events-auto hover:border-accent/45" : ""} ${selectedKey === mirror.ofKey ? "ring-2 ring-accent/60" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default`}
                  style={{ left: tile.x - rect.x, top: tile.y - rect.y, width: tile.w, height: tile.h }}
                  onClick={() => onSelectMirror(mirror)}
                >
                  <div className={`absolute left-0 top-0 flex ${chip ? "items-center gap-2 px-2.5" : "flex-col justify-center gap-1 px-3"} text-ui`} style={screen(tile)}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">{cleanTitle(mirror.file.title, 60)}</span>
                      <CardStatusBadge file={mirror.file} />
                    </div>
                    {chip ? null : <span className="truncate text-[11px] text-muted">{t("bands.sameConversation", { title: mirror.primaryTitle })}</span>}
                  </div>
                </button>
              );
            })}
            {/* Local «+ Agent», right after the last member (or the next row). */}
            {mode === "overview" ? null : (
              <button
                type="button"
                data-scheme-ui
                data-scheme-band-add={band.id}
                aria-label={t("bands.addAgentAria", { title: band.title })}
                disabled={!interactive}
                className={`absolute rounded-[8px] border border-dashed border-border bg-card/70 ${interactive ? "pointer-events-auto hover:border-accent/45 hover:bg-card" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default`}
                style={{ left: addAgent.x - rect.x, top: addAgent.y - rect.y, width: addAgent.w, height: addAgent.h }}
                onClick={() => onAddAgent(band)}
              >
                <div className="absolute left-0 top-0 flex items-center justify-center gap-1 text-[11.5px] font-bold text-primary" style={{ width: BAND.addW, height: BAND.addH, transform: `scale(${scale})`, transformOrigin: "top left" }}>
                  <span className="text-[14px] leading-none text-accent">+</span> {t("dash.agent")}
                </div>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
});
