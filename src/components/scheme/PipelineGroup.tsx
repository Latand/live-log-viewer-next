"use client";

import { ChevronDown } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { pipelineStagePosition, pipelineStateLabel } from "@/components/pipelines/pipelineModel";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

import type { Camera } from "./Minimap";
import type { SchemeRect } from "./layout";
import type { PipelineGroupPlacement } from "./pipelineAnchor";

export interface PipelineGroupContextValue {
  id: string;
  worldRect: SchemeRect;
}

const PipelineGroupContext = createContext<PipelineGroupContextValue | null>(null);

export function usePipelineGroupContext(): PipelineGroupContextValue {
  const value = useContext(PipelineGroupContext);
  if (!value) throw new Error("usePipelineGroupContext must be used inside PipelineGroup");
  return value;
}

const TONE: Record<Pipeline["state"], string> = {
  draft: "var(--color-warning)",
  provisioning: "var(--color-accent)",
  running: "var(--color-accent)",
  needs_decision: "var(--color-warning)",
  paused: "var(--color-warning)",
  completed: "var(--color-success)",
  closed: "var(--color-muted)",
};

export const PipelineGroup = memo(function PipelineGroup({
  pipeline,
  rect,
  camRef,
  onPin,
  interactive,
  expanded,
  onExpandedChange,
  autoOpen = false,
  onAutoOpen,
  children,
}: {
  pipeline: Pipeline;
  rect: PipelineGroupPlacement;
  camRef: React.RefObject<Camera>;
  onPin: (pipeline: Pipeline, pos: { x: number; y: number }) => Promise<string | null>;
  interactive: boolean;
  expanded: boolean;
  onExpandedChange: (pipelineId: string, expanded: boolean) => void;
  autoOpen?: boolean;
  onAutoOpen?: () => void;
  children?: React.ReactNode | ((controls: { collapse: () => void }) => React.ReactNode);
}) {
  const { t } = useLocale();
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [localPos, setLocalPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const pos = drag ?? localPos ?? rect.header;
  const worldRect = useMemo(() => {
    const dx = pos.x - rect.header.x;
    const dy = pos.y - rect.header.y;
    return { x: rect.bounds.x + dx, y: rect.bounds.y + dy, w: rect.bounds.w, h: rect.bounds.h };
  }, [pos.x, pos.y, rect.header.x, rect.header.y, rect.bounds]);
  const context = useMemo(() => ({ id: pipeline.id, worldRect }), [pipeline.id, worldRect]);
  const position = pipelineStagePosition(pipeline);
  const draft = pipeline.state === "draft" || pipeline.stages.length === 0;
  const collapse = useCallback(() => onExpandedChange(pipeline.id, false), [onExpandedChange, pipeline.id]);

  useEffect(() => {
    if (!autoOpen) return;
    onExpandedChange(pipeline.id, true);
    onAutoOpen?.();
  }, [autoOpen, onAutoOpen, onExpandedChange, pipeline.id]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: pos.x, oy: pos.y, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) {
      dragRef.current = null;
      setDrag(null);
      return;
    }
    const start = dragRef.current;
    if (!start) return;
    const dx = event.clientX - start.sx;
    const dy = event.clientY - start.sy;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    start.moved = true;
    const z = camRef.current?.z ?? 1;
    setDrag({ x: start.ox + dx / z, y: start.oy + dy / z });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) {
      dragRef.current = null;
      setDrag(null);
      return;
    }
    const start = dragRef.current;
    dragRef.current = null;
    if (!start?.moved) return;
    const z = camRef.current?.z ?? 1;
    const dropped = {
      x: Math.round(start.ox + (event.clientX - start.sx) / z),
      y: Math.round(start.oy + (event.clientY - start.sy) / z),
    };
    setDrag(null);
    setLocalPos(dropped);
    void onPin(pipeline, dropped).then((error) => {
      if (error) setLocalPos(null);
    });
  };

  return (
    <PipelineGroupContext.Provider value={context}>
      <section
        data-scheme-ui={interactive ? "" : undefined}
        data-pipeline-group={pipeline.id}
        {...(draft ? { "data-pipeline-draft": "" } : {})}
        className={`absolute z-[5] overflow-visible ${interactive ? "" : "pointer-events-none select-none"}`}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, width: rect.header.w, height: rect.header.h }}
        aria-label={`${pipeline.task}: ${pipelineStateLabel(t, pipeline.state)}`}
      >
        <div
          data-pipeline-group-drag
          className={`flex h-[76px] touch-none items-center gap-3 rounded-[10px] border bg-card/96 px-4 shadow-2 ${draft ? "border-dashed border-warning/70" : "border-border"}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <span
            data-pipeline-group-status
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: TONE[pipeline.state] }}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary" title={pipeline.task}>
            {pipeline.task}
          </span>
          <span
            data-pipeline-group-counter
            className="shrink-0 rounded-[4px] bg-sunken px-1.5 py-1 text-[10.5px] font-semibold tabular-nums text-muted"
          >
            {t("pipelineStrip.stageOf", { k: position.k, n: position.n })}
          </span>
          <button
            type="button"
            data-scheme-ui
            aria-expanded={expanded}
            aria-label={t("pipelineGroup.toggle", { task: pipeline.task })}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => onExpandedChange(pipeline.id, !expanded)}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
          </button>
        </div>
        {expanded && rect.body ? (
          <div
            data-pipeline-group-body
            className={`absolute overflow-y-auto rounded-[10px] border bg-card/96 px-3 py-3 shadow-2 ${draft ? "border-dashed border-warning/70" : "border-border"}`}
            style={{
              left: rect.body.x - rect.header.x,
              top: rect.body.y - rect.header.y,
              width: rect.body.w,
              height: rect.body.h,
            }}
          >
            {typeof children === "function" ? children({ collapse }) : children}
          </div>
        ) : null}
      </section>
    </PipelineGroupContext.Provider>
  );
});
