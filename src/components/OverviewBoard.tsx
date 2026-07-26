"use client";

import { Menu } from "lucide-react";
import { useMemo } from "react";

import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { useColumns } from "@/hooks/useColumns";
import { projectDisplayName } from "@/lib/displayNames";
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
  onSelectProject: (project: string) => void;
  onSelectFile: (file: FileEntry) => void;
  /** Mobile shell: the rail hides behind a drawer, this opens it. */
  onMenu?: () => void;
  /** Mobile shell: the attention badge lives in the header row instead of the
      fixed corner, so it never covers the header's own controls. */
  attention?: React.ReactNode;
}

/** Touch target for a board destination. The finger, not the viewport, decides:
    a tablet with a mouse does not need 44px rows, and a phone-width window on a
    desktop is not being tapped. Matches the 44px the mobile chrome already uses
    (`chatBudget`). */
export const COARSE_TARGET_HEIGHT = 44;
export const FINE_TARGET_HEIGHT = 22;

export function OverviewBoard({ files, projectCatalog, pipelines, workflows, archivedProjects, now, onSelectProject, onSelectFile, onMenu, attention }: Props) {
  const { t } = useLocale();
  const cols = useColumns();
  const targetHeight = useCoarsePointer() ? COARSE_TARGET_HEIGHT : FINE_TARGET_HEIGHT;
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
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-card px-4">
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
        <h1 className="text-[13.5px] font-bold">{t("rail.overview")}</h1>
        <span className="text-[11.5px] text-muted">
          {totalLive
            ? t("overview.branchesLiveIn", { count: totalLive, projects: t("overview.projects", { count: liveProjects }) })
            : t("common.nothingRunning")}
          {archivedCount ? ` ${t("overview.archived", { count: archivedCount })}` : ""}
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
          const projectLabel = (
            <>
              <span className={`h-2 w-2 shrink-0 rounded-full ${summary.liveCount ? "animate-pulse bg-success" : "bg-strong"}`} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{projectDisplayName(summary.project)}</span>
              {summary.liveCount ? (
                <span className="shrink-0 text-caption font-semibold tabular-nums text-muted">{summary.liveCount}</span>
              ) : null}
              <span className="shrink-0 text-[11px] font-semibold text-muted">{summary.conversations}</span>
            </>
          );
          /* The card is a plain container, never a button (#699). It used to be
             one, with conversation rows nested inside it as `role="link"` spans —
             interactive content inside interactive content, which is both invalid
             and the reason a near miss was dangerous: the 4px gap between two
             rows belonged to the card, so a tap that missed a 20px-tall row by a
             hair opened the whole project instead. With the card inert, every
             gap and every margin is dead space, and the only things that
             navigate are the explicit targets below. */
          return (
            <div
              key={summary.project}
              data-testid="overview-card"
              className={`flex flex-col gap-1.5 rounded-[10px] border border-border bg-card p-3 text-left shadow-1 ${
                summary.catalogOnly ? "opacity-70" : ""
              }`}
            >
              {liveBranches.length ? (
                <>
                  {/* Project navigation is preserved, as its own target. */}
                  <button
                    type="button"
                    data-testid="overview-project"
                    style={{ minHeight: targetHeight }}
                    className="flex items-center gap-2 rounded-[8px] text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onClick={() => onSelectProject(summary.project)}
                  >
                    {projectLabel}
                  </button>
                  <div className="flex flex-col gap-1" data-testid="overview-rows">
                    {liveBranches.map((branch) => {
                      const badge = engineBadge(branch);
                      return (
                        <button
                          key={branch.path}
                          type="button"
                          /* The same key a #688 conversation anchor resolves
                             through, so a focus handoff and a tap address the
                             one destination. */
                          data-focus-target={branch.path}
                          data-testid="overview-conversation"
                          style={{ minHeight: targetHeight }}
                          className="flex items-center gap-1.5 rounded-[8px] px-1 text-left text-[11.5px] hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          title={cleanTitle(branch.title)}
                          onClick={() => onSelectFile(branch)}
                        >
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(branch.activity)}`} />
                          <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>{badge.label}</span>
                          <span className="truncate font-semibold">{cleanTitle(branch.title, 70)}</span>
                        </button>
                      );
                    })}
                    {moreLive > 0 ? (
                      /* A count, not a control: putting a fifth destination
                         directly under four conversation rows is the ambiguity
                         this issue is about. */
                      <span className="px-1 text-[10.5px] font-semibold text-muted">{t("overview.moreLive", { count: moreLive })}</span>
                    ) : null}
                  </div>
                </>
              ) : (
                /* Nothing live: there are no conversation targets to be confused
                   with, so the whole card body stays one generous project
                   target — the reachability the card had before. */
                <button
                  type="button"
                  data-testid="overview-project"
                  style={{ minHeight: targetHeight }}
                  className="flex flex-col gap-1.5 rounded-[8px] text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  onClick={() => onSelectProject(summary.project)}
                >
                  <span className="flex items-center gap-2">{projectLabel}</span>
                  <span className="text-[11px] text-muted">
                    {t("overview.quiet", { age: latest ? fmtAge(latest.mtime) : "—" })}
                  </span>
                </button>
              )}
            </div>
          );
        })}
        {!summaries.length ? (
          <div className="col-span-full mt-[20vh] text-center text-muted">{t("overview.empty")}</div>
        ) : null}
      </div>
    </div>
  );
}
