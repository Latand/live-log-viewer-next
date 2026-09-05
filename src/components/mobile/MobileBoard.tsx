"use client";

import { ChevronRight, Command, Crown, MessageCircle, Mic, Sparkle } from "@/components/icons";
import { useLayoutEffect, useRef } from "react";
import { captureCatalogPosition, restoreCatalogPosition, type CatalogPosition } from "./MobileInlineCatalog";
import { Bot } from "lucide-react";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { stageChipLabel } from "../pipelines/pipelineModel";
import { formatResetClock } from "../rateLimit";
import { clockDuration, humanizeDuration } from "../turnDuration";

import {
  buildMobileBoard,
  type MobileBoardConversation,
  type MobileBoardModel,
  type MobileBoardPipelineRow,
  type MobileRowState,
} from "./mobileBoardModel";

/*
 * The phone's board (issue #1439, lane 2; docs/design/mobile-v2/README.md
 * §4.1). One primary surface: the orchestrator seat first, then the queue, the
 * pipelines summary, what is running, and three recent rows with the catalog
 * behind them.
 *
 * A row is dot · title · one meta line · one trailing element. On a row that
 * needs the operator the 3 px edge and the badge are the two coloured elements
 * and the meta line stays in secondary text; on a working row the meta reads
 * the state phrase, what the agent is doing now, and the engine mark with the
 * model. Every row ends with «started 3h ago» when the transcript names its
 * launch (#1487): the phrase's own age is the state's clock — how long owed,
 * how long this turn, how long since the last move — and the launch is the
 * other thing the operator asked to read everywhere, so both ride the line,
 * each under its own word. The state phrase, the model and the launch never
 * truncate: the now-fragment is the ONE fragment that gives way, because it
 * changes every few seconds and is whole one tap away, while the other three
 * are the row's identity and its two clocks. There is no Host section: host
 * detail lives behind ⋯ › Host details (`MobileHostSheet`), and degradation is
 * the shell banner's job.
 *
 * Everything the board shows comes from `mobileBoardModel`, so the grouping,
 * the precedence and the badge count are decided in one pure place and this
 * file only says what they look like in the operator's words.
 */

