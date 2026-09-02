"use client";

import { ChevronRight, Command, Crown, MessageCircle, Sparkle } from "@/components/icons";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
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
 * model. The state phrase never truncates — the model and the now-fragment do
 * first. There is no Host section: host detail lives behind ⋯ › Host details
 * (`MobileHostSheet`), and degradation is the shell banner's job.
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

/** The state phrase of a row, in the operator's words. It never truncates. */
export function statePhrase(t: TFunction, state: MobileRowState): string {
  const seconds = state.seconds ?? 0;
  switch (state.key) {
    case "killed":
      return t("mobile2.board.killed");
    case "stalled":
      return t("mobile2.board.stalled", { age: humanizeDuration(seconds) });
    case "limit":
      return t("mobile2.board.limit");
    case "held":
      return t("mobile2.board.held", { count: state.held });
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

function ConversationRow({ row, quiet, onOpen }: { row: MobileBoardConversation; quiet?: boolean; onOpen: (file: FileEntry) => void }) {
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
      {state.edge ? null : <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[state.dot]} ${state.key === "working" ? "motion-safe:animate-pulse" : ""}`} />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`flex items-center gap-1.5 text-body font-semibold leading-[1.25] ${quiet ? "text-secondary" : "text-primary"}`}>
          <span className={state.edge ? "min-w-0 line-clamp-2" : "min-w-0 truncate"}>{row.title}</span>
          {row.crowned ? <Crown className="h-3.5 w-3.5 shrink-0 fill-crown text-crown" aria-hidden /> : null}
        </span>
        <span className="flex items-center gap-[5px] overflow-hidden text-label tabular-nums text-muted">
          <span data-mobile2-phrase className={`shrink-0 ${state.badge ? "" : PHRASE_TONE[state.key]}`}>{statePhrase(t, state)}</span>
          {row.now ? (
            <>
              <span aria-hidden className="shrink-0 opacity-60">·</span>
              <span className="min-w-0 truncate">{row.now}</span>
            </>
          ) : null}
          {row.file.model ? (
            <>
              <span aria-hidden className="shrink-0 opacity-60">·</span>
              <EngineMark engine={row.file.engine} />
              <span className="min-w-0 truncate">{row.file.model}</span>
            </>
          ) : null}
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

/** A pipeline in `needs_decision` is a queue row like any other (README §4.1).
    Its destination is the pipeline screen, which lane 7 brings; until then the
    row states the decision without pretending to be a door. */
function PipelineNeedsRow({ row, onOpen }: { row: MobileBoardPipelineRow; onOpen?: (pipeline: Pipeline) => void }) {
  const { t } = useLocale();
  const meta = [
    t("mobile2.board.pipelineStage", { stage: row.stage, total: row.total, name: row.stageName }),
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

export function MobileBoard(props: MobileBoardProps) {
  const { t } = useLocale();
  const { seat, onOpenConversation, onOpenPipeline, onOpenPipelines, onOpenCatalog, catalogCount } = props;
  const model = mobileBoardOf(props);
  const pipelinesRow = model.pipelines ? <PipelinesRow model={model} onOpen={onOpenPipelines} /> : null;
  const stack = (children: React.ReactNode) => <div className="flex flex-col gap-1.5 px-3">{children}</div>;
  return (
    <div data-mobile2-board className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-3">
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
            <ConversationRow key={item.path} row={item} onOpen={onOpenConversation} />
          ) : (
            <PipelineNeedsRow key={item.id} row={item} onOpen={(pipeline) => onOpenPipeline?.(pipeline)} />
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
        ? model.working.map((row) => <ConversationRow key={row.path} row={row} onOpen={onOpenConversation} />)
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
          {model.recent.map((row) => <ConversationRow key={row.path} row={row} quiet onOpen={onOpenConversation} />)}
          {onOpenCatalog ? (
            <button
              type="button"
              data-mobile2-row="catalog"
              className={`${CARD} min-h-14 bg-quiet shadow-none ring-1 ring-inset ring-border`}
              onClick={onOpenCatalog}
            >
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-strong" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body font-semibold leading-[1.25] text-secondary">{t("mobile2.board.allConversations")}</span>
                <span className="truncate text-label tabular-nums text-muted">
                  {t("mobile2.board.catalogCount", { count: catalogCount ?? model.recentTotal })}
                </span>
              </span>
              <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
            </button>
          ) : null}
        </>,
      )}
    </div>
  );
}
