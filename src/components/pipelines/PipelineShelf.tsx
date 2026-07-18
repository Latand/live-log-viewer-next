"use client";

import { Settings2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { PipelineEditor } from "./PipelineEditor";
import { PipelineStrip } from "./PipelineStrip";

export function PipelineShelf({
  pipelines,
  flows,
  files,
  renderablePaths,
  renderableFlows,
  materializedPaths,
  materializedFlows,
  linkedTasksByPipeline,
  autoOpenPipelineId,
  onAutoOpen,
  onOpenPath,
  onOpenFlow,
  onOpenTask,
}: {
  pipelines: Pipeline[];
  flows: Flow[];
  files: readonly FileEntry[];
  renderablePaths: ReadonlySet<string>;
  renderableFlows: ReadonlySet<string>;
  materializedPaths: ReadonlySet<string>;
  materializedFlows: ReadonlySet<string>;
  linkedTasksByPipeline: ReadonlyMap<string, BoardTask[]>;
  autoOpenPipelineId?: string | null;
  onAutoOpen?: () => void;
  onOpenPath?: (path: string) => void;
  onOpenFlow?: (flowId: string) => void;
  onOpenTask?: (task: BoardTask) => void;
}) {
  const { t } = useLocale();
  const [openId, setOpenId] = useState<string | null>(null);
  const openPipeline = pipelines.find((pipeline) => pipeline.id === openId) ?? null;

  useEffect(() => {
    if (!autoOpenPipelineId || !pipelines.some((pipeline) => pipeline.id === autoOpenPipelineId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a newly created draft opens once it reaches its owning shelf
    setOpenId(autoOpenPipelineId);
    onAutoOpen?.();
  }, [autoOpenPipelineId, pipelines, onAutoOpen]);

  useEffect(() => {
    if (!openId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpenId(null);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [openId]);

  if (!pipelines.length) return null;

  return (
    <section
      data-scheme-ui
      data-pipeline-shelf
      aria-label={t("pipelineShelf.aria")}
      className="pointer-events-auto absolute bottom-[76px] left-3 z-30 flex max-h-[52%] w-[min(940px,calc(100%-236px))] min-w-0 flex-col gap-1.5 rounded-[14px] border border-border bg-canvas/94 p-2 shadow-3 backdrop-blur-md"
    >
      <div className="flex items-center gap-2 px-1">
        <span className="text-label font-bold uppercase tracking-[0.12em] text-muted">{t("pipelineShelf.title")}</span>
        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-caption font-bold text-accent">{pipelines.length}</span>
      </div>
      <div className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto pb-0.5">
        {pipelines.map((pipeline) => (
          <div key={pipeline.id} data-pipeline-shelf-item={pipeline.id} className="relative flex min-w-[min(760px,calc(100vw-286px))] max-w-[760px] items-center gap-1">
            <PipelineStrip
              pipeline={pipeline}
              flows={flows}
              files={files}
              renderablePaths={renderablePaths}
              renderableFlows={renderableFlows}
              materializedPaths={materializedPaths}
              materializedFlows={materializedFlows}
              linkedTasks={linkedTasksByPipeline.get(pipeline.id) ?? []}
              onOpenPath={onOpenPath}
              onOpenFlow={onOpenFlow}
              onOpenTask={onOpenTask}
            />
            <button
              type="button"
              aria-label={t("pipelineShelf.edit", { task: pipeline.task })}
              aria-expanded={openId === pipeline.id}
              onClick={() => setOpenId((current) => current === pipeline.id ? null : pipeline.id)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-border bg-card text-secondary shadow-1 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Settings2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      {openPipeline ? (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-40">
          <PipelineEditor pipeline={openPipeline} onClose={() => setOpenId(null)} />
        </div>
      ) : null}
    </section>
  );
}
