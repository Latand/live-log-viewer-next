"use client";

import { Archive, Check, ChevronRight, Crown, Folder, FolderPlus, Layers, Loader2, TriangleAlert } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/Badge";
import type { CreateProjectOutcome, CreateProjectRequestOptions } from "@/hooks/useProjectCuration";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { buildProjectSummaries, OVERVIEW, partitionCrownedSummaries, type ProjectSummary } from "../projectModel";
import { fmtAge } from "../utils";
import { MobileSheet, MobileSheetDivider, MobileSheetRow } from "./MobileSheet";

/*
 * The project switcher (docs/design/mobile-v2/README.md §3.1, §4.1): the
 * board's title cell opens it over the board. Overview, the crowned projects,
 * the rest, an Archive fold and Create project — dense 44 px rows, the current
 * one checked, each row one tap that replaces the board. The hamburger and the
 * drawer that held the desktop rail are gone (§6).
 */

type CreateProject = (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;

export interface MobileProjectSheetProps {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  projectDisplayNames?: Readonly<Record<string, string>>;
  pipelines: Pipeline[];
  workflows: Workflow[];
  archivedProjects: ReadonlySet<string>;
  crownedProjects?: ReadonlySet<string>;
  selected: string;
  /** The attention clock the Viewer owns. */
  now: number;
  loaded: boolean;
  catalogFailures?: number;
  onSelect: (project: string) => void;
  onCreateProject?: CreateProject;
  onClose: () => void;
}

const EMPTY_CROWNS: ReadonlySet<string> = new Set();

export function MobileProjectSheet({
  files,
  projectCatalog,
  projectDisplayNames = {},
  pipelines,
  workflows,
  archivedProjects,
  crownedProjects = EMPTY_CROWNS,
  selected,
  now,
  loaded,
  catalogFailures = 0,
  onSelect,
  onCreateProject,
  onClose,
}: MobileProjectSheetProps) {
  const { t } = useLocale();
  const summaries = useMemo(
    () => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines, projectDisplayNames),
    [files, now, workflows, projectCatalog, pipelines, projectDisplayNames],
  );
  const active = useMemo(() => summaries.filter((summary) => !archivedProjects.has(summary.project)), [summaries, archivedProjects]);
  const archived = useMemo(() => summaries.filter((summary) => archivedProjects.has(summary.project)), [summaries, archivedProjects]);
  const { crowned, rest } = useMemo(() => partitionCrownedSummaries(active, crownedProjects), [active, crownedProjects]);
  /* A first run (the catalog answered with no project at all) opens the create
     form itself: the only reason to have opened this sheet is what that form
     does (the rail's own rule, issue #1162). */
  const firstRun = loaded && catalogFailures === 0 && summaries.length === 0;
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(firstRun && Boolean(onCreateProject));

  const row = (summary: ProjectSummary, quiet = false) => {
    const current = summary.project === selected;
    const isCrowned = crownedProjects.has(summary.project);
    return (
      <MobileSheetRow
        key={summary.project}
        icon={isCrowned ? <Crown className="h-[18px] w-[18px] fill-crown text-crown" aria-hidden /> : <Folder className="h-[18px] w-[18px]" aria-hidden />}
        label={summary.displayName}
        selected={current}
        ariaLabel={t("mobile2.projects.select", { name: summary.displayName })}
        attrs={{ "data-mobile2-project": summary.project, "data-mobile2-quiet": quiet ? "1" : undefined }}
        trailing={
          <>
            <span className={quiet ? "text-muted" : ""}>
              {summary.liveCount
                ? t("mobile2.projects.live", { count: summary.liveCount })
                : summary.smt
                  ? t("mobile2.projects.quietSince", { age: fmtAge(summary.smt) })
                  : t("mobile2.projects.quiet")}
            </span>
            {summary.attentionCount ? (
              <Badge tone="warning">
                <TriangleAlert className="h-[11px] w-[11px]" aria-hidden /> {summary.attentionCount}
              </Badge>
            ) : null}
            {current ? <Check className="h-[18px] w-[18px] text-accent" aria-hidden /> : null}
          </>
        }
        onSelect={() => onSelect(summary.project)}
      />
    );
  };

  return (
    <MobileSheet name="projects" title={t("mobile2.projects.title")} onClose={onClose}>
      <MobileSheetRow
        icon={<Layers className="h-[18px] w-[18px]" aria-hidden />}
        label={t("mobile2.projects.overview")}
        selected={selected === OVERVIEW}
        attrs={{ "data-mobile2-project": OVERVIEW }}
        trailing={
          <>
            <span>{t("mobile2.projects.count", { count: active.length })}</span>
            {selected === OVERVIEW ? <Check className="h-[18px] w-[18px] text-accent" aria-hidden /> : null}
          </>
        }
        onSelect={() => onSelect(OVERVIEW)}
      />
      <MobileSheetDivider />
      {crowned.map((summary) => row(summary))}
      {rest.map((summary) => row(summary))}
      {!loaded && !summaries.length ? (
        <div className="flex items-center justify-center gap-2 px-4 py-3 text-ui text-muted">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          {t("common.loading")}
        </div>
      ) : null}
      {catalogFailures > 0 && !summaries.length ? <div className="px-4 py-3 text-ui font-semibold text-danger">{t("catalog.unreachable")}</div> : null}
      <MobileSheetDivider />
      {archived.length ? (
        <MobileSheetRow
          icon={<Archive className="h-[18px] w-[18px]" aria-hidden />}
          label={t("mobile2.projects.archive")}
          attrs={{ "data-mobile2-project-archive": archiveOpen ? "open" : "closed" }}
          trailing={
            <>
              <span>{t("mobile2.projects.count", { count: archived.length })}</span>
              <ChevronRight className={`h-4 w-4 transition-transform motion-reduce:transition-none ${archiveOpen ? "rotate-90" : ""}`} aria-hidden />
            </>
          }
          onSelect={() => setArchiveOpen((value) => !value)}
        />
      ) : null}
      {archiveOpen ? archived.map((summary) => row(summary, true)) : null}
      {onCreateProject ? (
        <MobileSheetRow
          icon={<FolderPlus className="h-[18px] w-[18px]" aria-hidden />}
          label={t("mobile2.projects.create")}
          attrs={{ "data-mobile2-project-create": createOpen ? "open" : "closed" }}
          onSelect={() => setCreateOpen((value) => !value)}
        />
      ) : null}
      {createOpen && onCreateProject ? (
        <CreateProjectRows
          onCreate={onCreateProject}
          onCreated={(project) => {
            setCreateOpen(false);
            onSelect(project);
          }}
        />
      ) : null}
    </MobileSheet>
  );
}

