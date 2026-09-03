"use client";

import { Archive, Check, Pause, Play, RefreshCw, SkipForward } from "lucide-react";

import { ChevronRight, Loader2, X } from "@/components/icons";
import { useSyncExternalStore } from "react";

import { useLocale, type TFunction } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineAction, PipelineStage } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import {
  attemptNavTarget,
  latestAttempt,
  patchPipeline,
  pipelineLinkedTasks,
  pipelineStagePosition,
  resolveStageNavFile,
  stageChipLabel,
  stageChipState,
} from "../pipelines/pipelineModel";
import { VerdictFindings } from "../pipelines/VerdictPopover";
import { humanizeDuration } from "../turnDuration";
import { RECEIPT_MS, showReceipt, type ReceiptTimers } from "./MobileReceipt";
import { MobileShell, type MobileShellHost, type SheetRenderer } from "./MobileShell";
import { useMobileNavStore } from "./mobileNav";

/*
 * One pipeline on the phone (issue #1439, lane 7; docs/design/mobile-v2/
 * README.md §4.7). The bar's title cell IS the header: the task title and a
 * meta line — `needs a decision · stage 3/5 · 2h ago` — so the screen carries
 * no header block and no template line; the stage list below says the rest.
 *
 * Under it, in order: the findings of the round that parked the chain, the
 * actions for the current state as two 44 px buttons, the stage list as one
 * card with an accent edge on the current stage, and the linked tasks.
 *
 * Every action reaches the SAME `patchPipeline` the desktop's strip, hub and
 * verdict popover reach — retry-stage, skip-stage, pause, resume, close — and
 * acts on the tap that names it, with no confirmation prompt (README §2 rule
 * 9, Q4).
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * The two acts the engine cannot take back                                    *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * `skip-stage` and `close` are one-way in the engine: a skip advances the
 * cursor, so `retry-stage` is refused from the state a skip leaves behind, and
 * a closed pipeline has no re-open action at all. The design still requires the
 * inverse to be in the receipt (§2 rule 9, §5: Skip → Retry stage, Archive →
 * Restore), and a button that always answers 409 is not an inverse.
 *
 * So the receipt IS the window: the tap commits the phone to the act and hands
 * the PATCH to the receipt's own four seconds. The inverse cancels it; the
 * window closing sends it, exactly as the desktop would have. Nothing else on
 * the phone defers — only these two, and only because the engine keeps no way
 * back once it has them.
 */
export type DeferredPipelineAction = "skip-stage" | "close";

export interface PendingPipelineAct {
  pipelineId: string;
  action: DeferredPipelineAction;
}

export interface PendingPipelineActs {
  getState(): PendingPipelineAct | null;
  subscribe(listener: () => void): () => void;
  /** Hold `act` for the receipt's window. A second act sends the first. */
  begin(act: PendingPipelineAct): void;
  /** The inverse was taken: nothing is sent. */
  cancel(): void;
  /** The window closed: send it now. */
  flush(): void;
}

const REAL_TIMERS: ReceiptTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The PATCH a settled act issues — the desktop's own call, no phone variant. */
async function sendPipelineAct(act: PendingPipelineAct): Promise<void> {
  const fail = await patchPipeline(act.pipelineId, act.action);
  if (fail) showReceipt(fail);
}

export function createPendingPipelineActs(
  timers: ReceiptTimers = REAL_TIMERS,
  send: (act: PendingPipelineAct) => void = (act) => void sendPipelineAct(act),
  windowMs: number = RECEIPT_MS,
): PendingPipelineActs {
  let current: PendingPipelineAct | null = null;
  let handle: unknown = null;
  const listeners = new Set<() => void>();
  const set = (next: PendingPipelineAct | null): void => {
    current = next;
    for (const listener of listeners) listener();
  };
  const take = (): PendingPipelineAct | null => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    const taken = current;
    if (taken) set(null);
    return taken;
  };
  return {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(act) {
      const superseded = take();
      if (superseded) send(superseded);
      set(act);
      handle = timers.set(() => {
        handle = null;
        const settled = current;
        if (settled) {
          set(null);
          send(settled);
        }
      }, windowMs);
    },
    cancel() {
      take();
    },
    flush() {
      const settled = take();
      if (settled) send(settled);
    },
  };
}

