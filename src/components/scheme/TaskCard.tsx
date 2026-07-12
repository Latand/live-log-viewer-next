"use client";

import { Link2, Loader2, Send, Trash2, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { useLinkDrag } from "@/components/AgentLink";
import { pushTaskToast } from "@/components/tasks/taskToast";
import { nextTaskStatus, TASK_TONES, taskTitle } from "@/components/tasks/taskModel";
import { activityDot, cleanTitle, engineBadge, engineBadgeFor } from "@/components/utils";

import type { Camera } from "./Minimap";
import { MOVE_EASE, MOVE_MS } from "./nodes";
import { TASK_BODY_MAX, TASK_W, taskRect, type PlacedTask, type SchemeRect } from "./taskGeometry";

/* Below this zoom the card text is unreadable: an edit click glides first. */
const EDIT_MIN_Z = 0.55;
const AUTOSAVE_MS = 900;

/* A blur that happens because the OS took the window itself (keyboard-layout
   switcher, alt-tab) must not end the edit: the layout hotkey is how text
   gets typed here, and the caret belongs back when the window returns. The
   commit runs only for in-page blurs; on a window blur the field re-grabs
   focus once the window is active again. */
function commitUnlessWindowBlur(el: HTMLTextAreaElement | null, commit: () => void): void {
  if (document.hasFocus()) {
    commit();
    return;
  }
  window.addEventListener("focus", () => el?.focus(), { once: true });
}

export interface TaskCardHandlers {
  patch: (id: string, patch: { text?: string; status?: BoardTask["status"]; pos?: { x: number; y: number } }) => Promise<string | null>;
  remove: (id: string) => void;
  /** Handoff into a running agent: drops the task text into that pane's
      composer (never auto-sent) and records a removable link. */
  handoff: (task: BoardTask, file: FileEntry) => Promise<string | null>;
  /** Route the task to a brand-new agent: seed a draft conversation, launch
      nothing. */
  draft: (task: BoardTask) => void;
  /** Detach one assignment — the undo for a wrong handoff. */
  unassign: (task: BoardTask, path: string) => void;
  center: (rect: SchemeRect) => void;
}

function AssignmentChip({
  task,
  assignment,
  file,
  onDetach,
}: {
  task: BoardTask;
  assignment: BoardTask["assignments"][number];
  file: FileEntry | null;
  onDetach: (task: BoardTask, path: string) => void;
}) {
  const { t } = useLocale();
  if (!assignment.path) {
    return (
      <span className="flex h-6 items-center gap-1.5 rounded-[6px] bg-white/55 px-1.5 text-[10.5px] font-semibold text-dim">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        {t("tasks.spawning")}
      </span>
    );
  }
  const dead = !file;
  const failed = assignment.state === "failed";
  const handoff = assignment.state === "handoff";
  const badge = file ? engineBadge(file) : null;
  const title = file ? cleanTitle(file.title, 40) : (assignment.path.split("/").pop() ?? assignment.path);
  const wrapTitle = failed
    ? t("tasks.chipFailedTitle", { error: assignment.error ?? "" })
    : dead
      ? t("tasks.deadChip")
      : handoff
        ? t("tasks.handoffChip")
        : file
          ? cleanTitle(file.title)
          : undefined;
  return (
    <span
      className={`flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 ${
        failed ? "bg-[#faeee9] text-[#a04a2e]" : dead ? "bg-white/45 text-dim opacity-70" : "bg-white/55"
      }`}
      title={wrapTitle}
    >
      {handoff ? <Link2 className="h-3 w-3 shrink-0 text-[#0d9488]" aria-hidden /> : null}
      {file ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} /> : null}
      {badge ? (
        <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
          {badge.label}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold">{title}</span>
      {failed ? <span aria-hidden>⚠</span> : null}
      <button
        type="button"
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-dim hover:bg-black/5 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={t("tasks.detachAria", { title })}
        title={t("tasks.detach")}
        onClick={() => onDetach(task, assignment.path!)}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}

function SourceChip({ task, file }: { task: BoardTask; file: FileEntry | null }) {
  const { t } = useLocale();
  const source = task.source;
  if (!source) return null;
  /* The originating conversation may sit outside the current list (other
     project or scope), so fall back to its filename and lean on the engine
     recorded in the source itself for the badge. */
  const title = file ? cleanTitle(file.title, 40) : (source.path.split("/").pop() ?? source.path);
  const badge = engineBadgeFor(source.engine);
  return (
    <span
      className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[6px] bg-white/55 px-1.5 text-[#0d6f5f]"
      title={`${t("tasks.sourceTitle")}: ${source.text}`}
    >
      <Link2 className="h-3 w-3 shrink-0" aria-hidden />
      <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
        {badge.label}
      </span>
      <span className="shrink-0 text-[10.5px] font-bold">{t("tasks.source")}</span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold">{title}</span>
    </span>
  );
}

/**
 * A task as a sticky card on the board: tinted by status with a colored top
 * strip, first line bold, body scrolling past the cap, assignment chips and
 * a hover action row. Owns its drag (world deltas via the camera ref, one
 * PATCH on drop) and its inline editing (blur/Esc saves, autosave debounce).
 */
export const TaskCard = memo(function TaskCard({
  task,
  files,
  camRef,
  handlers,
}: {
  task: PlacedTask;
  files: FileEntry[];
  camRef: React.RefObject<Camera>;
  handlers: TaskCardHandlers;
}) {
  const { t } = useLocale();
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  /* Dropped position held locally until the server echo arrives (updatedAt
     bumps on the PATCH), so the card never snaps back mid-poll. */
  const [localPos, setLocalPos] = useState<{ x: number; y: number; seen: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /* The last edit ended blank: nothing was saved (the server rejects empty
     text), so handoffs/drafts are blocked until the user restores the text. */
  const [blankEdit, setBlankEdit] = useState(false);
  const [armDelete, setArmDelete] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!armDelete) return;
    const timer = window.setTimeout(() => setArmDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armDelete]);

  /* Autosave while typing; blur/Esc commit instantly. The effect closes over
     the latest draft because it re-arms on every draft change. Handoffs never
     race these saves: taskApi tracks in-flight text PATCHes per task and
     handoffTask waits them out (aborting on failure). */
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      if (draft.trim() && draft !== task.text) void handlers.patch(task.id, { text: draft });
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [editing, draft, task.id, task.text, handlers]);

  const commitEdit = () => {
    setEditing(false);
    if (!draft.trim()) {
      /* A blank edit is never persisted; the card falls back to the stored
         text, and the toast plus the delivery block below keep the user from
         unknowingly sending the previous body. */
      if (draft !== task.text) {
        setBlankEdit(true);
        pushTaskToast("err", t("tasks.emptyTextBlocked"));
      }
      return;
    }
    setBlankEdit(false);
    if (draft !== task.text) void handlers.patch(task.id, { text: draft });
  };

  /* Blur fires before an action button's click, so commitEdit has already
     classified the edit by the time this guard runs. */
  const deliveryBlocked = (): boolean => {
    if (editing ? !draft.trim() : blankEdit) {
      pushTaskToast("err", t("tasks.emptyTextBlocked"));
      return true;
    }
    return false;
  };

  const beginEdit = () => {
    if (editing) return;
    if ((camRef.current?.z ?? 1) < EDIT_MIN_Z) handlers.center(taskRect(task));
    setDraft(task.text);
    setEditing(true);
    requestAnimationFrame(() => {
      const el = editRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const pos = drag ?? (localPos && localPos.seen === task.updatedAt ? localPos : task.pos);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || editing) return;
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select, [data-task-pop]")) return;
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: pos.x, oy: pos.y, moved: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer already gone */
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
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
    const start = dragRef.current;
    dragRef.current = null;
    if (!start) return;
    if (start.moved) {
      const z = camRef.current?.z ?? 1;
      const dropped = {
        x: Math.round(start.ox + (event.clientX - start.sx) / z),
        y: Math.round(start.oy + (event.clientY - start.sy) / z),
      };
      setDrag(null);
      setLocalPos({ ...dropped, seen: task.updatedAt });
      /* A failed save snaps the card back to its persisted coordinates —
         the board must never show a position the server does not hold. */
      void handlers.patch(task.id, { pos: dropped }).then((error) => {
        if (error) setLocalPos(null);
      });
      return;
    }
    /* A stationary press anywhere on the card is the inline-edit gesture —
       buttons, action chips and popovers already opted out at press time, so
       a click that landed on padding or an assignment chip edits too. */
    beginEdit();
  };

  const tone = TASK_TONES[task.status];
  const title = taskTitle(task.text) || t("tasks.untitled");
  const rest = task.text.includes("\n") ? task.text.slice(task.text.indexOf("\n") + 1) : "";
  const byPath = new Map(files.map((file) => [file.path, file]));
  const lifted = editing || drag !== null;

  /* The handoff gesture, task-flavored: pull the arrow off the «send» pill
     onto a pane to route the task into that agent's composer (nothing is
     auto-sent); a drop on empty canvas means «no aimed agent» — it seeds a
     fresh draft conversation with the task text. */
  const link = useLinkDrag({
    onDrop: (hit) => {
      if (deliveryBlocked()) return null;
      void handlers.handoff(task, hit.file);
      return t("tasks.linkHanded", { title: cleanTitle(hit.file.title, 48) });
    },
    onMiss: () => {
      if (deliveryBlocked()) return;
      handlers.draft(task);
    },
  });

  return (
    <div
      data-scheme-task={task.id}
      className={`group absolute pb-9 ${lifted ? "z-30" : "z-[4]"}`}
      style={{
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        width: TASK_W,
        transition: drag ? undefined : `transform ${MOVE_MS}ms ${MOVE_EASE}`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className={`flex flex-col overflow-hidden rounded-[8px] border border-line shadow-card ${
          task.status === "done" ? "opacity-60 saturate-50" : ""
        } ${editing ? "ring-2 ring-accent/50" : ""}`}
        style={{ backgroundColor: tone.soft }}
      >
        <div aria-hidden className="h-1 w-full shrink-0" style={{ backgroundColor: tone.color }} />
        {editing ? (
          <textarea
            ref={editRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commitUnlessWindowBlur(editRef.current, commitEdit)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                commitEdit();
              }
            }}
            aria-label={t("tasks.editAria")}
            rows={Math.min(16, Math.max(3, draft.split("\n").length + 1))}
            className="w-full resize-none bg-transparent px-3 py-2 text-[12.5px] leading-[17px] text-[#26262c] placeholder:text-dim focus-visible:outline-none"
            maxLength={6000}
          />
        ) : (
          <div data-task-body className="cursor-text overflow-y-auto px-3 py-2" style={{ maxHeight: TASK_BODY_MAX }}>
            <div className="whitespace-pre-wrap break-words text-[12.5px] font-bold leading-[17px] text-[#26262c]">{title}</div>
            {rest.trim() ? (
              <div className="whitespace-pre-wrap break-words text-[12.5px] leading-[17px] text-[#3a3a42]">{rest}</div>
            ) : null}
          </div>
        )}
        {task.source || task.assignments.length ? (
          <div className="flex flex-col gap-1 px-2 pb-2">
            <SourceChip task={task} file={task.source ? (byPath.get(task.source.path) ?? null) : null} />
            {task.assignments.map((assignment, index) => (
              <AssignmentChip
                key={(assignment.path ?? "spawning") + "::" + index}
                task={task}
                assignment={assignment}
                file={assignment.path ? (byPath.get(assignment.path) ?? null) : null}
                onDetach={(target, path) => handlers.unassign(target, path)}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Action row floats under the card on hover/edit so the card's own
          height keeps matching the pure geometry estimate. */}
      <div
        className={`absolute left-0 top-full flex -translate-y-8 items-center gap-1 ${
          lifted ? "" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
        } transition-opacity`}
      >
        {/* One pill, two handoffs, neither auto-sends: drag the arrow onto a
            pane to drop the task into that agent's composer, or click (drop on
            empty canvas) to seed a fresh draft conversation. */}
        <button
          type="button"
          className="inline-flex h-7 touch-none items-center gap-1 rounded-full border border-line bg-panel px-2 text-[10.5px] font-semibold text-dim shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("tasks.sendTitle")}
          onPointerDown={link.onPillPointerDown}
          onClick={() => {
            if (link.consumeClick()) return;
            if (deliveryBlocked()) return;
            handlers.draft(task);
          }}
        >
          <Send className="h-3 w-3" aria-hidden /> {t("tasks.send")}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-full border px-2 text-[10.5px] font-bold shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          style={{ backgroundColor: "#fff", color: tone.color, borderColor: tone.color }}
          title={t("tasks.statusTitle", { label: t(`tasks.status.${task.status}`) })}
          onClick={() => void handlers.patch(task.id, { status: nextTaskStatus(task.status) })}
        >
          {t("tasks.statusPrefix")}: {t(`tasks.status.${task.status}`)}
        </button>
        <button
          type="button"
          className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[10.5px] font-semibold shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            armDelete ? "border-err bg-err text-white" : "border-line bg-panel text-dim hover:border-err/40 hover:text-err"
          }`}
          aria-label={t("tasks.deleteAria", { title })}
          title={armDelete ? t("tasks.deleteConfirm") : t("tasks.delete")}
          onClick={() => {
            if (!armDelete) {
              setArmDelete(true);
              return;
            }
            setArmDelete(false);
            handlers.remove(task.id);
          }}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
          {armDelete ? t("tasks.deleteConfirm") : null}
        </button>
      </div>

      {link.overlay}
    </div>
  );
});
