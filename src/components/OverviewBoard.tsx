"use client";

import { useMemo } from "react";

import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { useColumns } from "@/hooks/useColumns";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { CatalogFailureNotice } from "./CatalogFailureNotice";
import { FolderPlus, Search } from "./icons";
import { KeepAwakeMenuRow } from "./KeepAwakeControl";
import { MobileMenuSheet, type MobileMenuEntry } from "./mobile/MobileMenuSheet";
import { MobileAccountsScreen, MobileBarTitle, MobileShell, type MobileShellHost } from "./mobile/MobileShell";
import { topScreen, useMobileNav, useMobileNavStore, type MobileSheetName } from "./mobile/mobileNav";
import { SoundToggle } from "./SoundToggle";
import { buildBranchGroups, buildProjectSummaries, projectKey } from "./projectModel";
import { CREATE_PROJECT_FORM_EVENT } from "./ProjectRail";
import { activityDot, cleanTitle, engineBadge, fmtAge } from "./utils";

interface Props {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  projectDisplayNames?: Readonly<Record<string, string>>;
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
  /** Opens the global message search (issue #1054). The affordance sits in the
      board chrome on every screen, so the operator never has to be somewhere
      particular to search what they have sent. */
  onOpenSearch?: () => void;
  /** The phone shell's host (mobile v2 lane 1): the queue count for the bar's
      badge, the arrival for the banner slot and the sheets the Viewer owns.
      Absent on the desktop. */
  mobileShell?: MobileShellHost | null;
}

/** Touch target for a board destination. The finger, not the viewport, decides:
    a tablet with a mouse does not need 44px rows, and a phone-width window on a
    desktop is not being tapped. Matches the 44px the mobile chrome already uses
    (`chatBudget`). */
export const COARSE_TARGET_HEIGHT = 44;
export const FINE_TARGET_HEIGHT = 22;

export function OverviewBoard({ files, projectCatalog, projectDisplayNames = {}, pipelines, workflows, archivedProjects, now, catalogFailures = 0, onSelectProject, onSelectFile, onOpenSearch, mobileShell = null }: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const mobileNav = useMobileNavStore();
  const mobileNavState = useMobileNav();
  const degraded = catalogFailures > 0;
  const cols = useColumns();
  const targetHeight = useCoarsePointer() ? COARSE_TARGET_HEIGHT : FINE_TARGET_HEIGHT;
  const allSummaries = useMemo(
    () => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines, projectDisplayNames),
    [files, now, workflows, projectCatalog, pipelines, projectDisplayNames],
  );
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

  const grid = (
        <div
          className="grid flex-1 auto-rows-min gap-2.5 overflow-y-auto p-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {cards.map(({ summary, liveBranches, moreLive, latest }) => {
            const projectLabel = (
              <>
                <span className={`h-2 w-2 shrink-0 rounded-full ${summary.liveCount ? "animate-pulse bg-success" : "bg-strong"}`} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{summary.displayName}</span>
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
          {/* Issue #696: a failed fetch and a genuinely empty installation must
              not render the same screen. While the catalog is unreachable the
              board states the failure and offers the recovery action; the
              first-run panel is held back until a fetch actually succeeds. */}
          {degraded ? (
            <CatalogFailureNotice failures={catalogFailures} className={`col-span-full ${summaries.length ? "mt-1" : "mt-[12vh]"}`} />
          ) : !allSummaries.length ? (
            /* First run (issue #1162). A board with nothing on it used to state
               the fact and stop there; it now says where sessions come from and
               offers the one next step. The button steers the rail's existing
               create form rather than opening a second creation path.
               `allSummaries`, not the archived-filtered list: an installation
               whose only projects are shelved has had projects, and the header
               says so — «No projects yet» would contradict its own «1 archived»
               two rows above. */
            <div
              data-testid="overview-first-run"
              className="col-span-full mt-[14vh] flex flex-col items-center gap-2.5 px-4 text-center"
            >
              <span className="text-[15px] font-bold text-primary">{t("overview.firstRunTitle")}</span>
              <span className="max-w-[440px] text-[12px] text-secondary">{t("overview.firstRunBody")}</span>
              <button
                type="button"
                data-testid="overview-create-project"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border border-accent/45 bg-card px-4 text-[13px] font-bold text-accent shadow-1 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => {
                  /* Desktop: the rail is mounted beside the board, so it hears
                     this and opens the create form it already owns. Phone: the
                     project switcher sheet opens with its create form already
                     open on a first run (mobile v2 lane 1). One tap either way. */
                  if (isMobile) mobileNav.openSheet("projects");
                  else window.dispatchEvent(new Event(CREATE_PROJECT_FORM_EVENT));
                }}
              >
                <FolderPlus className="h-4 w-4" aria-hidden /> {t("overview.firstRunCreate")}
              </button>
              <span className="max-w-[440px] text-[11.5px] text-muted">{t("overview.firstRunElsewhere")}</span>
            </div>
          ) : null}
        </div>
  );

  if (isMobile) {
    /* The phone (mobile v2 lane 1): the shell's bar with «Overview» as the
       title cell (it opens the project switcher), the badge, search and ⋯; the
       menu holds the device-local settings. */
    const renderSheet = (name: MobileSheetName, close: () => void) => {
      if (name === "menu") {
        const entries: MobileMenuEntry[] = [
          {
            kind: "custom",
            key: "sound",
            node: (
              <div className="flex min-h-11 items-center gap-2 px-4">
                <span className="min-w-0 flex-1 text-body font-semibold text-primary">{t("mobile2.menu.sound")}</span>
                <SoundToggle />
              </div>
            ),
          },
          { kind: "custom", key: "awake", node: <div className="px-2.5"><KeepAwakeMenuRow /></div> },
        ];
        return <MobileMenuSheet title={t("rail.overview")} entries={entries} onClose={close} />;
      }
      return mobileShell?.renderSheet(name, close) ?? null;
    };
    if (topScreen(mobileNavState).kind === "accounts") return <MobileAccountsScreen host={mobileShell} renderSheet={renderSheet} />;
    return (
      <MobileShell
        screen="board"
        title={<MobileBarTitle>{t("rail.overview")}</MobileBarTitle>}
        titleLabel={t("mobile2.bar.switchProject")}
        titleOpens={mobileShell ? "projects" : undefined}
        host={mobileShell}
        onOpenSearch={onOpenSearch}
        searchTestId="overview-search"
        renderSheet={renderSheet}
      >
        {grid}
      </MobileShell>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Issue #701 kept the 320px reflow out; the clip is x-only so it cannot
          take the y axis with it. The bar's own mobile children are 44px tall
          against this 40px row (the Orchestrator pill and the attention badge),
          and a plain `overflow-hidden` sliced 2px off both — on the exact
          surface #701 was meant to make usable. `overflow-x-clip` leaves the y
          axis visible, so the pills overhang as they did before. */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-x-clip border-b border-border bg-card px-4">
        <h1 className="min-w-0 shrink truncate text-[13.5px] font-bold">{t("rail.overview")}</h1>
        {/* Issue #701: the subtitle is dropped below 360px instead of wrapping
            into this fixed 40px bar, where it overprinted the title and the
            header actions and pushed the board past the viewport. Above
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
          {onOpenSearch ? (
            <button
              type="button"
              data-testid="overview-search"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("search.open")}
              title={t("search.open")}
              onClick={onOpenSearch}
            >
              <Search className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </span>
      </div>
      {grid}
    </div>
  );
}
