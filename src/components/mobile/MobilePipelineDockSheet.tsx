"use client";

import { ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { MobilePipelineDock, summarizePipelines } from "./MobilePipelineDock";

interface DockRenderProps {
  flows: Flow[];
  files: readonly FileEntry[];
  renderablePaths: ReadonlySet<string>;
  renderableFlows: ReadonlySet<string>;
  linkedTasksByPipeline: Map<string, BoardTask[]>;
  onOpenPath: (path: string) => void;
  onOpenFlow: (flowId: string) => void;
  onOpenTask: (task: BoardTask) => void;
}

/** One 44px row that stands in for the whole docked-pipeline stack when a
    conversation owns the viewport (issue #419): a count summary with state
    dots, opening the bottom sheet on tap so the chat stays dominant. */
export function MobilePipelineSummaryRow({ pipelines, onOpen }: { pipelines: Pipeline[]; onOpen: () => void }) {
  const { t } = useLocale();
  if (!pipelines.length) return null;
  const counts = summarizePipelines(pipelines);
  const parts: string[] = [];
  if (counts.active) parts.push(t("pipelineMobile.summaryActive", { n: counts.active }));
  if (counts.attention) parts.push(t("pipelineMobile.summaryAttention", { n: counts.attention }));
  if (counts.completed) parts.push(t("pipelineMobile.summaryCompleted", { n: counts.completed }));
  return (
    <div className="shrink-0 border-t border-border bg-card">
      <button
        type="button"
        data-testid="mobile-pipeline-summary"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-label={t("pipelineMobile.summaryOpen", { n: counts.total })}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          {counts.active ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
          {counts.attention ? <span className="h-2 w-2 rounded-full bg-warning" /> : null}
          {counts.completed ? <span className="h-2 w-2 rounded-full bg-success" /> : null}
          {!counts.active && !counts.attention && !counts.completed ? <span className="h-2 w-2 rounded-full bg-strong" /> : null}
        </span>
        <ListTree className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">
          {t("pipelineMobile.summaryCount", { n: counts.total })}
        </span>
        {parts.length ? <span className="shrink-0 truncate text-label font-semibold text-muted">{parts.join(" · ")}</span> : null}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </button>
    </div>
  );
}

/** The compact focus-strip pipelines trigger (issue #419 reopened): with a
    conversation focused, the docked pipelines reserve ZERO height below the
    transcript — this icon + count rides the top strip beside map/tasks and opens
    the same bottom sheet. The full count summary lives in its aria-label so a
    screen reader still hears "N pipelines · K active · …". */
export function MobilePipelineSummaryButton({ pipelines, onOpen }: { pipelines: Pipeline[]; onOpen: () => void }) {
  const { t } = useLocale();
  if (!pipelines.length) return null;
  const counts = summarizePipelines(pipelines);
  const parts: string[] = [];
  if (counts.active) parts.push(t("pipelineMobile.summaryActive", { n: counts.active }));
  if (counts.attention) parts.push(t("pipelineMobile.summaryAttention", { n: counts.attention }));
  if (counts.completed) parts.push(t("pipelineMobile.summaryCompleted", { n: counts.completed }));
  const label = [t("pipelineMobile.summaryCount", { n: counts.total }), ...parts].join(" · ");
  const badge = counts.attention || counts.active || counts.total;
  const badgeTone = counts.attention ? "bg-warning/10 text-warning" : counts.active ? "bg-accent/10 text-accent" : "bg-sunken text-muted";
  return (
    <button
      type="button"
      data-testid="mobile-pipeline-summary"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={label}
      className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-[8px] text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <ListTree className="h-4 w-4 shrink-0" aria-hidden />
      <span className={`rounded-full px-1 text-[10px] font-bold ${badgeTone}`}>{badge}</span>
    </button>
  );
}

/** Bottom sheet listing every docked pipeline as a compact rail (issue #419):
    ongoing pipelines first, completed ones folded behind one reversible
    disclosure so a finished run never crowds the active chain. */
export function MobilePipelineDockSheet({
  pipelines,
  render,
  onClose,
}: {
  pipelines: Pipeline[];
  render: DockRenderProps;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [showCompleted, setShowCompleted] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const ongoing = pipelines.filter((pipeline) => pipeline.state !== "completed");
  const completed = pipelines.filter((pipeline) => pipeline.state === "completed");

  /* Complete modal semantics (PR #431): focus moves into the sheet on open,
     Tab cycles inside it in both directions, Escape closes it, and focus
     returns to the opener (the summary row) on close. Body scroll locks like
     the runtime sheet so the page behind never pans under the modal. Mount-only
     — the parent re-renders on every poll, and re-running this would yank focus
     back to the sheet root mid-interaction. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  /* The key listener re-binds per `onClose` identity; attaching/detaching a
     window listener has no focus side effects, so poll re-renders stay quiet. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusables = [...sheet.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.hasAttribute("disabled"));
      if (!focusables.length) {
        event.preventDefault();
        sheet.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && sheet.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first || active === sheet) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dock = (pipeline: Pipeline) => (
    <MobilePipelineDock
      key={pipeline.id}
      pipeline={pipeline}
      flows={render.flows}
      files={render.files}
      renderablePaths={render.renderablePaths}
      renderableFlows={render.renderableFlows}
      linkedTasks={render.linkedTasksByPipeline.get(pipeline.id) ?? []}
      defaultExpanded={false}
      onOpenPath={render.onOpenPath}
      onOpenFlow={render.onOpenFlow}
      onOpenTask={render.onOpenTask}
    />
  );

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("pipelineMobile.sheetTitle")}
        tabIndex={-1}
        data-testid="mobile-pipeline-sheet"
        className="flex max-h-[80vh] w-full max-w-[520px] flex-col rounded-t-[16px] bg-card pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2 focus-visible:outline-none"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div className="mx-auto mb-0 h-1 w-10 rounded-full bg-border" aria-hidden />
        </div>
        <div className="flex shrink-0 items-center justify-between px-3 py-2">
          <span className="text-ui font-bold text-primary">{t("pipelineMobile.sheetTitle")}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("pipelineMobile.closeSheet")}
            className="flex h-11 w-11 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {ongoing.map(dock)}
          {completed.length ? (
            <div data-testid="mobile-pipeline-completed-group">
              <button
                type="button"
                data-testid="mobile-pipeline-completed-toggle"
                aria-expanded={showCompleted}
                onClick={() => setShowCompleted((prev) => !prev)}
                className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-label font-semibold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              >
                {showCompleted ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
                <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden />
                {t("pipelineMobile.completedGroup", { n: completed.length })}
              </button>
              {showCompleted ? <div className="divide-y divide-border border-t border-border">{completed.map(dock)}</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
