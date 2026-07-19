"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { PIPELINE_ATTENTION_STATES, PIPELINE_BUSY_STATES, pipelineStagePosition, pipelineStateLabel } from "@/components/pipelines/pipelineModel";
import { PipelineStrip } from "@/components/pipelines/PipelineStrip";

export interface MobilePipelineDockProps {
  pipeline: Pipeline;
  flows?: Flow[];
  files?: readonly FileEntry[];
  renderablePaths?: ReadonlySet<string>;
  renderableFlows?: ReadonlySet<string>;
  linkedTasks?: BoardTask[];
  /** With a conversation focused, docks mount collapsed to one 44px disclosure
      row so the transcript stays the dominant surface (issue #156). The
      empty-state branch — where the dock IS the surface — mounts expanded. */
  defaultExpanded?: boolean;
  onOpenPath?: (path: string) => void;
  onOpenFlow?: (flowId: string) => void;
  onOpenTask?: (task: BoardTask) => void;
}

/**
 * The phone uses the shared compact pipeline rail with 44px tap targets. This
 * preserves configuration, evidence history, transcript navigation, task links,
 * and pipeline actions on every mobile surface.
 */
export function MobilePipelineDock({
  pipeline,
  flows = [],
  files = [],
  renderablePaths,
  renderableFlows,
  linkedTasks = [],
  defaultExpanded = true,
  onOpenPath,
  onOpenFlow,
  onOpenTask,
}: MobilePipelineDockProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const draft = pipeline.state === "draft";
  const attention = PIPELINE_ATTENTION_STATES.has(pipeline.state);
  const busyState = PIPELINE_BUSY_STATES.has(pipeline.state);
  /* The SAME single "stage k/n" derivation as the strip header and the live
     region (#353), so the collapsed row and the expanded rail can never
     disagree about position — including the resting stage a cursorless chain
     rests on (follow-ups 33351b51/878ebd8c). */
  const { k: position, n: total } = pipelineStagePosition(pipeline);
  const statusBadge = busyState
    ? "bg-accent-soft text-accent"
    : attention || draft
      ? "bg-warning-soft text-warning"
      : pipeline.state === "completed"
        ? "bg-success-soft text-success"
        : "bg-sunken text-muted";
  return (
    <div className="px-2 py-1.5 [&_button]:!h-11 [&_button]:!min-h-11" data-testid="mobile-pipeline-dock" data-pipeline-draft={draft || undefined}>
      <button
        type="button"
        data-testid="mobile-pipeline-dock-summary"
        aria-expanded={expanded}
        aria-label={t(expanded ? "pipelineMobile.collapseDock" : "pipelineMobile.expandDock", { task: pipeline.task })}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex min-h-11 w-full items-center gap-2 rounded-control px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            busyState ? "animate-pulse bg-accent" : attention || draft ? "bg-warning" : pipeline.state === "completed" ? "bg-success" : "bg-strong"
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{pipeline.task}</span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-semibold ${statusBadge}`}>
          {pipelineStateLabel(t, pipeline.state)}
        </span>
        {!draft && total ? (
          <span className="shrink-0 text-label font-semibold tabular-nums text-muted">
            {t("pipelineStrip.stageOf", { k: position, n: total })}
          </span>
        ) : null}
        {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
      </button>
      {expanded ? (
        <PipelineStrip
          pipeline={pipeline}
          flows={flows}
          files={files}
          renderablePaths={renderablePaths}
          renderableFlows={renderableFlows}
          mobile
          linkedTasks={linkedTasks}
          onOpenPath={onOpenPath}
          onOpenFlow={onOpenFlow}
          onOpenTask={onOpenTask}
        />
      ) : null}
    </div>
  );
}

export interface PipelineSummaryCounts {
  total: number;
  /** Running/queued/paused pipelines — ongoing work. */
  active: number;
  /** Pipelines whose move it is (needs-decision, failed, draft). */
  attention: number;
  completed: number;
}

/** Fold a docked-pipeline list into the counts the collapsed summary row and the
    sheet grouping both read, so they can never disagree. */
export function summarizePipelines(pipelines: readonly Pipeline[]): PipelineSummaryCounts {
  let active = 0;
  let attention = 0;
  let completed = 0;
  for (const pipeline of pipelines) {
    if (pipeline.state === "completed") completed += 1;
    else if (pipeline.state === "draft" || PIPELINE_ATTENTION_STATES.has(pipeline.state)) attention += 1;
    else active += 1;
  }
  return { total: pipelines.length, active, attention, completed };
}
