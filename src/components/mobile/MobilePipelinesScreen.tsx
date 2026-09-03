"use client";

import { useState } from "react";

import { ChevronDown, ChevronRight } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

import { MobilePipelineRow } from "../pipelines/PipelineStrip";
import { MobileBarTitle, MobileShell, type MobileShellHost, type SheetRenderer } from "./MobileShell";
import { pendingPipelineActs, usePendingPipelineAct, type PendingPipelineActs } from "./MobilePipelineScreen";

/*
 * The pipelines list on the phone (issue #1439, lane 7; docs/design/mobile-v2/
 * README.md §4.7): Needs you, Active, and a folded «n completed» toggle. Each
 * row is the same description of a pipeline the board's summary and the
 * desktop's strip give — `MobilePipelineRow`, the strip's mobile row mode — so
 * the two surfaces cannot say different things about one lane.
 *
 * A draft never appears: it is edited where it is written, and the board's own
 * pipelines summary drops it too. A closed lane is gone by definition, and a
 * lane whose archive is still inside its receipt's window is treated as gone
 * already — the receipt says «Archived», so the row must not still be here.
 */

export interface MobilePipelinesModel {
  needs: Pipeline[];
  active: Pipeline[];
  completed: Pipeline[];
}

const ACTIVE_STATES: ReadonlySet<Pipeline["state"]> = new Set(["running", "provisioning", "paused"]);

/** The three sections, from the pipelines the board already scoped to this
    project. Pure, so the list and anything that has to agree with it read one
    answer. `archiving` is the id whose close is still held by its receipt. */
export function mobilePipelinesModel(pipelines: readonly Pipeline[], archiving?: string | null): MobilePipelinesModel {
  const model: MobilePipelinesModel = { needs: [], active: [], completed: [] };
  for (const pipeline of pipelines) {
    if (pipeline.id === archiving) continue;
    if (pipeline.state === "draft" || pipeline.state === "closed" || pipeline.hiddenAt) continue;
    if (pipeline.state === "needs_decision") model.needs.push(pipeline);
    else if (ACTIVE_STATES.has(pipeline.state)) model.active.push(pipeline);
    else if (pipeline.state === "completed") model.completed.push(pipeline);
  }
  return model;
}

export interface MobilePipelinesScreenProps {
  pipelines: readonly Pipeline[];
  /** Epoch seconds; the dashboard's ticking clock keeps the ages honest. */
  now: number;
  host?: MobileShellHost | null;
  renderSheet?: SheetRenderer;
  onOpenPipeline: (pipeline: Pipeline) => void;
  /** Test seam: the held-act store. Production reads the tab's singleton. */
  acts?: PendingPipelineActs;
}

export function MobilePipelinesScreen({ pipelines, now, host, renderSheet, onOpenPipeline, acts = pendingPipelineActs }: MobilePipelinesScreenProps) {
  const { t } = useLocale();
  const [showCompleted, setShowCompleted] = useState(false);
  const pending = usePendingPipelineAct(acts);
  /* An archive still inside its receipt's window has not been sent, but the
     operator has been told it happened: the row goes now, not in four seconds. */
  const archiving = pending?.action === "close" ? pending.pipelineId : null;
  const model = mobilePipelinesModel(pipelines, archiving);
  const row = (pipeline: Pipeline, quiet?: boolean) => (
    <MobilePipelineRow key={pipeline.id} pipeline={pipeline} now={now} quiet={quiet} onOpen={onOpenPipeline} />
  );
  return (
    <MobileShell
      screen="pipelines"
      back
      title={<MobileBarTitle>{t("mobile2.pipelines.title")}</MobileBarTitle>}
      host={host}
      renderSheet={renderSheet}
    >
      <div data-mobile2-pipelines className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-3">
        {model.needs.length ? (
          <>
            <Section label={t("mobile2.pipelines.needsYou")} count={model.needs.length} id="needs" />
            <div className="flex flex-col gap-1.5 px-3">{model.needs.map((pipeline) => row(pipeline))}</div>
          </>
        ) : null}

        <Section label={t("mobile2.pipelines.active")} count={model.active.length} id="active" />
        <div className="flex flex-col gap-1.5 px-3">
          {model.active.length
            ? model.active.map((pipeline) => row(pipeline))
            : <div className="p-4 text-center text-ui text-muted">{t("mobile2.pipelines.none")}</div>}
        </div>

        {model.completed.length ? (
          <>
            <div data-mobile2-section="completed" className="flex min-h-[34px] items-center px-3 pt-1.5">
              <button
                type="button"
                data-mobile2-completed-toggle
                aria-expanded={showCompleted}
                className="flex min-h-11 items-center gap-1.5 rounded-[8px] pr-2 text-ui font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => setShowCompleted((open) => !open)}
              >
                {showCompleted
                  ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                  : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
                {t("mobile2.pipelines.completed", { count: model.completed.length })}
              </button>
            </div>
            {showCompleted ? (
              <div className="flex flex-col gap-1.5 px-3">{model.completed.map((pipeline) => row(pipeline, true))}</div>
            ) : null}
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