/** The tab's one held act. */
export const pendingPipelineActs: PendingPipelineActs = createPendingPipelineActs();

export function usePendingPipelineAct(store: PendingPipelineActs = pendingPipelineActs): PendingPipelineAct | null {
  return useSyncExternalStore(store.subscribe, store.getState, () => null);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The screen                                                                  *
 * ────────────────────────────────────────────────────────────────────────── */

/** The bar's meta line and the row badge share one state word (README §5). */
export const PIPELINE_STATE_WORD = {
  draft: "mobile2.pipelines.badgeDraft",
  provisioning: "mobile2.pipelines.badgeProvisioning",
  running: "mobile2.pipelines.badgeRunning",
  needs_decision: "mobile2.pipelines.badgeDecision",
  paused: "mobile2.pipelines.badgePaused",
  completed: "mobile2.pipelines.badgeCompleted",
  closed: "mobile2.pipelines.badgeClosed",
} as const satisfies Record<Pipeline["state"], string>;

const STATE_TONE: Record<Pipeline["state"], { phrase: string; dot: string }> = {
  draft: { phrase: "font-semibold text-warning", dot: "bg-warning" },
  provisioning: { phrase: "font-semibold text-accent", dot: "bg-accent" },
  running: { phrase: "font-semibold text-accent", dot: "bg-accent" },
  needs_decision: { phrase: "font-semibold text-warning", dot: "bg-warning" },
  paused: { phrase: "font-semibold text-warning", dot: "bg-warning" },
  completed: { phrase: "", dot: "bg-success" },
  closed: { phrase: "", dot: "bg-strong" },
};

/** The action a state offers, in the order the two buttons sit (README §4.7).
    The last entry is the primary; a state with nothing to decide has one. */
export interface MobilePipelineActionSpec {
  key: "skip" | "retry" | "pause" | "resume" | "archive";
  action: PipelineAction;
  primary: boolean;
}

/** Which actions the phone offers for `state` — the same set, and the same
    engine actions, the desktop's strip offers for it. */
export function mobilePipelineActions(state: Pipeline["state"]): MobilePipelineActionSpec[] {
  switch (state) {
    case "needs_decision":
      return [
        { key: "skip", action: "skip-stage", primary: false },
        { key: "retry", action: "retry-stage", primary: true },
      ];
    case "running":
    case "provisioning":
      return [{ key: "pause", action: "pause", primary: false }];
    case "paused":
      return [{ key: "resume", action: "resume", primary: true }];
    case "completed":
    case "closed":
      return [{ key: "archive", action: "close", primary: false }];
    /* A draft never reaches the phone: the board and the pipelines list both
       drop it, because a draft is edited where it is written. */
    case "draft":
      return [];
  }
}

/** What the receipt says once an act has gone through. */
const ACTION_RECEIPT = {
  skip: "mobile2.pipeline.skipped",
  retry: "mobile2.pipeline.retried",
  pause: "mobile2.pipeline.pausedReceipt",
  resume: "mobile2.pipeline.resumedReceipt",
  archive: "mobile2.pipeline.archived",
} as const;

const ACTION_ICON = {
  skip: SkipForward,
  retry: RefreshCw,
  pause: Pause,
  resume: Play,
  archive: Archive,
} as const;

const STAGE_MARK = "grid h-6 w-6 shrink-0 place-items-center rounded-full text-caption font-bold tabular-nums";

function StageMark({ state, index }: { state: string; index: number }) {
  if (state === "passed") return <span className={`${STAGE_MARK} bg-success-soft text-success`}><Check className="h-3.5 w-3.5" aria-hidden /></span>;
  if (state === "failed" || state === "needs_decision") return <span className={`${STAGE_MARK} bg-danger-soft text-danger`}><X className="h-3.5 w-3.5" aria-hidden /></span>;
  if (state === "running" || state === "reviewing" || state === "committing" || state === "spawning") {
    return <span className={`${STAGE_MARK} bg-accent-soft text-accent`}><Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /></span>;
  }
  return <span className={`${STAGE_MARK} bg-sunken text-muted`}>{index + 1}</span>;
}

/**
 * A stage row's title: the product's own stage identity, minus the position
 * that the row's own mark already gives (`stagePaneTitle`, #658). The role
 * alone is not an identity — a five-stage chain has three Builder stages, and
 * three rows reading «Builder» name nothing; the pipeline's own id for the
 * stage is what tells `fix` from `merge`.
 */
export function stageRowTitle(t: TFunction, stage: PipelineStage): string {
  const role = stageChipLabel(t, stage);
  return role === stage.id ? role : t("mobile2.pipeline.stageTitle", { role, stage: stage.id });
}

/** The stage's meta line: what kind of stage it is, where its round stands and
    what it returned — every word from the product's own dictionary. */
export function stageMetaLine(t: TFunction, pipeline: Pipeline, stage: PipelineStage): string {
  const attempt = latestAttempt(pipeline, stage.id);
  const findings = attempt?.verdict?.findings?.length ?? 0;
  return [
    stage.kind === "review-loop"
      ? attempt ? t("mobile2.pipeline.reviewRound", { round: attempt.n }) : t("mobile2.pipeline.review")
      : t("mobile2.pipeline.run"),
    t(`pipelineChipState.${stageChipState(pipeline, stage)}`),
    findings ? t("pipelineVerdict.findings", { count: findings }) : null,
  ].filter(Boolean).join(" · ");
}

export interface MobilePipelineScreenProps {
  pipeline: Pipeline;
  files: readonly FileEntry[];
  flows?: readonly Flow[];
  tasks?: readonly BoardTask[];
  /** Epoch seconds; the dashboard's ticking clock keeps the age honest. */
  now: number;
  host?: MobileShellHost | null;
  renderSheet?: SheetRenderer;
  /** Opening a stage's conversation is the board's own open gesture, so the
      card is stamped seen and ‹ returns here (README §3.3). */
  onOpenConversation: (file: FileEntry) => void;
  onOpenTask?: (task: BoardTask) => void;
  /** Test seam: the held-act store. Production reads the tab's singleton. */
  acts?: PendingPipelineActs;
}

export function MobilePipelineScreen({
  pipeline,
  files,
  flows = [],
  tasks = [],
  now,
  host,
  renderSheet,
  onOpenConversation,
  onOpenTask,
  acts = pendingPipelineActs,
}: MobilePipelineScreenProps) {
  const { t } = useLocale();
  const nav = useMobileNavStore();
  const pending = usePendingPipelineAct(acts);
  const held = pending?.pipelineId === pipeline.id;
  const { k, n } = pipelineStagePosition(pipeline);
  const created = Date.parse(pipeline.createdAt);
  const tone = STATE_TONE[pipeline.state];
  const cursorStage = pipeline.cursor ? pipeline.stages.find((stage) => stage.id === pipeline.cursor!.stageId) ?? null : null;
  const cursorAttempt = cursorStage ? latestAttempt(pipeline, cursorStage.id) : null;
  const findings = cursorAttempt?.verdict?.status === "fail" ? cursorAttempt.verdict.findings ?? [] : [];
  const linked = pipelineLinkedTasks(pipeline, tasks, [...flows], files);

  /* Retry, pause and resume act at once, exactly as the desktop's buttons do;
     skip and archive hand their PATCH to the receipt that carries their
     inverse (see `createPendingPipelineActs`). */
  const run = (spec: MobilePipelineActionSpec): void => {
    if (spec.action === "skip-stage" || spec.action === "close") {
      acts.begin({ pipelineId: pipeline.id, action: spec.action });
      showReceipt(
        t(ACTION_RECEIPT[spec.key]),
        { kind: spec.key === "skip" ? "retryStage" : "restore", run: () => acts.cancel() },
      );
      /* An archived lane has no screen left to stand on. */
      if (spec.action === "close") nav.back();
      return;
    }
    void patchPipeline(pipeline.id, spec.action).then((fail) => {
      showReceipt(fail ?? t(ACTION_RECEIPT[spec.key]));
    });
  };

  const title = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span data-mobile2-title-text className="min-w-0 truncate text-title font-semibold leading-tight text-primary">{pipeline.task}</span>
      <span data-mobile2-meta className="flex min-w-0 items-center gap-[5px] overflow-hidden text-label tabular-nums leading-tight text-muted">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${pipeline.state === "running" ? "motion-safe:animate-pulse" : ""}`} />
        <span data-mobile2-phrase className={`shrink-0 ${tone.phrase}`}>{t(PIPELINE_STATE_WORD[pipeline.state])}</span>
        <span aria-hidden className="shrink-0 opacity-60">·</span>
        <span className="shrink-0">{t("pipelineStrip.stageOf", { k, n })}</span>
        {Number.isFinite(created) ? (
          <>
            <span aria-hidden className="shrink-0 opacity-60">·</span>
            <span className="min-w-0 truncate">{t("mobile2.pipeline.started", { age: humanizeDuration(Math.max(0, now - created / 1_000)) })}</span>
          </>
        ) : null}
      </span>
    </span>
  );

  return (
    <MobileShell
      screen="pipeline"
      screenId={pipeline.id}
      back
      title={title}
      host={host}
      renderSheet={renderSheet}
    >
      <div data-mobile2-pipeline-body className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pb-3">
        {findings.length && cursorStage ? (
          <div className="mx-3 mt-2.5 rounded-[12px] bg-danger-soft px-3 py-2">
            <VerdictFindings
              testId="mobile-pipeline-findings"
              findings={findings}
              numbered
              mobile
              /* The heading in the product's own words: the stage as the board
                 names it, the round it is on, and the count the verdict
                 carries — never a hand-written «Review · round 3». */
              heading={cursorStage.kind === "review-loop" && cursorAttempt
                ? t("mobile2.pipeline.findingsHeading", {
                  stage: stageRowTitle(t, cursorStage),
                  round: cursorAttempt.n,
                  findings: t("pipelineVerdict.findings", { count: findings.length }),
                })
                : t("mobile2.pipeline.findingsHeadingRunless", {
                  stage: stageRowTitle(t, cursorStage),
                  findings: t("pipelineVerdict.findings", { count: findings.length }),
                })}
            />
          </div>
        ) : null}

        <ActionRow pipeline={pipeline} held={held} onRun={run} />

        <Section label={t("mobile2.pipeline.stages")} count={pipeline.stages.length} id="stages" />
        <div data-mobile2-stages className="mx-3 flex flex-col divide-y divide-border overflow-hidden rounded-[12px] bg-card shadow-1">
          {pipeline.stages.map((stage, index) => (
            <StageRow
              key={stage.id}
              pipeline={pipeline}
              stage={stage}
              index={index}
              current={pipeline.cursor?.stageId === stage.id}
              files={files}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </div>

        {linked.length ? (
          <>
            <Section label={t("mobile2.pipeline.linkedTasks")} count={linked.length} id="tasks" />
            <div className="flex flex-col gap-1.5 px-3">
              {linked.map((task) => {
                const label = task.text.split("\n", 1)[0]?.trim() || task.id;
                const Tag = onOpenTask ? "button" : "div";
                return (
                  <Tag
                    key={task.id}
                    {...(onOpenTask ? { type: "button" as const, onClick: () => onOpenTask(task), "aria-label": t("mobile2.pipeline.openTask", { label }) } : {})}
                    data-mobile2-linked-task={task.id}
                    className="flex min-h-11 w-full items-center gap-2.5 rounded-[12px] bg-quiet py-2 pl-3 pr-2.5 text-left ring-1 ring-inset ring-border active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-strong" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-body font-semibold leading-[1.25] text-secondary">{label}</span>
                      <span className="truncate text-label text-muted">{t(`tasks.status.${task.status}`)}</span>
                    </span>
                    {onOpenTask ? <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden /> : null}
                  </Tag>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </MobileShell>
  );
}

/** The section header, the board's own (`.sh`): a label and its count. */
function Section({ label, count, id }: { label: string; count?: number; id?: string }) {
  return (
    <div data-mobile2-section={id} className="flex min-h-[34px] items-center gap-1.5 px-3 pt-1.5 text-label font-semibold text-secondary">
      {label}
      {count === undefined ? null : <span className="text-caption font-semibold tabular-nums text-muted">{count}</span>}
    </div>
  );
}

/** The actions for the current state, as 44 px buttons that act on the tap. */
function ActionRow({ pipeline, held, onRun }: {
  pipeline: Pipeline;
  held: boolean;
  onRun: (spec: MobilePipelineActionSpec) => void;
}) {
  const { t } = useLocale();
  const specs = mobilePipelineActions(pipeline.state);
  if (!specs.length) return null;
  return (
    <div data-mobile2-pipeline-actions className="flex items-center gap-2 px-3 pt-1.5">
      {specs.map((spec) => {
        const Icon = ACTION_ICON[spec.key];
        return (
          <button
            key={spec.key}
            type="button"
            data-mobile2-pipeline-action={spec.key}
            data-mobile2-pipeline-patch={spec.action}
            disabled={held}
            className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[8px] px-3 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${
              spec.primary ? "bg-accent text-white active:opacity-90" : "bg-card text-secondary shadow-1 active:bg-sunken"
            }`}
            onClick={() => onRun(spec)}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {t(`mobile2.pipeline.${spec.key}`)}
          </button>
        );
      })}
    </div>
  );
}

