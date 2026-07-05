"use client";

import { Menu } from "lucide-react";
import { useMemo } from "react";

import { useColumns } from "@/hooks/useColumns";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { buildBranchGroups, buildProjectSummaries, projectKey } from "./projectModel";
import { activityDot, cleanTitle, engineBadge, fmtAge } from "./utils";

interface Props {
  files: FileEntry[];
  /** Shelved projects: their cards stay off the board until unarchived or live again. */
  archivedProjects: ReadonlySet<string>;
  /** Attention clock owned by Viewer — keeps summary badges in step with the queue. */
  now: number;
  onSelectProject: (project: string) => void;
  onSelectFile: (file: FileEntry) => void;
  /** Mobile shell: the rail hides behind a drawer, this opens it. */
  onMenu?: () => void;
}

export function OverviewBoard({ files, archivedProjects, now, onSelectProject, onSelectFile, onMenu }: Props) {
  const { t } = useLocale();
  const cols = useColumns();
  const allSummaries = useMemo(() => buildProjectSummaries(files, now), [files, now]);
  const summaries = useMemo(
    () => allSummaries.filter((summary) => !archivedProjects.has(summary.project)),
    [allSummaries, archivedProjects],
  );
  const archivedCount = allSummaries.length - summaries.length;
  const totalLive = useMemo(() => summaries.reduce((sum, s) => sum + s.liveCount, 0), [summaries]);
  const liveProjects = summaries.filter((s) => s.liveCount > 0).length;
  const cards = useMemo(
    () =>
      summaries.map((summary) => {
        const groups = buildBranchGroups(files, summary.project);
        const allLive = groups
          .flatMap((group) => group.columns.flatMap((column) => [column.file, ...column.tasks]))
          .filter((entry) => entry.activity === "live");
        const liveBranches = allLive.slice(0, 4);
        const latest = files
          .filter((file) => projectKey(file) === summary.project)
          .sort((a, b) => b.mtime - a.mtime)[0];
        return { summary, liveBranches, moreLive: allLive.length - liveBranches.length, latest };
      }),
    [files, summaries],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-panel px-4">
        {onMenu ? (
          <button
            type="button"
            className="-ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("dash.openProjects")}
            onClick={onMenu}
          >
            <Menu className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        <h1 className="text-[13.5px] font-bold">{t("rail.overview")}</h1>
        <span className="text-[11.5px] text-dim">
          {totalLive
            ? t("overview.branchesLiveIn", { count: totalLive, projects: t("overview.projects", { count: liveProjects }) })
            : t("common.nothingRunning")}
          {archivedCount ? ` ${t("overview.archived", { count: archivedCount })}` : ""}
        </span>
      </div>
      <div
        className="grid flex-1 auto-rows-min gap-2.5 overflow-y-auto p-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {cards.map(({ summary, liveBranches, moreLive, latest }) => {
          return (
            <button
              key={summary.project}
              className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel p-3 text-left shadow-card hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => onSelectProject(summary.project)}
            >
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${summary.liveCount ? "animate-pulse bg-ok" : "bg-[#d6d6dd]"}`} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{summary.project}</span>
                {summary.liveCount ? (
                  <span className="shrink-0 rounded-full bg-[#e5f6ea] px-1.5 py-0.5 text-[10.5px] font-bold text-ok">
                    {summary.liveCount}
                  </span>
                ) : null}
                <span className="shrink-0 text-[11px] font-semibold text-dim">{summary.conversations}</span>
              </span>
              {liveBranches.length ? (
                <span className="flex flex-col gap-1">
                  {liveBranches.map((branch) => {
                    const badge = engineBadge(branch);
                    return (
                      <span
                        key={branch.path}
                        className="flex cursor-pointer items-center gap-1.5 rounded-[8px] px-1 py-0.5 text-[11.5px] hover:bg-bg"
                        role="link"
                        tabIndex={0}
                        title={cleanTitle(branch.title)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectFile(branch);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.stopPropagation();
                          onSelectFile(branch);
                        }}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(branch.activity)}`} />
                        <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>{badge.label}</span>
                        <span className="truncate font-semibold">{cleanTitle(branch.title, 70)}</span>
                      </span>
                    );
                  })}
                  {moreLive > 0 ? (
                    <span className="px-1 text-[10.5px] font-semibold text-dim">{t("overview.moreLive", { count: moreLive })}</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-[11px] text-dim">
                  {t("overview.quiet", { age: latest ? fmtAge(latest.mtime) : "—" })}
                </span>
              )}
            </button>
          );
        })}
        {!summaries.length ? (
          <div className="col-span-full mt-[20vh] text-center text-dim">{t("overview.empty")}</div>
        ) : null}
      </div>
    </div>
  );
}
