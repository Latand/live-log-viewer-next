"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { CreateProjectOutcome, CreateProjectRequestOptions } from "@/hooks/useProjectCuration";
import { projectMatchesQuery } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { AccessQrButton } from "./AccessQrButton";
import { CatalogFailureNotice } from "./CatalogFailureNotice";
import { DirectoryPicker, splitDirectoryPath } from "./DirectoryPicker";
import { FlipRow } from "./FlipRow";
import { Archive, ChevronRight, Crown, FolderPlus, Loader2 } from "./icons";
import { LanguageToggle } from "./LanguageToggle";
import { LimitsFooter } from "./LimitsFooter";
import { buildProjectSummaries, OVERVIEW, partitionCrownedSummaries, type ProjectSummary } from "./projectModel";
import { PushBell } from "./PushBell";
import { ResourcesFooter } from "./ResourcesFooter";
import { fmtAge } from "./utils";

/**
 * Asks the rail to open the create-project form it already owns (issue #1162).
 * The first-run overview's «Create a project» button dispatches it rather than
 * carrying a second creation path; the rail, being mounted beside the board on
 * the desktop, hears it. On the phone the rail lives behind the drawer, which
 * that button opens instead — the labelled create button is the first control
 * inside it.
 */
export const CREATE_PROJECT_FORM_EVENT = "llv:create-project-form";

