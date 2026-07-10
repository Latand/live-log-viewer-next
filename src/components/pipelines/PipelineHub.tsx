"use client";

import type { Pipeline } from "@/lib/pipelines/types";

const TONES: Record<Pipeline["state"], string> = {
  provisioning: "#5a51e0",
  running: "#5a51e0",
  needs_decision: "#e0ae45",
  paused: "#e0ae45",
  completed: "#1a8a3e",
  closed: "#9a9aa4",
};

export function PipelineHub({ pipeline, x, y, moveTransition }: { pipeline: Pipeline; x: number; y: number; moveTransition: string }) {
  const stage = pipeline.cursor?.stageId ?? pipeline.stages.at(-1)?.id ?? pipeline.id;
  return (
    <div
      data-scheme-ui
      className="pointer-events-none absolute left-0 top-0 z-[5] inline-flex h-[30px] -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border-2 bg-panel px-2 text-[10.5px] font-bold shadow-card"
      style={{ transform: `translate(${x}px, ${y}px) translate(-50%, -50%)`, transition: moveTransition, borderColor: TONES[pipeline.state], color: TONES[pipeline.state] }}
      title={`${pipeline.task} · ${stage}`}
      aria-label={`${pipeline.task} · ${stage}`}
    >
      <span aria-hidden>⇢</span>
      <span className="max-w-[120px] truncate">{stage}</span>
    </div>
  );
}