/** One stage. Every stage that ran has a conversation, and the row opens it. */
function StageRow({ pipeline, stage, index, current, files, onOpenConversation }: {
  pipeline: Pipeline;
  stage: PipelineStage;
  index: number;
  current: boolean;
  files: readonly FileEntry[];
  onOpenConversation: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const state = stageChipState(pipeline, stage);
  const attempt = latestAttempt(pipeline, stage.id);
  /* The stage's own transcript, through the ONE resolution every stage surface
     uses: a migrated attempt opens its live generation, and an attempt whose
     transcript has left the scan opens nothing rather than a stale one. */
  const file = resolveStageNavFile(attemptNavTarget(attempt), files);
  const Tag = file ? "button" : "div";
  return (
    <Tag
      {...(file ? { type: "button" as const, onClick: () => onOpenConversation(file), "aria-label": t("mobile2.pipeline.openStage", { stage: stageRowTitle(t, stage) }) } : {})}
      data-mobile2-stage={stage.id}
      data-mobile2-go={file ? "chat" : undefined}
      data-mobile2-stage-state={state}
      data-mobile2-stage-current={current ? "true" : undefined}
      className={`flex min-h-[52px] w-full items-center gap-2.5 py-2 pl-3 pr-2.5 text-left ${current ? "shadow-[inset_3px_0_0_var(--color-accent)]" : ""} ${file ? "active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40" : ""}`}
    >
      <StageMark state={state} index={index} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-semibold leading-[1.25] text-primary">{stageRowTitle(t, stage)}</span>
        <span className="truncate text-label tabular-nums text-muted">{stageMetaLine(t, pipeline, stage)}</span>
      </span>
      {file ? <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden /> : null}
    </Tag>
  );
}