interface Props {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  projectDisplayNames?: Readonly<Record<string, string>>;
  pipelines: Pipeline[];
  /** Active workflows: their stamped projects stay listed even while no
      transcript of theirs exists yet. */
  workflows: Workflow[];
  /** Shelved projects: pulled out of the main list into the archive section. */
  archivedProjects: ReadonlySet<string>;
  /** Crowned projects (server-durable): pinned in their own top section. */
  crownedProjects?: ReadonlySet<string>;
  selected: string;
  loaded: boolean;
  /** Consecutive `/api/files` failures (issue #696) — a rail that never loaded
      says the fetch failed instead of spinning "loading…" indefinitely. */
  catalogFailures?: number;
  /** Attention clock owned by Viewer — advances when a stalled entry crosses
      its TTL, so the rail badges expire together with the queue. */
  now: number;
  onSelect: (project: string) => void;
  onToggleCrown?: (project: string, crowned: boolean) => void;
  onCreateProject?: (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;
}

const EMPTY_CROWNS: ReadonlySet<string> = new Set();

export function ProjectRail({ files, projectCatalog, projectDisplayNames = {}, pipelines, workflows, archivedProjects, crownedProjects = EMPTY_CROWNS, selected, loaded, catalogFailures = 0, now, onSelect, onToggleCrown, onCreateProject }: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const summaries = useMemo(
    () => buildProjectSummaries(files, now, workflows, projectCatalog, pipelines, projectDisplayNames),
    [files, now, workflows, projectCatalog, pipelines, projectDisplayNames],
  );
  const visible = useMemo(() => {
    return summaries.filter((summary) => projectMatchesQuery(summary.project, query, summary.displayName));
  }, [summaries, query]);
  const activeRows = useMemo(() => visible.filter((summary) => !archivedProjects.has(summary.project)), [visible, archivedProjects]);
  const archivedRows = useMemo(() => visible.filter((summary) => archivedProjects.has(summary.project)), [visible, archivedProjects]);
  /* Crowned rows float in their own pinned section; both halves keep the
     shared attention → live → recency order. */
  const { crowned: crownedRows, rest: regularRows } = useMemo(
    () => partitionCrownedSummaries(activeRows, crownedProjects),
    [activeRows, crownedProjects],
  );
  const totalLive = useMemo(() => summaries.reduce((sum, s) => sum + s.liveCount, 0), [summaries]);
  const totalAttention = useMemo(() => summaries.reduce((sum, s) => sum + s.attentionCount, 0), [summaries]);
  /* First run (issue #1162): the catalog answered and named no project at all.
     Distinct from a filter query that matched none, and from a failed fetch —
     both of those keep their own treatment. */
  const firstRun = loaded && catalogFailures === 0 && !summaries.length;
  /* The phone's rail is not mounted beside the board — it exists only once
     something opens the drawer, so nothing an event fired at tap time could
     reach. It decides for itself instead: a rail sitting in a first run lists
     no projects, and the only reason to have summoned it is what this form
     does, so the form is open. That makes the overview's «Create a project»
     button one tap on a phone too (issue #1162), and the labelled button above
     the form still collapses it.
     The tap can land before the catalog answers, so the rail arrives with
     `loaded` false and the first run only becomes true a moment later. It
     follows that transition — the repo's render-phase adjustment pattern — so
     the form opens on the edge instead of being decided once at mount, which
     had cost the operator a second tap. The edge fires once: a form the
     operator has since collapsed stays collapsed. */
  const mobileFirstRun = isMobile && firstRun && !!onCreateProject;
  const [createOpen, setCreateOpen] = useState(mobileFirstRun);
  const [seenMobileFirstRun, setSeenMobileFirstRun] = useState(mobileFirstRun);
  if (mobileFirstRun !== seenMobileFirstRun) {
    setSeenMobileFirstRun(mobileFirstRun);
    if (mobileFirstRun) setCreateOpen(true);
  }
  /* The first-run overview's «Create a project» button steers this form
     (issue #1162) instead of carrying a second creation path. The rail owns the
     form, so it owns the event that opens it — the same one-window-event idiom
     `llv:mcp-navigate` already uses between two mounted components. This is the
     desktop half: there the rail is already mounted beside the board. */
  useEffect(() => {
    if (!onCreateProject) return;
    const open = () => setCreateOpen(true);
    window.addEventListener(CREATE_PROJECT_FORM_EVENT, open);
    return () => window.removeEventListener(CREATE_PROJECT_FORM_EVENT, open);
  }, [onCreateProject]);

  const railRow = (summary: ProjectSummary) => {
    const crowned = crownedProjects.has(summary.project);
    return (
      <div key={summary.project} data-flip-key={summary.project} className="group relative">
        <RailRow
          label={summary.displayName}
          live={summary.liveCount}
          attention={summary.attentionCount}
          total={summary.conversations}
          age={fmtAge(summary.smt)}
          active={selected === summary.project}
          hasLive={summary.liveCount > 0}
          muted={summary.catalogOnly}
          crowned={crowned}
          reserveCrownSlot={isMobile}
          onClick={() => onSelect(summary.project)}
        />
        {onToggleCrown ? (
          <button
            type="button"
            className={[
              "group/crown absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[7px] border border-border bg-card transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              isMobile ? "" : "opacity-0 group-hover:opacity-100",
            ].join(" ")}
            title={crowned ? t("rail.uncrown") : t("rail.crown")}
            aria-label={crowned ? t("rail.uncrown") : t("rail.crown")}
            aria-pressed={crowned}
            onClick={() => onToggleCrown(summary.project, !crowned)}
          >
            {/* Same crown idiom as conversation favorites (FavoriteCrown):
                dashed gray when unset, lit gold when committed. */}
            <Crown
              className={`h-3.5 w-3.5 ${
                crowned
                  ? "fill-crown text-crown"
                  : "text-muted [stroke-dasharray:2_3] group-hover/crown:fill-crown group-hover/crown:text-crown group-hover/crown:[stroke-dasharray:0]"
              }`}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-border bg-card">
      <header
        className={`flex shrink-0 items-center gap-2 border-b border-border text-[13.5px] font-bold ${
          isMobile ? "min-h-[52px] gap-1.5 px-2 py-1.5" : "h-10 px-4"
        }`}
      >
        {isMobile ? (
          /* The 248px drawer header must hold three 44px controls no matter how
             wide the counts grow (issue #148). Title + live count + attention
             badge live in one min-w-0 flex-1 group that shrinks (title truncates
             first); the controls sit in a shrink-0 group so they can never be
             pushed outside. The group is overflow-hidden so even the capped
             `99+`/`99+` maximum can only clip within its own share, never bleed
             into the controls — and the live count is plain text (rule 5) while
             the attention badge stays compact (tight padding, tabular-nums) so
             that maximum still fits without clipping in the ~86px it is allotted. */
          <>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              <span className="min-w-0 truncate">{t("rail.title")}</span>
              {totalLive ? (
                <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted">{totalLive > 99 ? "99+" : totalLive}</span>
              ) : null}
              {totalAttention ? <Badge tone="warning">⏸{totalAttention > 99 ? "99+" : totalAttention}</Badge> : null}
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
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                {totalLive}
              </span>
            ) : null}
            {totalAttention ? <Badge tone="warning">⏸ {totalAttention}</Badge> : null}
            <LanguageToggle />
            <AccessQrButton />
            <PushBell />
          </>
        )}
      </header>
      <div className="flex gap-1.5 px-2.5 pb-1 pt-2.5">
        <input
          className={`w-full min-w-0 flex-1 rounded-[9px] border border-border bg-canvas px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "min-h-11" : "py-1.5"
          }`}
          placeholder={t("rail.filter")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {onCreateProject ? (
          /* Issue #1162: on a rail with no projects at all the icon is the only
             thing on screen that starts anything, and an icon alone does not say
             so — it carries its label there. A rail that already lists projects
             keeps the icon-only button, which is legible from its neighbours. */
          <button
            type="button"
            data-testid="rail-create-project"
            className={[
              "flex shrink-0 items-center justify-center gap-1.5 rounded-[9px] border bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              isMobile ? "min-h-11" : "",
              firstRun
                ? "border-accent/45 px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/10"
                : [
                  "border-border text-muted hover:text-primary",
                  isMobile ? "min-w-11" : "w-7",
                  createOpen ? "text-primary" : "",
                ].join(" "),
            ].join(" ")}
            title={t("rail.createProject")}
            aria-label={t("rail.createProject")}
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((value) => !value)}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {firstRun ? <span className="truncate">{t("rail.createProject")}</span> : null}
          </button>
        ) : null}
      </div>
      {createOpen && onCreateProject ? (
        <CreateProjectForm
          onCreate={onCreateProject}
          onCreated={(project) => {
            setCreateOpen(false);
            onSelect(project);
          }}
          onCancel={() => setCreateOpen(false)}
        />
      ) : null}
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
        <div className="mx-2.5 my-1.5 border-t border-border" />
        <FlipRow>
          {crownedRows.map(railRow)}
          {crownedRows.length && regularRows.length ? (
            <div data-flip-key="__crown-divider__" className="mx-2.5 my-1.5 border-t border-border" />
          ) : null}
          {regularRows.map(railRow)}
        </FlipRow>
        {archivedRows.length ? (
          <>
            <div className="mx-2.5 my-1.5 border-t border-border" />
            <button
              type="button"
              className={`mb-0.5 flex w-full items-center gap-1.5 rounded-[10px] px-2.5 text-left text-[11.5px] font-bold text-muted hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
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
                    label={summary.displayName}
                    live={summary.liveCount}
                    attention={summary.attentionCount}
                    total={summary.conversations}
                    age={fmtAge(summary.smt)}
                    active={selected === summary.project}
                    hasLive={summary.liveCount > 0}
                    muted={summary.catalogOnly}
                    crowned={crownedProjects.has(summary.project)}
                    onClick={() => onSelect(summary.project)}
                  />
                ))
              : null}
          </>
        ) : null}
        {!activeRows.length && !archivedRows.length ? (
          /* Issue #696: an unreachable server never reads as "still loading" or
             as "nothing found" — an empty rail with failures behind it is an
             unconfirmed rail, at any point in the session, not only before the
             first success. */
          catalogFailures > 0 ? (
            <CatalogFailureNotice failures={catalogFailures} size="inline" />
          ) : loaded ? (
            /* Issue #1162: «Nothing found» answers a filter query. A first run
               has nothing to find — the labelled create button above says what
               to do instead, and the overview carries the full statement. */
            query.trim() ? (
              <div className="px-3 py-4 text-center text-[12px] text-muted">{t("common.nothingFound")}</div>
            ) : null
          ) : (
            <div className="flex items-center justify-center gap-2 px-3 py-4 text-[12px] text-muted">
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

/* The create-error codes the server can answer with, mapped onto rail copy;
   anything unrecognized falls back to the generic failure line. Each code that
   the operator can act on differently gets its own words (issue #1223): a path
   that was never made absolute, a path outside the areas the viewer knows, and
   a path that already carries a project are three different objections, and
   spelling all of them "Directory not found" told the operator the one thing
   that was not true. RELATIVE_ROOT and MISSING_DIRECTORY are handled in the
   form itself, because both answer with more than a line of text. */
const CREATE_ERROR_KEYS: Record<string, "rail.invalidName" | "rail.invalidRoot" | "rail.outsideRoots" | "rail.duplicateProject"> = {
  INVALID_NAME: "rail.invalidName",
  INVALID_ROOT: "rail.invalidRoot",
  OUTSIDE_ROOTS: "rail.outsideRoots",
  DUPLICATE_PROJECT: "rail.duplicateProject",
};

/**
 * The directory a typed path points at, which is the unit suggestions are
 * fetched by: refining a name inside one directory filters what has already
 * been fetched, and only pointing at a new directory asks the server again.
 * A query that is not a path leaves the browse list as it is.
 */
function suggestionScope(query: string): string {
  const trimmed = query.trim();
  if (!trimmed.startsWith("/")) return "";
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

function CreateProjectForm({
  onCreate,
  onCreated,
  onCancel,
}: {
  onCreate: (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;
  onCreated: (project: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  /* Once the operator has written a name it is theirs; until then the chosen
     directory names the project (issue #1223). Clearing the field hands the
     default back. */
  const [nameEdited, setNameEdited] = useState(false);
  const [root, setRoot] = useState("");
  const [dirs, setDirs] = useState<readonly string[]>([]);
  const [scope, setScope] = useState("");
  const [openSignal, setOpenSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /* Set on a MISSING_DIRECTORY refusal: the error line turns into a notice
     and the mkdir-and-create action renders below it (issue #1122). */
  const [offerCreateRoot, setOfferCreateRoot] = useState(false);
  const [busy, setBusy] = useState(false);

  /* The suggestion source the picker cannot have (issue #1223): a project that
     does not exist yet is absent from every known-directories list, so the
     rows come from the filesystem, bounded server-side to the directories
     where this machine's projects already live. */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects/directories?q=" + encodeURIComponent(scope))
      .then(async (response) => (response.ok ? await response.json() as { dirs?: unknown } : null))
      .then((payload) => {
        if (cancelled || !Array.isArray(payload?.dirs)) return;
        setDirs(payload.dirs.filter((dir): dir is string => typeof dir === "string"));
      })
      .catch(() => {
        /* No suggestions is the pre-#1223 state: the path can still be typed. */
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const chooseRoot = (next: string) => {
    setRoot(next);
    setOfferCreateRoot(false);
    setError(null);
    if (nameEdited) return;
    const { tail } = splitDirectoryPath(next);
    if (tail && tail !== "/") setName(tail);
  };

  /* A root that is not a full path is a path the operator never finished, so
     the answer is the completion rather than a refusal: the message says what
     is missing and the picker opens on the suggestions (issue #1223). */
  const askForFullPath = () => {
    setOfferCreateRoot(false);
    setError(t("rail.relativeRoot"));
    setOpenSignal((value) => value + 1);
  };
  const inputClass = `w-full rounded-[9px] border border-border bg-canvas px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
    isMobile ? "min-h-11" : "py-1.5"
  }`;
  const submit = async (createRoot = false) => {
    if (busy) return;
    if (!name.trim()) {
      setError(t("rail.invalidName"));
      return;
    }
    const target = root.trim();
    if (!target) {
      setError(t("rail.invalidRoot"));
      setOpenSignal((value) => value + 1);
      return;
    }
    if (!target.startsWith("/")) {
      askForFullPath();
      return;
    }
    setBusy(true);
    setError(null);
    setOfferCreateRoot(false);
    const outcome = await onCreate(name.trim(), target, createRoot ? { createRoot: true } : undefined);
    setBusy(false);
    if (outcome.ok) {
      onCreated(outcome.project);
      return;
    }
    if (outcome.code === "MISSING_DIRECTORY") {
      /* An absent directory is recoverable, and says so in the same words the
         pipeline preflight uses for it (issue #1223) — the two surfaces no
         longer disagree about whether this is fatal. */
      setOfferCreateRoot(true);
      setError(t("rail.missingRoot", { path: target }));
      return;
    }
    if (outcome.code === "RELATIVE_ROOT") {
      askForFullPath();
      return;
    }
    if (outcome.code === "MKDIR_FAILED") {
      setError(outcome.message ? `${t("rail.mkdirFailed")} — ${outcome.message}` : t("rail.mkdirFailed"));
      return;
    }
    const key = CREATE_ERROR_KEYS[outcome.code];
    setError(t(key ?? "rail.createFailed"));
  };
  return (
    <form
      className="mx-2.5 mb-1 flex flex-col gap-1.5 rounded-[10px] border border-border bg-canvas/60 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        className={inputClass}
        placeholder={t("rail.newProjectName")}
        value={name}
        maxLength={80}
        autoFocus
        onChange={(event) => {
          setName(event.target.value);
          setNameEdited(Boolean(event.target.value.trim()));
        }}
      />
      <DirectoryPicker
        id="rail-create-root"
        value={root}
        dirs={dirs}
        disabled={busy}
        ariaLabel={t("rail.newProjectRoot")}
        openSignal={openSignal}
        onQueryChange={(query) => setScope(suggestionScope(query))}
        onChange={chooseRoot}
      />
      {error ? (
        <div className={`px-0.5 text-[11px] font-semibold ${offerCreateRoot ? "text-warning" : "text-danger"}`}>{error}</div>
      ) : null}
      {offerCreateRoot ? (
        <button
          type="button"
          disabled={busy}
          className={`w-full rounded-[9px] border border-border bg-card text-[12px] font-semibold hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
            isMobile ? "min-h-11" : "py-1.5"
          }`}
          onClick={() => void submit(true)}
        >
          {t("rail.createRootAndProject")}
        </button>
      ) : null}
      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={busy}
          className={`flex-1 rounded-[9px] border border-border bg-card text-[12px] font-semibold hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
            isMobile ? "min-h-11" : "py-1.5"
          }`}
        >
          {busy ? t("rail.creating") : t("rail.create")}
        </button>
        <button
          type="button"
          className={`rounded-[9px] px-2.5 text-[12px] font-semibold text-muted hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "min-h-11" : "py-1.5"
          }`}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
      </div>
    </form>
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
  crowned = false,
  reserveCrownSlot = false,
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
  /** Pinned rows render a persistent crown marker beside the name. */
  crowned?: boolean;
  /** Mobile rails keep the crown toggle always visible, so the row's counts
      leave room for it instead of underlapping. */
  reserveCrownSlot?: boolean;
  onClick: () => void;
}) {
  const isMobile = useIsMobile();
  return (
    <button
      className={[
        "mb-0.5 flex w-full items-center gap-2 rounded-[10px] border px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        isMobile ? "min-h-11" : "py-2",
        reserveCrownSlot ? "pr-9" : "",
        active ? "border-border bg-canvas shadow-1" : "border-transparent hover:bg-canvas",
        muted ? "opacity-65" : "",
      ].join(" ")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span
        className={[
          "h-2 w-2 shrink-0 rounded-full",
          hasLive ? "animate-pulse bg-success" : muted ? "bg-strong" : "bg-strong",
        ].join(" ")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          {crowned ? <Crown className="h-3 w-3 shrink-0 fill-crown text-crown" aria-hidden data-testid="crown-marker" /> : null}
          <span className={`min-w-0 truncate text-[13px] ${active ? "font-bold" : "font-semibold"} ${muted ? "text-muted" : ""}`}>{label}</span>
        </span>
        {age ? <span className="block text-[10.5px] text-muted">{age}</span> : null}
      </span>
      {live > 0 ? <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted">{live}</span> : null}
      {attention > 0 ? <Badge tone="warning">⏸ {attention}</Badge> : null}
      {total !== null ? <span className="shrink-0 text-[11px] font-semibold text-muted">{total}</span> : null}
    </button>
  );
}
