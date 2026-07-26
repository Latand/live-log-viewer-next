"use client";

import { Menu, RotateCw, TriangleAlert } from "lucide-react";
import { useMemo } from "react";

import { useColumns } from "@/hooks/useColumns";
import { projectDisplayName } from "@/lib/displayNames";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { OrchestratorChatButton } from "./OrchestratorChatButton";
import { buildBranchGroups, buildProjectSummaries, projectKey } from "./projectModel";
import { activityDot, cleanTitle, engineBadge, fmtAge } from "./utils";

interface Props {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  pipelines: Pipeline[];
  /** Active workflows: their stamped projects get a card even without files. */
  workflows: Workflow[];
  /** Shelved projects: their cards stay off the board until unarchived or live again. */
  archivedProjects: ReadonlySet<string>;
  /** Attention clock owned by Viewer — keeps summary badges in step with the queue. */
  now: number;
  /** Consecutive `/api/files` failures (issue #696). Above zero the board is
      showing an unconfirmed catalog, so the idle empty-state copy is a lie. */
  catalogFailures?: number;
  onSelectProject: (project: string) => void;
  onSelectFile: (file: FileEntry) => void;
  /** Mobile shell: the rail hides behind a drawer, this opens it. */
  onMenu?: () => void;
  /** Mobile shell: the attention badge lives in the header row instead of the
      fixed corner, so it never covers the header's own controls. */
  attention?: React.ReactNode;
}

export function OverviewBoard({ files, projectCatalog, pipelines, workflows, archivedProjects, now, catalogFailures = 0, onSelectProject, onSelectFile, onMenu, attention }: Props) {
  const { t } = useLocale();
  const degraded = catalogFailures > 0;
  const cols = useColumns();
  const allSummaries = useMemo(() => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines), [files, now, workflows, projectCatalog, pipelines]);
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
      <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-hidden border-b border-border bg-card px-4">
        {onMenu ? (
          <button
            type="button"
            className="-ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("dash.openProjects")}
            onClick={onMenu}
          >
            <Menu className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        <h1 className="min-w-0 shrink truncate text-[13.5px] font-bold">{t("rail.overview")}</h1>
        {/* Issue #701: the subtitle is dropped below 360px instead of wrapping
            into this fixed 40px bar, where it overprinted the title and the
            Orchestrator button and pushed the board past the viewport. Above
            360px it truncates rather than growing the row. */}
        <span
          className={`hidden min-w-0 shrink truncate text-[11.5px] min-[360px]:block ${degraded ? "font-semibold text-danger" : "text-muted"}`}
          data-degraded={degraded ? "true" : undefined}
        >
          {/* Issue #696: a failed catalog fetch never borrows the affirmative
              "nothing is running right now" copy. */}
          {degraded
            ? t("catalog.unreachable")
            : totalLive
              ? t("overview.branchesLiveIn", { count: totalLive, projects: t("overview.projects", { count: liveProjects }) })
              : t("common.nothingRunning")}
          {!degraded && archivedCount ? ` ${t("overview.archived", { count: archivedCount })}` : ""}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <OrchestratorChatButton />
          {attention}
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
              className={`flex flex-col gap-1.5 rounded-[10px] border border-border bg-card p-3 text-left shadow-1 hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                summary.catalogOnly ? "opacity-70" : ""
              }`}
              onClick={() => onSelectProject(summary.project)}
            >
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${summary.liveCount ? "animate-pulse bg-success" : "bg-strong"}`} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{projectDisplayName(summary.project)}</span>
                {summary.liveCount ? (
                  <span className="shrink-0 text-caption font-semibold tabular-nums text-muted">{summary.liveCount}</span>
                ) : null}
                <span className="shrink-0 text-[11px] font-semibold text-muted">{summary.conversations}</span>
              </span>
              {liveBranches.length ? (
                <span className="flex flex-col gap-1">
                  {liveBranches.map((branch) => {
                    const badge = engineBadge(branch);
                    return (
                      <span
                        key={branch.path}
                        className="flex cursor-pointer items-center gap-1.5 rounded-[8px] px-1 py-0.5 text-[11.5px] hover:bg-canvas"
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
                    <span className="px-1 text-[10.5px] font-semibold text-muted">{t("overview.moreLive", { count: moreLive })}</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-[11px] text-muted">
                  {t("overview.quiet", { age: latest ? fmtAge(latest.mtime) : "—" })}
                </span>
              )}
            </button>
          );
        })}
        {/* Issue #696: a failed fetch and a genuinely empty installation must
            not render the same screen. While the catalog is unreachable the
            board states the failure and offers the recovery action; the idle
            "No logs yet" copy is held back until a fetch actually succeeds. */}
        {degraded ? (
          <div
            role="alert"
            data-catalog-error="true"
            className={`col-span-full mx-auto flex max-w-[420px] flex-col items-center gap-2 rounded-[10px] border border-danger/35 bg-danger-soft px-4 py-4 text-center ${
              summaries.length ? "mt-1" : "mt-[12vh]"
            }`}
          >
            <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-danger">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden /> {t("catalog.errorTitle")}
            </span>
            <span className="text-[12px] text-secondary">{t("catalog.errorBody")}</span>
            <span className="text-[11px] font-semibold tabular-nums text-muted">
              {t("catalog.attempts", { count: catalogFailures })}
            </span>
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-[13px] font-semibold text-primary hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => requestFilesRefresh()}
            >
              <RotateCw className="h-4 w-4" aria-hidden /> {t("catalog.retry")}
            </button>
          </div>
        ) : !summaries.length ? (
          <div className="col-span-full mt-[20vh] text-center text-muted">{t("overview.empty")}</div>
        ) : null}
      </div>
    </div>
  );
}