const CARD = "flex w-full items-center gap-2.5 rounded-[12px] bg-card py-2 pl-3 pr-2.5 text-left shadow-1 active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
const EDGE: Record<"warning" | "danger", string> = {
  warning: "shadow-[inset_3px_0_0_var(--color-warning),var(--shadow-1)]",
  danger: "shadow-[inset_3px_0_0_var(--color-danger),var(--shadow-1)]",
};
const DOT: Record<MobileRowState["dot"], string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  neutral: "bg-strong",
};
const BADGE_TONE: Record<string, string> = {
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

/** The section header (the prototype's `.sh`): a label and its count. */
function Section({ label, count, id }: { label: string; count?: number; id?: string }) {
  return (
    <div data-mobile2-section={id} className="flex min-h-[34px] items-center gap-1.5 px-3 pt-1.5 text-label font-semibold text-secondary">
      {label}
      {count === undefined ? null : <span className="text-caption font-semibold tabular-nums text-muted">{count}</span>}
    </div>
  );
}

/** The engine mark: a 16 px glyph in secondary colour. The only avatar left. */
function EngineMark({ engine }: { engine: string }) {
  const Glyph = engine === "codex" ? Command : engine === "openclaw" ? MessageCircle : Sparkle;
  return (
    <span className="inline-grid h-4 w-4 shrink-0 place-items-center text-secondary" data-mobile2-engine={engine}>
      <Glyph className="h-[13px] w-[13px]" aria-hidden />
    </span>
  );
}

function Badge({ tone, children }: { tone: "warning" | "danger"; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center rounded-full px-[7px] text-caption font-semibold leading-none ${BADGE_TONE[tone]}`}>
      {children}
    </span>
  );
}

/** The launch's age, to one unit (#1487): «started 2h ago», never «2h 25m».
    The state's own age keeps its precision — it is the clock the operator
    acts on — and the launch is context, so it takes the row's width only for
    the digit that matters. */
export function launchAge(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const unit = total >= 3600 ? 3600 : total >= 60 ? 60 : 1;
  return humanizeDuration(Math.floor(total / unit) * unit);
}

/** The state phrase of a row, in the operator's words. It never truncates.
    `now` dates the limit's reset — today's shows the hour, a later one the day
    with it — so the row reads «Main resets 16:40» (README §4.2). */
export function statePhrase(t: TFunction, state: MobileRowState, now: number): string {
  const seconds = state.seconds ?? 0;
  switch (state.key) {
    case "killed":
      /* The age the model computes, like every neighbour; and nothing about a
         queue — a killed row never measured one (#1487). */
      return t("mobile2.board.killedAge", { age: humanizeDuration(seconds) });
    case "stalled":
      return t("mobile2.board.stalled", { age: humanizeDuration(seconds) });
    case "limit": {
      /* The wall the operator is actually waiting on is WHEN it lifts, and on
         which account. A read that names neither still says the row is at a
         limit — the badge beside it says «limit» either way. */
      if (state.resetAt === null) return state.account ? t("mobile2.board.limitAccount", { account: state.account }) : t("mobile2.board.limit");
      const resets = formatResetClock(state.resetAt, now);
      return state.account
        ? t("mobile2.board.limitAccountResets", { account: state.account, time: resets })
        : t("mobile2.board.limitResets", { time: resets });
    }
    case "held":
      return t("mobile2.board.heldQueued", { count: state.held });
    case "waiting":
      return t("mobile2.board.waiting", { age: humanizeDuration(seconds) });
    case "working":
      return state.seconds === null ? t("mobile2.board.workingNow") : t("mobile2.board.workingFor", { elapsed: clockDuration(seconds) });
    case "returned":
      return t("mobile2.board.returned", { age: humanizeDuration(seconds) });
    case "done":
      return t("mobile2.board.done", { age: humanizeDuration(seconds) });
  }
}

const BADGE_LABEL = {
  question: "mobile2.board.badgeQuestion",
  plan: "mobile2.board.badgePlan",
  decision: "mobile2.board.badgeDecision",
  attention: "mobile2.board.badgeAttention",
  stalled: "mobile2.board.badgeStalled",
  limit: "mobile2.board.badgeLimit",
} as const;

function ConversationRow({ row, quiet, now, onOpen }: { row: MobileBoardConversation; quiet?: boolean; now: number; onOpen: (file: FileEntry) => void }) {
  const { t } = useLocale();
  const { state } = row;
  const edge = state.edge ? EDGE[state.edge] : "";
  return (
    <button
      type="button"
      data-mobile2-row="conversation"
      data-mobile2-go="chat"
      data-mobile2-state={state.key}
      data-mobile2-path={row.path}
      aria-label={t("mobile2.board.openConversation", { title: row.title })}
      className={`${CARD} min-h-14 ${quiet ? "bg-quiet shadow-none ring-1 ring-inset ring-border" : ""} ${edge}`}
      onClick={() => onOpen(row.file)}
    >
      {/* On an edged row the edge IS the state mark, so the dot stops being a
          third coloured element — but it keeps its 8 px of the row, or the
          titles of an edged and an unedged row would not line up (the
          prototype's `.row.wait .dot { visibility: hidden }`). */}
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${state.edge ? "invisible" : DOT[state.dot]} ${state.key === "working" ? "motion-safe:animate-pulse" : ""}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`flex items-center gap-1.5 text-body font-semibold leading-[1.25] ${quiet ? "text-secondary" : "text-primary"}`}>
          <span className={state.edge ? "min-w-0 line-clamp-2" : "min-w-0 truncate"}>{row.title}</span>
          {row.crowned ? <Crown className="h-3.5 w-3.5 shrink-0 fill-crown text-crown" aria-hidden /> : null}
        </span>
        <span className="flex items-center gap-[5px] overflow-hidden text-label tabular-nums text-muted">
          <span data-mobile2-phrase className={`shrink-0 ${state.badge ? "" : PHRASE_TONE[state.key]}`}>{statePhrase(t, state, now)}</span>
          {row.now ? (
            /* The one elastic fragment of the line: it absorbs whatever the
               row cannot fit, so the model and the launch stay whole at
               390 px. Its separator rides inside it and goes with it. */
            <span data-mobile2-now className="min-w-0 truncate">
              <span aria-hidden className="mr-[5px] opacity-60">·</span>
              {row.now}
            </span>
          ) : null}
          {row.file.model ? (
            <>
              <span aria-hidden className="shrink-0 opacity-60">·</span>
              <EngineMark engine={row.file.engine} />
              <span data-mobile2-model className="shrink-0">{row.file.model}</span>
            </>
          ) : null}
          {row.launchedAt === null ? null : (
            <>
              <span aria-hidden className="shrink-0 opacity-60">·</span>
              <span data-mobile2-started className="shrink-0">{t("mobile2.board.started", { age: launchAge(now - row.launchedAt) })}</span>
            </>
          )}
        </span>
      </span>
      {state.badge ? (
        <Badge tone={state.edge ?? "warning"}>{t(BADGE_LABEL[state.badge])}</Badge>
      ) : (
        <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
      )}
    </button>
  );
}

/** The meta line's tone: only the phrase of a state that is not a badge carries
    colour, so a row never shows more than two coloured elements. */
const PHRASE_TONE: Record<MobileRowState["key"], string> = {
  killed: "font-semibold text-danger",
  stalled: "font-semibold text-danger",
  limit: "font-semibold text-warning",
  held: "font-semibold text-warning",
  waiting: "font-semibold text-warning",
  working: "font-semibold text-success",
  returned: "",
  done: "",
};

/**
 * A pipeline in `needs_decision` is a queue row like any other (README §4.1),
 * on the board and in the queue sheet the badge opens — the same component, so
 * the two entries cannot describe the same pipeline differently.
 *
 * Its destination is the pipeline screen, which lane 7 brings. Until that
 * screen exists there is nowhere to go, so the row is a statement and NOT a
 * control: rendering a button that answers a tap with nothing is worse than
 * rendering none. Lane 7 passes `onOpen` and the same row becomes the door.
 */
export function MobilePipelineQueueRow({ row, onOpen }: { row: MobileBoardPipelineRow; onOpen?: (pipeline: Pipeline) => void }) {
  const { t } = useLocale();
  /* The stage in the operator's words — the role's name, «review loop» for a
     loop — never the raw stage id, and lowercased inside the sentence the way
     the prototype writes it: «stage 3/5 · review failed · 2 findings». */
  const stageName = row.stageRef ? stageChipLabel(t, row.stageRef).toLocaleLowerCase() : "";
  const meta = [
    /* `stage k/n · <stage> · <state>` (README §4.1, §4.7). The state word is
       the failing round's — «needs a decision» is already the badge, so saying
       it twice would leave the row without the fact that put it here. */
    t(row.stageFailed ? "mobile2.board.pipelineStageFailed" : "mobile2.board.pipelineStage", { stage: row.stage, total: row.total, name: stageName }),
    row.findings ? t("mobile2.board.pipelineFindings", { count: row.findings }) : null,
  ].filter(Boolean).join(" · ");
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, onClick: () => onOpen(row.pipeline), "aria-label": t("mobile2.board.openPipeline", { task: row.task }) } : {})}
      data-mobile2-row="pipeline"
      data-mobile2-go={onOpen ? "pipeline" : undefined}
      data-mobile2-pipeline-row={row.id}
      data-mobile2-state="needs_decision"
      className={`${CARD} min-h-14 ${EDGE.warning}`}
    >
      {/* The hidden dot keeps this row's title on the same line as every other
          row's (the prototype's `.row.wait .dot`). */}
      <span aria-hidden className="invisible h-2 w-2 shrink-0 rounded-full" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-body font-semibold leading-[1.25] text-primary">
          <span className="min-w-0 line-clamp-2">{row.task}</span>
        </span>
        <span className="flex items-center gap-[5px] overflow-hidden text-label tabular-nums text-muted">
          <span className="shrink-0">{meta}</span>
          {row.seconds === null ? null : (
            <>
              <span aria-hidden className="shrink-0 opacity-60">·</span>
              <span className="min-w-0 truncate">{humanizeDuration(row.seconds)}</span>
            </>
          )}
        </span>
      </span>
      <Badge tone="warning">{t("mobile2.board.badgeDecision")}</Badge>
    </Tag>
  );
}

/** The pipelines summary: one dot, one line, one chevron. Its own warning
    moved up into the queue, so this row carries no edge. */
function PipelinesRow({ model, onOpen }: { model: MobileBoardModel; onOpen?: () => void }) {
  const { t } = useLocale();
  const summary = model.pipelines;
  if (!summary) return null;
  const parts = [
    summary.active ? t("mobile2.board.pipelinesActive", { count: summary.active }) : null,
    summary.needsDecision ? t("mobile2.board.pipelinesNeedYou", { count: summary.needsDecision }) : null,
    summary.completed ? t("mobile2.board.pipelinesDone", { count: summary.completed }) : null,
  ].filter(Boolean).join(" · ");
  const dot = summary.needsDecision ? "warning" : summary.active ? "accent" : "neutral";
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": t("mobile2.board.openPipelines") } : {})}
      data-mobile2-go={onOpen ? "pipelines" : undefined}
      data-mobile2-row="pipelines"
      className={`${CARD} min-h-14`}
    >
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[dot]}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-semibold leading-[1.25] text-primary">
          {t("mobile2.board.pipelinesCount", { count: summary.total })}
        </span>
        <span className="truncate text-label tabular-nums text-muted">{parts}</span>
      </span>
      {onOpen ? <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden /> : null}
    </Tag>
  );
}

/** What the board is built from; `mobileBoardOf` answers from exactly this,
    so a surface that must agree with the list (the bar's badge count) reads
    the same model without rendering it. */
export interface MobileBoardData {
  files: readonly FileEntry[];
  pipelines: readonly Pipeline[];
  project: string;
  /** The seat's own conversation: the card above the sections, never a row. */
  seatPath?: string | null;
  hidden?: ReadonlySet<string>;
  archived?: ReadonlySet<string>;
  crowned?: ReadonlySet<string>;
  /** Epoch seconds; the dashboard's ticking clock keeps the ages honest. */
  now?: number;
}

export interface MobileBoardProps extends MobileBoardData {
  /** The seat card (lane 6 replaces the pinned row with it). */
  seat?: React.ReactNode;
  /** Conversations in the catalog behind «All conversations · n ›». */
  catalogCount?: number;
  catalogState?: "loading" | "error";
  catalogExpanded?: boolean;
  catalog?: React.ReactNode;
  catalogPosition?: CatalogPosition;
  onOpenConversation: (file: FileEntry) => void;
  onOpenPipeline?: (pipeline: Pipeline) => void;
  onOpenPipelines?: () => void;
  onOpenCatalog?: () => void;
}

/** The model the board renders, for the surfaces that must agree with it (the
    bar's badge count above all). Pure; safe to call in a render. */
export function mobileBoardOf(props: MobileBoardData): MobileBoardModel {
  return buildMobileBoard({
    files: props.files,
    pipelines: props.pipelines,
    project: props.project,
    seatPath: props.seatPath ?? null,
    hidden: props.hidden,
    archived: props.archived,
    crowned: props.crowned,
    now: props.now,
  });
}

/**
 * The board's footer (README §4.1, §7 Q2): one 44 px target that lands the
 * operator in the orchestrator's conversation with something to say. It never
 * sends from the board — the reply is written in the conversation — so the mark
 * and the mic are one button's parts, not controls of their own.
 *
 * Over a VACANCY the same slot is the invitation's other half (lane 6): the
 * footer says what the board is missing and opens the create draft. There is
 * no mic on it, because there is nothing yet to dictate to.
 */
export function MobileBoardDock({ onTell, create = false, unresolved = false }: { onTell: () => void; create?: boolean; unresolved?: boolean }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      data-mobile2-board-dock
      data-mobile2-go="chat"
      aria-label={t("mobile2.board.tellOrchestratorLabel")}
      className="flex min-h-11 w-full items-center gap-2 rounded-full border border-border bg-sunken pl-2 pr-1.5 text-left text-body text-muted active:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      onClick={onTell}
    >
      <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
        <Bot className="h-[15px] w-[15px]" />
      </span>
      <span className={`min-w-0 flex-1 truncate ${create ? "text-accent" : ""}`}>
        {t(unresolved ? "mobile2.board.orchestrator" : create ? "mobile2.seat.createDock" : "mobile2.board.tellOrchestrator")}
      </span>
      {create ? (
        <ChevronRight aria-hidden className="mr-1.5 h-4 w-4 shrink-0 text-accent" />
      ) : (
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center text-secondary">
          <Mic className="h-[17px] w-[17px]" />
        </span>
      )}
    </button>
  );
}

export function MobileBoard(props: MobileBoardProps) {
  const { t } = useLocale();
  const { seat, onOpenConversation, onOpenPipeline, onOpenPipelines, onOpenCatalog, catalogCount } = props;
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroll.current && props.catalogPosition && props.catalogExpanded) restoreCatalogPosition(scroll.current, props.catalogPosition);
  }, [props.project, props.catalogPosition, props.catalogExpanded]);
  const model = mobileBoardOf(props);
  const now = props.now ?? Date.now() / 1000;
  const pipelinesRow = model.pipelines ? <PipelinesRow model={model} onOpen={onOpenPipelines} /> : null;
  const stack = (children: React.ReactNode) => <div className="flex flex-col gap-1.5 px-3">{children}</div>;
  return (
    <div ref={scroll} onScroll={() => { if (scroll.current && props.catalogPosition && props.catalogExpanded) captureCatalogPosition(scroll.current, props.catalogPosition); }} data-mobile2-board className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-3">
      {seat ? (
        <>
          <Section label={t("mobile2.board.orchestrator")} id="orchestrator" />
          {seat}
        </>
      ) : null}

      {model.needsYou.length ? (
        <>
          <Section label={t("mobile2.board.needsYou")} count={model.needsYou.length} id="needs" />
          {stack(model.needsYou.map((item) => (item.kind === "conversation" ? (
            <ConversationRow key={item.path} row={item} now={now} onOpen={onOpenConversation} />
          ) : (
            /* `onOpenPipeline` passes THROUGH: undefined means no pipeline
               screen exists yet, and the row renders as a statement rather
               than as a button that swallows the tap. */
            <MobilePipelineQueueRow key={item.id} row={item} onOpen={onOpenPipeline} />
          ))))}
        </>
      ) : null}

      {model.pipelinesFirst && pipelinesRow ? (
        <>
          <Section label={t("mobile2.board.pipelines")} count={model.pipelines?.total} id="pipelines" />
          {stack(pipelinesRow)}
        </>
      ) : null}

      <Section label={t("mobile2.board.working")} count={model.working.length} id="working" />
      {stack(model.working.length
        ? model.working.map((row) => <ConversationRow key={row.path} row={row} now={now} onOpen={onOpenConversation} />)
        : <div className="p-4 text-center text-ui text-muted">{t("mobile2.board.nothingRunning")}</div>)}

      {!model.pipelinesFirst && pipelinesRow ? (
        <>
          <Section label={t("mobile2.board.pipelines")} count={model.pipelines?.total} id="pipelines" />
          {stack(pipelinesRow)}
        </>
      ) : null}

      <Section label={t("mobile2.board.recent")} count={model.recentTotal} id="recent" />
      {stack(
        <>
          {model.recent.map((row) => <ConversationRow key={row.path} row={row} quiet now={now} onOpen={onOpenConversation} />)}
          {onOpenCatalog ? (
            <button
              type="button"
              data-mobile2-row="catalog"
              className={`${CARD} min-h-14 bg-quiet shadow-none ring-1 ring-inset ring-border`}
              aria-expanded={props.catalogExpanded}
              onClick={onOpenCatalog}
            >
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-strong" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body font-semibold leading-[1.25] text-secondary">{t("mobile2.board.allConversations")}</span>
                <span className="truncate text-label tabular-nums text-muted">
                  {catalogCount === undefined
                    ? t(props.catalogState === "error" ? "list.failed" : props.catalogState === "loading" ? "common.loading" : "mobile.catalog.unknown")
                    : t("mobile.catalog.count", { count: catalogCount })}
                </span>
              </span>
              <ChevronRight className={`h-[18px] w-[18px] shrink-0 text-muted ${props.catalogExpanded ? "rotate-90" : ""}`} aria-hidden />
            </button>
          ) : null}
          {props.catalogExpanded ? props.catalog : null}
        </>,
      )}
    </div>
  );
}
