"use client";

import { memo } from "react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { TASK_TONES, taskTitle } from "@/components/tasks/taskModel";

import type { Camera } from "./Minimap";
import { TaskCard, type TaskCardHandlers } from "./TaskCard";
import { TaskStickyComposer } from "./TaskStickyComposer";
import { TASK_W, taskCardHeight, type PlacedTask } from "./taskGeometry";

/** Static tinted mini-card for the phone's full-screen map: a tap resolves
    through the camera's geometry pick, so the card itself stays inert. */
function LiteTaskCard({ task }: { task: PlacedTask }) {
  const { t } = useLocale();
  const tone = TASK_TONES[task.status];
  return (
    <div
      data-scheme-task={task.id}
      className={`absolute overflow-hidden rounded-[8px] border border-line shadow-card ${
        task.status === "done" ? "opacity-60 saturate-50" : ""
      }`}
      style={{
        transform: `translate(${task.pos.x}px, ${task.pos.y}px)`,
        width: TASK_W,
        height: taskCardHeight(task),
        backgroundColor: tone.soft,
      }}
    >
      <div aria-hidden className="h-1 w-full" style={{ backgroundColor: tone.color }} />
      <div className="px-3 py-2 text-[12.5px] font-bold leading-[17px] text-[#26262c]">
        <span className="line-clamp-4 whitespace-pre-wrap break-words">{taskTitle(task.text) || t("tasks.untitled")}</span>
      </div>
    </div>
  );
}

/**
 * Task cards over the panes (z 2–20 band), inside the transformed world div.
 * Memoized like NodesLayer: camera frames never reach it, handlers arrive
 * ref-stable, and in hand/map mode the whole layer goes click-through.
 */
export const TasksLayer = memo(function TasksLayer({
  tasks,
  files,
  project,
  interactive,
  lite,
  camRef,
  handlers,
  pending,
  onStickyCreated,
  onCreateCancel,
}: {
  tasks: PlacedTask[];
  files: FileEntry[];
  project: string;
  interactive: boolean;
  /** Map mode: static tinted mini-cards, taps resolve by geometry. */
  lite: boolean;
  camRef: React.RefObject<Camera>;
  handlers: TaskCardHandlers;
  /** World point where the «task» tool / double-click / `+ Task` dropped a
      not-yet-saved sticky composer. */
  pending: { x: number; y: number } | null;
  onStickyCreated: (task: BoardTask) => void;
  onCreateCancel: () => void;
}) {
  return (
    <div className={interactive ? undefined : "pointer-events-none select-none"}>
      {tasks.map((task) =>
        lite ? (
          <LiteTaskCard key={task.id} task={task} />
        ) : (
          <TaskCard key={task.id} task={task} files={files} camRef={camRef} handlers={handlers} />
        ),
      )}
      {pending && !lite ? (
        <TaskStickyComposer project={project} pos={pending} onCreated={onStickyCreated} onCancel={onCreateCancel} />
      ) : null}
    </div>
  );
});
