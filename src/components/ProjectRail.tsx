"use client";

import { useMemo, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { AccessQrButton } from "./AccessQrButton";
import { FlipRow } from "./FlipRow";
import { Archive, ChevronRight, Loader2 } from "./icons";
import { LanguageToggle } from "./LanguageToggle";
import { LimitsFooter } from "./LimitsFooter";
import { buildProjectSummaries, OVERVIEW } from "./projectModel";
import { PushBell } from "./PushBell";
import { ResourcesFooter } from "./ResourcesFooter";
import { fmtAge } from "./utils";

interface Props {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  pipelines: Pipeline[];
  /** Active workflows: their stamped projects stay listed even while no
      transcript of theirs exists yet. */
  workflows: Workflow[];
  /** Shelved projects: pulled out of the main list into the archive section. */
  archivedProjects: ReadonlySet<string>;
  selected: string;
  loaded: boolean;
  /** Attention clock owned by Viewer — advances when a stalled entry crosses
      its TTL, so the rail badges expire together with the queue. */
  now: number;
  onSelect: (project: string) => void;
}

export function ProjectRail({ files, projectCatalog, pipelines, workflows, archivedProjects, selected, loaded, now, onSelect }: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const summaries = useMemo(() => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines), [files, now, workflows, projectCatalog, pipelines]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? summaries.filter((summary) => summary.project.toLowerCase().includes(q)) : summaries;
  }, [summaries, query]);
  const activeRows = useMemo(() => visible.filter((summary) => !archivedProjects.has(summary.project)), [visible, archivedProjects]);
  const archivedRows = useMemo(() => visible.filter((summary) => archivedProjects.has(summary.project)), [visible, archivedProjects]);
  const totalLive = useMemo(() => summaries.reduce((sum, s) => sum + s.liveCount, 0), [summaries]);
  const totalAttention = useMemo(() => summaries.reduce((sum, s) => sum + s.attentionCount, 0), [summaries]);

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-line bg-panel">
      <header
        className={`flex shrink-0 items-center gap-2 border-b border-line text-[13.5px] font-bold ${
          isMobile ? "min-h-[52px] gap-1.5 px-2 py-1.5" : "h-10 px-4"
        }`}
      >
        {isMobile ? (
          /* The 248px drawer header must hold three 44px controls no matter how
             wide the badges grow (issue #148). Title + both status badges live in
             one min-w-0 flex-1 group that shrinks (title truncates first); the
             controls sit in a shrink-0 group so they can never be pushed outside.
             The group is overflow-hidden so even the capped `99+`/`99+` maximum can
             only clip within its own share, never bleed into the controls — and
             the badges are compact (no live dot, tight padding, tabular-nums) so
             that maximum still fits without clipping in the ~86px it is allotted. */
          <>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              <span className="min-w-0 truncate">{t("rail.title")}</span>
              {totalLive ? (
                <span className="inline-flex shrink-0 items-center rounded-full bg-[#e5f6ea] px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-ok">
                  {totalLive > 99 ? "99+" : totalLive}
                </span>
              ) : null}
              {totalAttention ? (
                <span className="inline-flex shrink-0 items-center rounded-full bg-[#fff1ca] px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-[#8a5a00]">
                  ⏸{totalAttention > 99 ? "99+" : totalAttention}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <LanguageToggle />
              <AccessQrButton />
              <PushBell />
            </div>
          </>
        ) : (
          <>
            <span>{t("rail.title")}</span>
            {totalLive ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#e5f6ea] px-2 py-0.5 text-[10.5px] font-bold text-ok">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
                {totalLive}
              </span>
            ) : null}
            {totalAttention ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#fff1ca] px-2 py-0.5 text-[10.5px] font-bold text-[#8a5a00]">
                ⏸ {totalAttention}
              </span>
            ) : null}
            <LanguageToggle />
            <AccessQrButton />
            <PushBell />
          </>
        )}
      </header>
      <div className="px-2.5 pb-1 pt-2.5">
        <input
          className={`w-full rounded-[9px] border border-line bg-bg px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "min-h-11" : "py-1.5"
          }`}
          placeholder={t("rail.filter")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3 pt-1" aria-label={t("rail.projects")}>
        <RailRow
          label={t("rail.overview")}
          live={0}
          attention={0}
          total={null}
          age=""
          active={selected === OVERVIEW}
          hasLive={false}
          onClick={() => onSelect(OVERVIEW)}
        />
        <div className="mx-2.5 my-1.5 border-t border-line" />
        <FlipRow>
          {activeRows.map((summary) => (
            <div key={summary.project} data-flip-key={summary.project}>
              <RailRow
                label={summary.project}
                live={summary.liveCount}
                attention={summary.attentionCount}
                total={summary.conversations}
                age={fmtAge(summary.smt)}
                active={selected === summary.project}
                hasLive={summary.liveCount > 0}
                muted={summary.catalogOnly}
                onClick={() => onSelect(summary.project)}
              />
            </div>
          ))}
        </FlipRow>
        {archivedRows.length ? (
          <>
            <div className="mx-2.5 my-1.5 border-t border-line" />
            <button
              type="button"
              className={`mb-0.5 flex w-full items-center gap-1.5 rounded-[10px] px-2.5 text-left text-[11.5px] font-bold text-dim hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                isMobile ? "min-h-11" : "py-1.5"
              }`}
              aria-expanded={archiveOpen}
              onClick={() => setArchiveOpen((value) => !value)}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${archiveOpen ? "rotate-90" : ""}`} aria-hidden />
              <Archive className="h-3 w-3 shrink-0" aria-hidden />
              {t("rail.archive")}
              <span className="font-semibold">{archivedRows.length}</span>
            </button>
            {archiveOpen
              ? archivedRows.map((summary) => (
                  <RailRow
                    key={summary.project}
                    label={summary.project}
                    live={summary.liveCount}
                    attention={summary.attentionCount}
                    total={summary.conversations}
                    age={fmtAge(summary.smt)}
                    active={selected === summary.project}
                    hasLive={summary.liveCount > 0}
                    muted={summary.catalogOnly}
                    onClick={() => onSelect(summary.project)}
                  />
                ))
              : null}
          </>
        ) : null}
        {!activeRows.length && !archivedRows.length ? (
          loaded ? (
            <div className="px-3 py-4 text-center text-[12px] text-dim">{t("common.nothingFound")}</div>
          ) : (
            <div className="flex items-center justify-center gap-2 px-3 py-4 text-[12px] text-dim">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t("common.loading")}
            </div>
          )
        ) : null}
      </nav>
      <ResourcesFooter />
      <LimitsFooter />
    </aside>
  );
}

function RailRow({
  label,
  live,
  attention,
  total,
  age,
  active,
  hasLive,
  muted = false,
  onClick,
}: {
  label: string;
  live: number;
  attention: number;
  total: number | null;
  age: string;
  active: boolean;
  hasLive: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  const isMobile = useIsMobile();
  return (
    <button
      className={[
        "mb-0.5 flex w-full items-center gap-2 rounded-[10px] border px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        isMobile ? "min-h-11" : "py-2",
        active ? "border-line bg-bg shadow-card" : "border-transparent hover:bg-bg",
        muted ? "opacity-65" : "",
      ].join(" ")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span
        className={[
          "h-2 w-2 shrink-0 rounded-full",
          hasLive ? "animate-pulse bg-ok" : muted ? "bg-[#b8b8c2]" : "bg-[#d6d6dd]",
        ].join(" ")}
      />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${active ? "font-bold" : "font-semibold"} ${muted ? "text-dim" : ""}`}>{label}</span>
        {age ? <span className="block text-[10.5px] text-dim">{age}</span> : null}
      </span>
      {live > 0 ? (
        <span className="shrink-0 rounded-full bg-[#e5f6ea] px-1.5 py-0.5 text-[10.5px] font-bold text-ok">{live}</span>
      ) : null}
      {attention > 0 ? (
        <span className="shrink-0 rounded-full bg-[#fff1ca] px-1.5 py-0.5 text-[10.5px] font-bold text-[#8a5a00]">⏸ {attention}</span>
      ) : null}
      {total !== null ? <span className="shrink-0 text-[11px] font-semibold text-dim">{total}</span> : null}
    </button>
  );
}
