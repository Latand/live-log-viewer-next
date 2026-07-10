"use client";

import { CornerDownRight, GitBranch, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChevronRight, X } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { registerPane } from "@/lib/chime";
import { type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { cardMigrationState, postConversationMigration } from "@/lib/accounts/migration";
import { conversationIdentity } from "@/lib/accounts/identity";

import { registerLinkTarget } from "./AgentLink";
import { DeleteFileButton } from "./DeleteFileButton";
import { MigrationDivider, MigrationRibbon } from "./MigrationRibbon";
import { EffortPills } from "./EffortPills";
import { FlipRow } from "./FlipRow";
import { LogFeed } from "./LogFeed";
import { paneState, type PaneState } from "./paneState";
import { CtxChip, GoalChip, PlanChip } from "./PlanChip";
import { ProcessStatusControls } from "./TaskHeader";
import { TmuxComposer } from "./TmuxComposer";
import { activityDot, cleanTitle, effortTint, effortTitle, engineBadge, engineEdge, fmtAge } from "./utils";

const noop = () => undefined;

/* Card treatment per lifecycle state; `glow` also feeds the orbiting border. */
const PANE_TONES: Record<PaneState, { section: string; header: string; glow?: string }> = {
  live: { section: "border-ok/60 shadow-[0_0_0_3px_rgba(47,158,68,0.16)]", header: "bg-[#eef8f0]" },
  waiting: { section: "border-[#e0ae45]/60 shadow-[0_0_0_3px_rgba(224,174,69,0.2)]", header: "bg-[#fff7e6]", glow: "#e0ae45" },
  returned: { section: "border-accent/50 shadow-[0_0_0_3px_rgba(90,81,224,0.15)]", header: "bg-[#f1f0fc]", glow: "#7a6ff0" },
  stalled: { section: "border-err/50 shadow-[0_0_0_3px_rgba(198,40,40,0.13)]", header: "bg-[#fdf0f0]", glow: "#d76a6a" },
  done: { section: "border-line", header: "bg-[#f4f4f6] text-dim opacity-80 saturate-50" },
};

/** Maps the internal (Cyrillic) file.kind discriminant to a localized label. */
export function kindLabel(t: TFunction, kind: string): string {
  if (kind === "session") return t("kind.session");
  if (kind === "subagent") return t("kind.subagent");
  if (kind === "job") return t("kind.job");
  if (kind === "background") return t("kind.background");
  return kind;
}

/** Ticking "time since the transcript last grew" — the last sign of life.
    Self-re-rendering leaf on its own interval, so the surrounding memoized
    pane tree never re-renders just to refresh a relative timestamp. */
function LastActivity({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);
  const age = now / 1000 - file.mtime;
  /* The case the chip exists for: a pane that looks busy while its transcript
     has been silent for minutes — surface the silence instead of the badge. */
  const quiet = (file.activity === "live" || file.activity === "recent") && age > 180;
  return (
    <span
      className={`shrink-0 font-mono text-[9.5px] tabular-nums ${quiet ? "font-semibold text-[#b3831d]" : "text-dim"}`}
      title={t(quiet ? "branch.lastActivityQuiet" : "branch.lastActivity", { age: fmtAge(file.mtime) })}
    >
      {fmtAge(file.mtime)}
    </span>
  );
}

interface Props {
  file: FileEntry;
  /** Background tasks attached to this column as collapsed rows. */
  tasks: FileEntry[];
  /** Column of the root conversation of a branch group. */
  isRoot: boolean;
  /** Removes the column from the managed list. */
  onClose?: () => void;
  /** Native DnD attributes on the header: drag a column by its head to reorder siblings. */
  dragHandle?: React.HTMLAttributes<HTMLElement>;
  /** Hides the tmux composer: headless runs and finished review rounds take no input. */
  noComposer?: boolean;
  /** Slim context bar pinned under the header (e.g. «Round 2 · ✖ REQUEST_CHANGES»). */
  banner?: React.ReactNode;
  /** Header control that opens this conversation full-window; the same control
      collapses it back when the pane already is the overlay (`expanded`). */
  onToggleExpand?: () => void;
  /** The pane is the full-window overlay's content: the control flips to
      collapse, and pane registries (chime, link arrows) stay with the board
      pane underneath. */
  expanded?: boolean;
  /** Far-zoom board state: pane content is unreadable behind the identity
      labels, so feeds and composer polling go to sleep until zoom returns. */
  dormant?: boolean;
}

export function BranchPane({ file, tasks, isRoot, onClose, dragHandle, noComposer, banner, onToggleExpand, expanded, dormant }: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const paneRef = useRef<HTMLElement | null>(null);
  const badge = engineBadge(file);
  const state = paneState(file);
  const tone = PANE_TONES[state];
  const migState = cardMigrationState(file.migration);
  /* Stable card identity: a committed migration gives this conversation a new
     transcript `path` under the target account, but the same conversationId. So
     the chime pane registry, the composer's held receipts, and per-card recovery
     all key on this — never on `path`, which is active-generation metadata. */
  const cardId = conversationIdentity(file);
  /* A failed per-card retry/rollback must be announced, not swallowed (finding
     3): the previous code ignored the POST result entirely. */
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  /* Retry/rollback address the durable conversation by its stable id; without a
     server-assigned conversationId the recovery route can't be targeted, so the
     actions stay hidden until the backend supplies one. */
  const recover = file.conversationId && Number.isInteger(file.migration?.revision)
    ? async (action: "retry" | "rollback") => {
        setRecoveryError(null);
        const result = await postConversationMigration(file.conversationId!, action, file.migration!.revision);
        if (!result.ok) {
          setRecoveryError(result.error ?? t(action === "retry" ? "migrate.retryFailed" : "migrate.keepFailed"));
        }
      }
    : undefined;
  /* Panes outside the viewport stop polling and parsing: the board can hold
     dozens of live conversations while only a handful fit on screen. The
     margin pre-wakes panes just beyond the edge so panning never shows a
     stale card; ancestor overflow clipping is part of the intersection, so
     a pane translated out of the board viewport counts as off screen. */
  const [offscreen, setOffscreen] = useState(() => typeof IntersectionObserver !== "undefined");
  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setOffscreen(!entries.some((entry) => entry.isIntersecting)), {
      rootMargin: "256px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const feedPaused = Boolean(dormant) || offscreen;
  /* The chime of this conversation pans to wherever this pane sits on screen.
     The overlay pane never registers: the board pane of the same path keeps
     owning both registries, so collapsing leaves them intact. */
  useEffect(() => {
    if (expanded) return;
    if (paneRef.current) return registerPane(cardId, paneRef.current);
  }, [cardId, expanded]);
  /* Link-arrow drop target; re-registers each poll so the pid stays current. */
  useEffect(() => {
    if (noComposer || expanded) return;
    if (paneRef.current) return registerLinkTarget(file, paneRef.current);
  }, [file, noComposer, expanded]);
  return (
    /* The attention comets orbit outside the card frame, so they live on an
       unclipped wrapper — inside the section they would stack against the
       colored engine marker and get cut by its overflow-hidden. */
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 ${tone.glow ? "pane-attention" : ""}`}
      style={tone.glow ? ({ "--pane-glow": tone.glow } as React.CSSProperties) : undefined}
    >
      <section
        ref={paneRef}
        /* Text inside the column must stay selectable: the canvas drag-pan skips
           presses that start here (wheel pan still covers scrolling). */
        data-pan-ignore
        data-link-path={file.path}
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border bg-panel shadow-card ${tone.section}`}
      >
        <span
          aria-hidden
          className={`w-full shrink-0 ${isRoot ? "h-1" : "h-0.5"}`}
          style={state === "done" ? { backgroundColor: "#c9c9d1" } : engineEdge(file)}
        />
        {/* Two deliberate rows: identity + actions on top (the close X pinned
            to the corner at every width), the metadata chips below. */}
        <header
          className={`flex shrink-0 flex-col gap-y-1 border-b border-line px-2.5 py-1.5 ${tone.header} ${
            dragHandle ? "cursor-grab active:cursor-grabbing" : ""
          }`}
          {...dragHandle}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`} title={t(`branch.${state}`)} />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={cleanTitle(file.title)}>
              {cleanTitle(file.title, 90)}
            </span>
            <ProcessStatusControls file={file} compact hideChip={isMobile} />
            {onToggleExpand ? (
              <button
                className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={expanded ? t("branch.collapseFull") : t("branch.expandFull", { title: cleanTitle(file.title, 60) })}
                title={expanded ? t("branch.collapseFull") : t("branch.expandFull", { title: cleanTitle(file.title, 60) })}
                onClick={onToggleExpand}
              >
                {expanded ? <Minimize2 className="h-3 w-3" aria-hidden /> : <Maximize2 className="h-3 w-3" aria-hidden />}
              </button>
            ) : null}
            <DeleteFileButton file={file} onDeleted={onClose} />
            {onClose ? (
              <button
                className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={t("branch.removeColumn", { title: cleanTitle(file.title, 60) })}
                onClick={onClose}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <LastActivity file={file} />
            {/* One identity chip: the model when known (engine lives in the tint
                and the tooltip), the engine label as fallback. */}
            {file.model ? (
              <span
                className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] font-semibold"
                style={{ backgroundColor: effortTint(file).soft, color: effortTint(file).color }}
                title={[badge.label, effortTitle(file)].filter(Boolean).join(" · ")}
              >
                {file.model}
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold" style={badge.style}>
                {badge.label}
              </span>
            )}
            <EffortPills file={file} />
            {/* The phone header keeps only actionable or alarming chips: ctx
                appears once it nears the limit, the worktree name and the
                branch-kind label yield their room to the rest of the row. */}
            {file.ctx && (!isMobile || file.ctx.pct >= 70) ? <CtxChip ctx={file.ctx} /> : null}
            {file.worktree && !isMobile ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-line/80 px-1.5 py-0.5 font-mono text-[9.5px] text-dim"
                title={t("branch.worktree", { name: file.worktree })}
              >
                <GitBranch className="h-2.5 w-2.5" aria-hidden /> {file.worktree}
              </span>
            ) : null}
            {file.plan ? <PlanChip plan={file.plan} /> : null}
            {file.goal ? <GoalChip goal={file.goal} /> : null}
            {isRoot || isMobile ? null : (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-dim"
                title={file.handoff ? t("branch.handoffTitle") : t("branch.branchTitle")}
              >
                <CornerDownRight className="h-3 w-3" aria-hidden /> {file.handoff ? t("kind.handoff") : kindLabel(t, file.kind)}
              </span>
            )}
          </div>
        </header>
        {/* Account-migration status ribbon (issue #40): sits in the same slot
            family as the flow banner. Renders only while this conversation is
            migrating; absent otherwise, so non-migrating panes are unchanged. */}
        {migState ? (
          <MigrationRibbon
            state={migState}
            targetLabel={file.migration?.targetLabel ?? file.migration?.targetAccountId ?? ""}
            currentLabel={file.migration?.sourceLabel}
            error={file.migration?.failure ?? null}
            actionError={recoveryError}
            onRetry={recover ? () => void recover("retry") : undefined}
            onKeep={recover ? () => void recover("rollback") : undefined}
          />
        ) : null}
        {banner ?? null}
        {tasks.length ? (
          <FlipRow className="shrink-0 border-b border-line bg-[#fbfbfd]" enter="fade">
            {tasks.map((task) => (
              <div key={task.path} data-flip-key={task.path}>
                <TaskStrip file={task} paused={feedPaused} />
              </div>
            ))}
          </FlipRow>
        ) : null}
        {/* The "done" seam of a committed migration: a divider naming the
            account this conversation continued from, above its transcript. */}
        <MigrationDivider predecessorLabel={file.predecessorLabel} />
        <LogFeed
          file={file}
          showSvc={false}
          lineFilter=""
          onStatus={noop}
          paused={feedPaused}
          follow
          setFollow={noop}
          compact
        />
        {noComposer ? null : <TmuxComposer file={file} pollPaused={feedPaused} />}
      </section>
    </div>
  );
}

/** Collapsed background-task row: glyph, title, PID chip, kill; click expands an inline mini feed. */
export function TaskStrip({
  file,
  paused = false,
}: {
  file: FileEntry;
  paused?: boolean;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const title = cleanTitle(file.cmdDesc || file.title, 80);
  return (
    <div className="border-t border-line first:border-t-0">
      <div className="flex min-h-7 flex-wrap items-center gap-1.5 pl-2 pr-2.5">
        <button
          className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-expanded={open}
          aria-label={t("branch.toggleBackground", { action: open ? t("branch.collapse") : t("branch.expand"), title })}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold" title={cleanTitle(file.title)}>
            {title}
          </span>
        </button>
        <ProcessStatusControls file={file} compact />
      </div>
      {open ? (
        <div className="flex h-[220px] flex-col border-t border-dashed border-line bg-bg/60">
          <LogFeed
            file={file}
            showSvc={false}
            lineFilter=""
            onStatus={noop}
            paused={paused}
            follow
            setFollow={noop}
            compact
          />
        </div>
      ) : null}
    </div>
  );
}