/** The create form as sheet rows: a name, a root directory, one Create
    control. A path typed here goes to the server as is; a refused one is
    named back on the row. */
function CreateProjectRows({ onCreate, onCreated }: { onCreate: CreateProject; onCreated: (project: string) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "min-h-11 w-full rounded-[8px] border border-border bg-sunken px-3 text-[16px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedRoot = root.trim();
    const trimmedName = name.trim() || trimmedRoot.split("/").filter(Boolean).pop() || "";
    if (!trimmedRoot || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await onCreate(trimmedName, trimmedRoot);
    setBusy(false);
    if (outcome.ok) {
      onCreated(outcome.project);
      return;
    }
    setError(outcome.message || t("mobile2.projects.createFailed"));
  };
  return (
    <form className="flex flex-col gap-2 px-4 pb-2 pt-1" data-mobile2-project-form onSubmit={submit}>
      <label className="flex flex-col gap-1 text-label font-semibold text-secondary">
        {t("mobile2.projects.createName")}
        <input className={field} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1 text-label font-semibold text-secondary">
        {t("mobile2.projects.createRoot")}
        <input className={field} value={root} onChange={(event) => setRoot(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {error ? <span role="alert" className="text-label font-semibold text-danger">{error}</span> : null}
      <button
        type="submit"
        disabled={busy || !root.trim()}
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[8px] bg-accent px-4 text-body font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <FolderPlus className="h-4 w-4" aria-hidden />}
        {t("mobile2.projects.createSubmit")}
      </button>
    </form>
  );
}
