"use client";

import { CornerDownRight, GitBranch, Maximize2, Minimize2, Unlink2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChevronRight, X } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { registerPane } from "@/lib/chime";
import { type TFunction, useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { cardMigrationState, postConversationMigration } from "@/lib/accounts/migration";
import { conversationIdentity } from "@/lib/accounts/identity";
import { accountIdFromPath } from "@/lib/accounts/badge";

import { AccountBadge } from "./AccountBadge";
import { registerLinkTarget } from "./AgentLink";
import { DeleteFileButton } from "./DeleteFileButton";
import { FavoriteCrown, FavoriteCrownMarker } from "./FavoriteCrown";
import { MigrationDivider, MigrationRibbon } from "./MigrationRibbon";
import { EffortPills } from "./EffortPills";
import { AgentRuntimeControls } from "./AgentRuntimeControls";
import { FlipRow } from "./FlipRow";
import { LogFeed } from "./LogFeed";
import { paneState, type PaneState } from "./paneState";
import { CtxChip, GoalChip, PlanChip } from "./PlanChip";
import { SessionTitle } from "./session/SessionTitle";
import { ProcessStatusControls } from "./TaskHeader";
import { TmuxComposer } from "./TmuxComposer";
import { RateLimitBadge } from "./RateLimitBadge";
import { StructuredSpawnStatus } from "./StructuredSpawnStatus";
import { TaskRelationStrip } from "./tasks/TaskRelationStrip";
import type { TaskRelation } from "./tasks/taskRelations";
import { WakeupChip, wakeupChipKey } from "./WakeupChip";
import { activityDot, cleanTitle, effortTint, effortTitle, engineBadge, engineEdge, fmtAge } from "./utils";

const noop = () => undefined;

/* Card treatment per lifecycle state; `glow` also feeds the orbiting border. */
const PANE_TONES: Record<PaneState, { section: string; header: string; glow?: string }> = {
  live: { section: "border-success/60 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-success)_20%,transparent)]", header: "bg-success-soft" },
  waiting: { section: "border-warning/60 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-warning)_26%,transparent)]", header: "bg-warning-soft", glow: "var(--color-warning)" },
  returned: { section: "border-accent/50 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_20%,transparent)]", header: "bg-accent-soft", glow: "var(--color-accent)" },
  stalled: { section: "border-danger/50 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_18%,transparent)]", header: "bg-danger-soft", glow: "var(--color-danger)" },
  done: { section: "border-border", header: "bg-sunken text-muted opacity-80 saturate-50" },
};

/** Maps the internal (Cyrillic) file.kind discriminant to a localized label. */
export function kindLabel(t: TFunction, kind: string): string {
  if (kind === "session") return t("kind.session");
  if (kind === "subagent") return t("kind.subagent");
  if (kind === "job") return t("kind.job");
  if (kind === "background") return t("kind.background");
  return kind;
}

export function ParentRemovedChip() {
  const { t } = useLocale();
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/80 px-1.5 py-0.5 text-[9.5px] font-semibold text-muted"
      title={t("lineage.parentRemovedTitle")}
    >
      <Unlink2 className="h-2.5 w-2.5" aria-hidden /> {t("lineage.parentRemoved")}
    </span>
  );
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
      className={`shrink-0 font-mono text-[9.5px] tabular-nums ${quiet ? "font-semibold text-warning" : "text-muted"}`}
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
  /** Owner-provided controls that belong beside the pane's native header actions. */
  headerActions?: React.ReactNode;
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
  /** Bumped to open this pane's rename editor (scheme-board F2 targets the
      expanded overlay, not the node's board pane). */
  autoEditToken?: number;
  /** Shows the proximity crown favorite control in the header (issue #185).
      Only the board node and the mobile focus pane opt in — reviewer decks,
      pipeline placeholders and other embeds render the pane without it. */
  showFavorite?: boolean;
  /** Opens a fresh editable draft from a terminal structured launch receipt. */
  onSpawnRetry?: (file: FileEntry) => void;
  /** Board tasks related to this conversation (assigned into it or captured
      from it), shown as a reserved relation strip between the header and the
      transcript — in flow, never overlaying conversation content (issue #292). */
  relatedTasks?: readonly TaskRelation[];
  /** Opens/centers a related task card — the conversation-side half of the
      bidirectional task↔agent navigation. The strip renders only when wired. */
  onOpenTask?: (task: BoardTask) => void;
}

