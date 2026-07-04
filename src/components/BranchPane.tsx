"use client";

import { CornerDownRight } from "lucide-react";
import { useState } from "react";

import { ChevronRight, X } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

import { FlipRow } from "./FlipRow";
import { LogFeed } from "./LogFeed";
import { ProcessStatusControls } from "./TaskHeader";
import { TmuxComposer } from "./TmuxComposer";
import { activityDot, cleanTitle, engineBadge, engineEdge, modelTint } from "./utils";

const noop = () => undefined;

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
}

export function BranchPane({ file, files, tasks, onSelect, isRoot, onClose, dragHandle }: Props) {
  const badge = engineBadge(file);
  const live = file.activity === "live";
  return (
    <section
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border bg-panel shadow-card ${
        isRoot ? "border-t-4" : "border-t-2"
      } ${live ? "border-ok/60 shadow-[0_0_0_3px_rgba(47,158,68,0.16)]" : "border-line"}`}
      style={engineEdge(file)}
    >
      <header
        className={`flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2.5 ${live ? "bg-[#eef8f0]" : ""} ${
          dragHandle ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        {...dragHandle}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`}
          title={file.activity === "live" ? "працює" : file.activity === "recent" ? "закінчив" : file.activity === "stalled" ? "перервано" : "тихо"}
        />
        <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold" style={badge.style}>
          {badge.label}
        </span>
        {file.model ? (
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] font-semibold"
            style={{ backgroundColor: modelTint(file).soft, color: modelTint(file).color }}
          >
            {file.model}
          </span>
        ) : null}
        {isRoot ? null : (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-dim" title="гілка цієї розмови">
            <CornerDownRight className="h-3 w-3" aria-hidden /> {file.kind}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={cleanTitle(file.title)}>
          {cleanTitle(file.title, 90)}
        </span>
        <ProcessStatusControls file={file} compact />
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
      <TmuxComposer file={file} />
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
