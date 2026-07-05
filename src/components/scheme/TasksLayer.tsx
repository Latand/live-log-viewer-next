"use client";

import { memo } from "react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { TASK_TONES, taskTitle } from "@/components/tasks/taskModel";

import type { Camera } from "./Minimap";
import { NewTaskCard, TaskCard, type TaskCardHandlers } from "./TaskCard";
import { TASK_W, taskCardHeight } from "./taskGeometry";

/** Static tinted mini-card for the phone's full-screen map: a tap resolves
    through the camera's geometry pick, so the card itself stays inert. */
function LiteTaskCard({ task }: { task: BoardTask }) {
  const { t } = useLocale();
  const tone = TASK_TONES[task.status];
  return (
    <div
      data-scheme-task={task.id}
      className={`absolute overflow-hidden rounded-[8px] border border-line border-t-4 shadow-card ${
        task.status === "done" ? "opacity-60 saturate-50" : ""
      }`}
      style={{
        transform: `translate(${task.pos.x}px, ${task.pos.y}px)`,
        width: TASK_W,
        height: taskCardHeight(task),
        borderTopColor: tone.color,
        backgroundColor: tone.soft,
      }}
    >
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
  interactive,
  lite,
  camRef,
  handlers,
  pending,
  onCreate,
  onCreateCancel,
}: {
  tasks: BoardTask[];
  files: FileEntry[];
  interactive: boolean;
  /** Map mode: static tinted mini-cards, taps resolve by geometry. */
  lite: boolean;
  camRef: React.RefObject<Camera>;
  handlers: TaskCardHandlers;
  /** World point where the «задача» tool dropped a not-yet-saved card. */
  pending: { x: number; y: number } | null;
  onCreate: (text: string) => void;
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
      {pending && !lite ? <NewTaskCard pos={pending} onCommit={onCreate} onCancel={onCreateCancel} /> : null}
    </div>
  );
});
