"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { CreateProjectOutcome } from "@/hooks/useProjectCuration";
import { projectMatchesQuery } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Workflow } from "@/lib/workflows/types";

import { AccessQrButton } from "./AccessQrButton";
import { CatalogFailureNotice } from "./CatalogFailureNotice";
import { FlipRow } from "./FlipRow";
import { Archive, ChevronRight, Crown, FolderPlus, Loader2 } from "./icons";
import { LanguageToggle } from "./LanguageToggle";
import { LimitsFooter } from "./LimitsFooter";
import { buildProjectSummaries, OVERVIEW, partitionCrownedSummaries, type ProjectSummary } from "./projectModel";
import { PushBell } from "./PushBell";
import { ResourcesFooter } from "./ResourcesFooter";
import { fmtAge } from "./utils";

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
  onCreateProject?: (name: string, root: string) => Promise<CreateProjectOutcome>;
}

const EMPTY_CROWNS: ReadonlySet<string> = new Set();

export function ProjectRail({ files, projectCatalog, projectDisplayNames = {}, pipelines, workflows, archivedProjects, crownedProjects = EMPTY_CROWNS, selected, loaded, catalogFailures = 0, now, onSelect, onToggleCrown, onCreateProject }: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
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
          <button
            type="button"
            className={`flex shrink-0 items-center justify-center rounded-[9px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              isMobile ? "min-h-11 min-w-11" : "w-7"
            } ${createOpen ? "text-primary" : ""}`}
            title={t("rail.createProject")}
            aria-label={t("rail.createProject")}
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((value) => !value)}
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden />
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
            <div className="px-3 py-4 text-center text-[12px] text-muted">{t("common.nothingFound")}</div>
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
   anything unrecognized falls back to the generic failure line. */
const CREATE_ERROR_KEYS: Record<string, "rail.invalidName" | "rail.invalidRoot" | "rail.duplicateProject"> = {
  INVALID_NAME: "rail.invalidName",
  INVALID_ROOT: "rail.invalidRoot",
  INVALID_REQUEST: "rail.invalidRoot",
  DUPLICATE_PROJECT: "rail.duplicateProject",
};

function CreateProjectForm({
  onCreate,
  onCreated,
  onCancel,
}: {
  onCreate: (name: string, root: string) => Promise<CreateProjectOutcome>;
  onCreated: (project: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputClass = `w-full rounded-[9px] border border-border bg-canvas px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
    isMobile ? "min-h-11" : "py-1.5"
  }`;
  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError(t("rail.invalidName"));
      return;
    }
    if (!root.trim()) {
      setError(t("rail.invalidRoot"));
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await onCreate(name.trim(), root.trim());
    setBusy(false);
    if (outcome.ok) {
      onCreated(outcome.project);
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
        onChange={(event) => setName(event.target.value)}
      />
      <input
        className={inputClass}
        placeholder={t("rail.newProjectRoot")}
        value={root}
        spellCheck={false}
        onChange={(event) => setRoot(event.target.value)}
      />
      {error ? <div className="px-0.5 text-[11px] font-semibold text-danger">{error}</div> : null}
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