export function BranchPane({ file, tasks, isRoot, onClose, dragHandle, noComposer, banner, headerActions, onToggleExpand, expanded, dormant, autoEditToken, showFavorite, onSpawnRetry, relatedTasks, onOpenTask }: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const paneRef = useRef<HTMLElement | null>(null);
  const badge = engineBadge(file);
  const state = paneState(file);
  const tone = PANE_TONES[state];
  /* The live runtime pill (model/effort picker) applies only to a running,
     top-level claude/codex agent, where reconfigure has a tmux session to act
     on. On the phone it is the single tappable model·reasoning control for those
     panes (issue #177 item 2). Every other phone pane collapses its model and
     reasoning into one compact read-only chip below, so the card carries exactly
     one model·reasoning element in all states. Desktop keeps its own chip +
     effort-bar pair. */
  const showRuntimeControls = !file.spawn && file.proc === "running" && !file.parent && (file.engine === "claude" || file.engine === "codex");
  const migState = cardMigrationState(file.migration);
  /* The phone metadata row scrolls horizontally to stay one line (issue #177
     item 4); this tracks whether more is clipped to the right so a fade
     affordance can show, and the row swallows its own touch gestures so a scroll
     never reaches the header swipe handler (issue #177 item 1 review). */
  const metaScrollRef = useRef<HTMLDivElement | null>(null);
  const [metaClipped, setMetaClipped] = useState(false);
  const syncMetaClip = useCallback(() => {
    const el = metaScrollRef.current;
    if (!el) return;
    const clipped = el.scrollWidth - el.clientWidth - el.scrollLeft > 4;
    setMetaClipped((prev) => (prev === clipped ? prev : clipped));
  }, []);
  useEffect(() => {
    syncMetaClip();
  }, [syncMetaClip, isMobile, file]);
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
    if (file.spawn || noComposer || expanded) return;
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
      {/* The favorited-state crown perched on the top edge (issue #224); lives on
          this unclipped wrapper so it can overhang the card frame from above. */}
      {showFavorite ? <FavoriteCrownMarker id={cardId} touch={isMobile} /> : null}
      <section
        ref={paneRef}
        /* Text inside the column must stay selectable: the canvas drag-pan skips
           presses that start here (wheel pan still covers scrolling). */
        data-pan-ignore
        data-link-path={file.path}
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border bg-card shadow-1 ${tone.section}`}
      >
        <span
          aria-hidden
          className={`w-full shrink-0 ${isRoot ? "h-1" : "h-0.5"}`}
          style={state === "done" ? { backgroundColor: "var(--color-strong)" } : engineEdge(file)}
        />
        {/* Two deliberate rows: identity + actions on top (the close X pinned
            to the corner at every width), the metadata chips below. */}
        <header
          className={`flex shrink-0 flex-col gap-y-1 border-b border-border px-2.5 py-1.5 ${tone.header} ${
            dragHandle ? "cursor-grab active:cursor-grabbing" : ""
          }`}
          {...dragHandle}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`} title={t(`branch.${state}`)} />
            {file.renamable ? (
              <SessionTitle file={file} displayMax={90} titleClassName="text-[12px] font-semibold" alwaysVisible={isMobile} autoEditToken={autoEditToken} />
            ) : (
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={cleanTitle(file.title)}>
                {cleanTitle(file.title, 90)}
              </span>
            )}
            <ProcessStatusControls file={file} compact hideChip={isMobile} />
            {showFavorite ? <FavoriteCrown id={cardId} cardRef={paneRef} touch={isMobile} /> : null}
            {onToggleExpand ? (
              <button
                className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  isMobile ? "h-11 w-11" : "px-1.5 py-0.5"
                }`}
                aria-label={expanded ? t("branch.collapseFull") : t("branch.expandFull", { title: cleanTitle(file.title, 60) })}
                title={expanded ? t("branch.collapseFull") : t("branch.expandFull", { title: cleanTitle(file.title, 60) })}
                onClick={onToggleExpand}
              >
                {expanded ? <Minimize2 className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden /> : <Maximize2 className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />}
              </button>
            ) : null}
            {headerActions}
            {file.spawn ? null : <DeleteFileButton file={file} onDeleted={onClose} />}
            {onClose ? (
              <button
                className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  isMobile ? "h-11 w-11" : "px-1.5 py-0.5"
                }`}
                aria-label={t("branch.removeColumn", { title: cleanTitle(file.title, 60) })}
                onClick={onClose}
              >
                <X className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
              </button>
            ) : null}
          </div>
          <div
            className="relative flex min-w-0 items-center gap-x-1.5"
            /* The metadata row owns its own touch gestures on the phone so a
               horizontal scroll to reveal clipped chips stays here and never
               reaches MobileFocusView's header swipe (which would switch
               conversations). The title row above still answers to swipes. */
            onTouchStart={isMobile ? (event) => event.stopPropagation() : undefined}
            onTouchEnd={isMobile ? (event) => event.stopPropagation() : undefined}
          >
            {/* Context usage is pinned first and never scrolls on the phone
                (issue #177 item 1): the exact % leads the chip face so it stays
                on screen through any overflow of the row beside it. Desktop keeps
                ctx inline in the wrapping row. */}
            {isMobile && file.ctx ? <CtxChip ctx={file.ctx} /> : null}
            <div
              ref={metaScrollRef}
              onScroll={isMobile ? syncMetaClip : undefined}
              /* Fade the trailing content when the phone row still has clipped
                 chips — a background-independent scroll affordance that works over
                 the tinted header tones. */
              style={isMobile && metaClipped ? { maskImage: "linear-gradient(to right, #000 calc(100% - 20px), transparent)", WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 20px), transparent)" } : undefined}
              className={`flex min-w-0 items-center gap-x-1.5 gap-y-1 ${
                isMobile ? "no-scrollbar flex-nowrap overflow-x-auto" : "flex-wrap"
              }`}
            >
              <LastActivity file={file} />
              {/* Model + reasoning. The phone shows one element (issue #177 item
                  2): a running root claude/codex pane gets the tappable picker
                  pill, every other phone pane a single «model · reasoning»
                  read-only chip. Desktop is unchanged — the observed model chip
                  and effort bars always render, and the runtime picker rides
                  alongside them for a running root agent. */}
              {isMobile ? (
                showRuntimeControls ? (
                  <AgentRuntimeControls file={file} />
                ) : file.model ? (
                  <span
                    className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
                    style={{ backgroundColor: effortTint(file).soft, color: effortTint(file).color }}
                    title={[badge.label, effortTitle(file)].filter(Boolean).join(" · ")}
                  >
                    {file.effort ? `${file.model} · ${file.effort}` : file.model}
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold" style={badge.style}>
                    {badge.label}
                  </span>
                )
              ) : (
                <>
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
                  {showRuntimeControls ? <AgentRuntimeControls file={file} /> : null}
                </>
              )}
              <RateLimitBadge rateLimit={file.rateLimit} />
              {/* Scheduled-wakeup chip (#165): a pending self-wake shows on every
                  surface, phone included, since it is actionable status. */}
              <WakeupChip key={wakeupChipKey(file.pendingWakeup)} wakeup={file.pendingWakeup} />
              {file.parentRemoved ? <ParentRemovedChip /> : null}
              {/* Desktop keeps ctx inline here; on mobile it is pinned ahead of
                  this scroller. */}
              {!isMobile && file.ctx ? <CtxChip ctx={file.ctx} /> : null}
              {file.worktree && !isMobile ? (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/80 px-1.5 py-0.5 font-mono text-[9.5px] text-muted"
                  title={t("branch.worktree", { name: file.worktree })}
                >
                  <GitBranch className="h-2.5 w-2.5" aria-hidden /> {file.worktree}
                </span>
              ) : null}
              {/* Account badge (issue #229): the third meta-chip, after ctx and
                  the branch chip. Shell tasks carry no account, so they skip it;
                  the id is read from the live transcript path so a migrated
                  conversation reflects its current account. */}
              {file.engine === "shell" ? null : <AccountBadge engine={file.engine} accountId={file.spawn?.accountId ?? accountIdFromPath(file.path)} />}
              {file.plan ? <PlanChip plan={file.plan} /> : null}
              {file.goal ? <GoalChip goal={file.goal} /> : null}
              {isRoot || isMobile ? null : (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted"
                  title={file.handoff ? t("branch.handoffTitle") : t("branch.branchTitle")}
                >
                  <CornerDownRight className="h-3 w-3" aria-hidden /> {file.handoff ? t("kind.handoff") : kindLabel(t, file.kind)}
                </span>
              )}
            </div>
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
        {relatedTasks?.length && onOpenTask ? <TaskRelationStrip relations={relatedTasks} onOpenTask={onOpenTask} /> : null}
        {tasks.length ? (
          <FlipRow className="shrink-0 border-b border-border bg-sunken" enter="fade">
            {tasks.map((task) => (
              <div key={task.path} data-flip-key={task.path}>
                <TaskStrip file={task} paused={feedPaused} />
              </div>
            ))}
          </FlipRow>
        ) : null}
        {file.spawn ? (
          <StructuredSpawnStatus spawn={file.spawn} onRetry={onSpawnRetry ? () => onSpawnRetry(file) : undefined} />
        ) : (
          <>
            {/* The "done" seam of a committed migration names the account this
                conversation continued from, above its transcript. */}
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
          </>
        )}
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
    <div className="border-t border-border first:border-t-0">
      {/* 44px expand target on the phone (issue #148); desktop keeps its compact
          28px row via the sm: reset. These rows ride inside conversation panes
          and the docked-task section, both reachable by ordinary taps at 390px. */}
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 pl-2 pr-2.5 sm:min-h-7">
        <button
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-7"
          aria-expanded={open}
          aria-label={t("branch.toggleBackground", { action: open ? t("branch.collapse") : t("branch.expand"), title })}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold" title={cleanTitle(file.title)}>
            {title}
          </span>
        </button>
        <ProcessStatusControls file={file} compact />
      </div>
      {open ? (
        <div className="flex h-[220px] flex-col border-t border-dashed border-border bg-canvas/60">
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
