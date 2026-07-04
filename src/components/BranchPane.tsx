"use client";

import { CornerDownRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChevronRight, X } from "@/components/icons";
import { registerPane } from "@/lib/chime";
import type { FileEntry } from "@/lib/types";

import { registerLinkTarget } from "./AgentLink";
import { DeleteFileButton } from "./DeleteFileButton";
import { FlipRow } from "./FlipRow";
import { canHandoff, HandoffHandle } from "./HandoffHandle";
import { LogFeed } from "./LogFeed";
import { paneState, type PaneState } from "./paneState";
import { CtxChip, GoalChip, PlanChip } from "./PlanChip";
import { ProcessStatusControls } from "./TaskHeader";
import { TmuxComposer } from "./TmuxComposer";
import { activityDot, cleanTitle, effortTint, effortTitle, engineBadge, engineEdge } from "./utils";

const noop = () => undefined;

/* Card treatment per lifecycle state; `glow` also feeds the orbiting border. */
const PANE_TONES: Record<PaneState, { section: string; header: string; glow?: string }> = {
  live: { section: "border-ok/60 shadow-[0_0_0_3px_rgba(47,158,68,0.16)]", header: "bg-[#eef8f0]" },
  waiting: { section: "border-[#e0ae45]/60 shadow-[0_0_0_3px_rgba(224,174,69,0.2)]", header: "bg-[#fff7e6]", glow: "#e0ae45" },
  returned: { section: "border-accent/50 shadow-[0_0_0_3px_rgba(90,81,224,0.15)]", header: "bg-[#f1f0fc]", glow: "#7a6ff0" },
  stalled: { section: "border-err/50 shadow-[0_0_0_3px_rgba(198,40,40,0.13)]", header: "bg-[#fdf0f0]", glow: "#d76a6a" },
  done: { section: "border-line", header: "bg-[#f4f4f6] text-dim opacity-80 saturate-50" },
};

const DOT_TITLES: Record<PaneState, string> = {
  live: "працює",
  waiting: "закінчив хід — чекає відповіді",
  returned: "повернувся з результатом",
  stalled: "перервано або чекає дозволу",
  done: "завершено — можна прибрати",
};

interface Props {
  file: FileEntry;
  files: FileEntry[];
  /** Background tasks attached to this column as collapsed rows. */
  tasks: FileEntry[];
  onSelect: (file: FileEntry) => void;
  /** Column of the root conversation of a branch group. */
  isRoot: boolean;
  /** Removes the column from the managed list. */
  onClose?: () => void;
  /** Native DnD attributes on the header: drag a column by its head to reorder siblings. */
  dragHandle?: React.HTMLAttributes<HTMLElement>;
  /** Hides the tmux composer: headless runs and finished review rounds take no input. */
  noComposer?: boolean;
  /** Slim context bar pinned under the header (e.g. «Раунд 2 · ✖ REQUEST_CHANGES»). */
  banner?: React.ReactNode;
}

export function BranchPane({ file, files, tasks, onSelect, isRoot, onClose, dragHandle, noComposer, banner }: Props) {
  const paneRef = useRef<HTMLElement | null>(null);
  const badge = engineBadge(file);
  const state = paneState(file);
  const tone = PANE_TONES[state];
  /* The chime of this conversation pans to wherever this pane sits on screen. */
  useEffect(() => {
    if (paneRef.current) return registerPane(file.path, paneRef.current);
  }, [file.path]);
  /* Link-arrow drop target; re-registers each poll so the pid stays current. */
  useEffect(() => {
    if (paneRef.current) return registerLinkTarget(file, paneRef.current);
  }, [file]);
  return (
    <section
      ref={paneRef}
      /* Text inside the column must stay selectable: the canvas drag-pan skips
         presses that start here (wheel pan still covers scrolling). */
      data-pan-ignore
      data-link-path={file.path}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border bg-panel shadow-card ${
        isRoot ? "border-t-4" : "border-t-2"
      } ${tone.section} ${tone.glow ? "pane-attention" : ""}`}
      style={{
        ...(state === "done" ? { borderTopColor: "#c9c9d1" } : engineEdge(file)),
        ...(tone.glow ? ({ "--pane-glow": tone.glow } as React.CSSProperties) : null),
      }}
    >
      <header
        className={`flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2.5 ${tone.header} ${
          dragHandle ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        {...dragHandle}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`} title={DOT_TITLES[state]} />
        <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold" style={badge.style}>
          {badge.label}
        </span>
        {file.model ? (
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] font-semibold"
            style={{ backgroundColor: effortTint(file).soft, color: effortTint(file).color }}
            title={effortTitle(file)}
          >
            {file.model}
          </span>
        ) : null}
        {file.ctx ? <CtxChip ctx={file.ctx} /> : null}
        {file.worktree ? (
          <span className="shrink-0 rounded-full border border-line/80 px-1.5 py-0.5 font-mono text-[9.5px] text-dim" title={`Ворк-дерево ${file.worktree}`}>
            wt {file.worktree}
          </span>
        ) : null}
        {file.plan ? <PlanChip plan={file.plan} /> : null}
        {file.goal ? <GoalChip goal={file.goal} /> : null}
        {isRoot ? null : (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-dim"
            title={file.handoff ? "агент, породжений хендоффом цієї розмови" : "гілка цієї розмови"}
          >
            <CornerDownRight className="h-3 w-3" aria-hidden /> {file.handoff ? "хендофф" : file.kind}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={cleanTitle(file.title)}>
          {cleanTitle(file.title, 90)}
        </span>
        <ProcessStatusControls file={file} compact />
        <DeleteFileButton file={file} onDeleted={onClose} />
        {onClose ? (
          <button
            className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={`Прибрати колонку ${cleanTitle(file.title, 60)}`}
            onClick={onClose}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
      </header>
      {banner ?? null}
      {tasks.length ? (
        <FlipRow className="shrink-0 border-b border-line bg-[#fbfbfd]" enter="fade">
          {tasks.map((task) => (
            <div key={task.path} data-flip-key={task.path}>
              <TaskStrip file={task} files={files} onSelect={onSelect} />
            </div>
          ))}
        </FlipRow>
      ) : null}
      <LogFeed
        file={file}
        files={files}
        onSelect={onSelect}
        showSvc={false}
        lineFilter=""
        onStatus={noop}
        paused={false}
        follow
        setFollow={noop}
        compact
      />
      {noComposer ? null : <TmuxComposer file={file} />}
      {canHandoff(file) ? <HandoffHandle file={file} paneRef={paneRef} /> : null}
    </section>
  );
}

/** Collapsed background-task row: glyph, title, PID chip, kill; click expands an inline mini feed. */
export function TaskStrip({ file, files, onSelect }: { file: FileEntry; files: FileEntry[]; onSelect: (file: FileEntry) => void }) {
  const [open, setOpen] = useState(false);
  const title = cleanTitle(file.cmdDesc || file.title, 80);
  return (
    <div className="border-t border-line first:border-t-0">
      <div className="flex h-7 items-center gap-1.5 pl-2 pr-2.5">
        <button
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[6px] text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-expanded={open}
          aria-label={`${open ? "Згорнути" : "Розгорнути"} фонову задачу ${title}`}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold" title={cleanTitle(file.title)}>
            {title}
          </span>
        </button>
        <ProcessStatusControls file={file} compact />
      </div>
      {open ? (
        <div className="flex h-[220px] flex-col border-t border-dashed border-line bg-bg/60">
          <LogFeed
            file={file}
            files={files}
            onSelect={onSelect}
            showSvc={false}
            lineFilter=""
            onStatus={noop}
            paused={false}
            follow
            setFollow={noop}
            compact
          />
        </div>
      ) : null}
    </div>
  );
}
