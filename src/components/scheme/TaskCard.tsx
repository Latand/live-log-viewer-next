"use client";

import { Loader2, Send, Trash2, Zap } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { TargetChecklist } from "@/components/tasks/TargetChecklist";
import { pushTaskToast } from "@/components/tasks/taskToast";
import { nextTaskStatus, TASK_TONES, taskTitle } from "@/components/tasks/taskModel";
import { activityDot, cleanTitle, engineBadge } from "@/components/utils";

import type { Camera } from "./Minimap";
import { MOVE_EASE, MOVE_MS } from "./nodes";
import { TASK_BODY_MAX, TASK_W, taskRect, type SchemeRect } from "./taskGeometry";

/* Below this zoom the card text is unreadable: an edit click glides first. */
const EDIT_MIN_Z = 0.55;
const AUTOSAVE_MS = 900;

export interface TaskCardHandlers {
  patch: (id: string, patch: { text?: string; status?: BoardTask["status"]; pos?: { x: number; y: number } }) => Promise<string | null>;
  remove: (id: string) => void;
  send: (task: BoardTask, paths: string[]) => void;
  spawn: (task: BoardTask, engine: "claude" | "codex", cwd: string) => Promise<string | null>;
  center: (rect: SchemeRect) => void;
  /** Currently selected conversation paths — «надіслати» targets them directly. */
  selectionPaths: () => string[];
}

function AssignmentChip({
  task,
  assignment,
  file,
  onRetry,
}: {
  task: BoardTask;
  assignment: BoardTask["assignments"][number];
  file: FileEntry | null;
  onRetry: (task: BoardTask, path: string) => void;
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
  const badge = file ? engineBadge(file) : null;
  const title = file ? cleanTitle(file.title, 40) : (assignment.path.split("/").pop() ?? assignment.path);
  const chip = (
    <>
      {file ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} /> : null}
      {badge ? (
        <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
          {badge.label}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold">{title}</span>
      {failed ? <span aria-hidden>⚠</span> : null}
    </>
  );
  if (failed || dead) {
    return (
      <button
        type="button"
        className={`flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          failed ? "bg-[#faeee9] text-[#a04a2e] hover:bg-[#f6ded2]" : "bg-white/45 text-dim opacity-70 hover:opacity-100"
        }`}
        title={
          failed
            ? t("tasks.chipFailedTitle", { error: assignment.error ?? "" })
            : `${t("tasks.deadChip")} · ${t("tasks.retry")}`
        }
        onClick={() => onRetry(task, assignment.path!)}
      >
        {chip}
      </button>
    );
  }
  return (
    <span
      className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[6px] bg-white/55 px-1.5"
      title={file ? cleanTitle(file.title) : undefined}
    >
      {chip}
    </span>
  );
}

/** Checkbox picker over the project's conversations + «⤷ всім дітям». */
function SendPicker({
  task,
  files,
  project,
  onSend,
  onClose,
}: {
  task: BoardTask;
  files: FileEntry[];
  project: string;
  onSend: (task: BoardTask, paths: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());

  return (
    <div
      data-task-pop
      className="absolute left-0 top-full z-30 mt-1 flex w-[280px] flex-col rounded-[10px] border border-line bg-panel p-1.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
    >
      <div className="px-1 pb-1 text-[10.5px] font-bold text-dim">{t("tasks.pickerTitle")}</div>
      <TargetChecklist files={files} project={project} checked={checked} onChange={setChecked} />
      <div className="mt-1 flex items-center justify-end gap-1 border-t border-line pt-1.5">
        <button
          type="button"
          className="rounded-[8px] px-2 py-1 text-[11px] font-semibold text-dim hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onClose}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={!checked.size}
          className="rounded-[8px] border border-accent bg-accent px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
          onClick={() => {
            onSend(task, [...checked]);
            onClose();
          }}
        >
          {t("tasks.pickerSend", { count: checked.size })}
        </button>
      </div>
    </div>
  );
}

/** Engine+cwd mini-popover; prefilled from the spawn GET suggest. */
function SpawnPopover({
  task,
  onSpawn,
  onClose,
}: {
  task: BoardTask;
  onSpawn: (task: BoardTask, engine: "claude" | "codex", cwd: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [engine, setEngine] = useState<"claude" | "codex">("claude");
  const [cwd, setCwd] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* First assignee's cwd ranks top in the suggestions. */
  useEffect(() => {
    let cancelled = false;
    const src = task.assignments.find((assignment) => assignment.path)?.path;
    fetch("/api/spawn?project=" + encodeURIComponent(task.project) + (src ? "&src=" + encodeURIComponent(src) : ""))
      .then((res) => res.json() as Promise<{ dirs?: string[]; cwd?: string | null }>)
      .then((json) => {
        if (cancelled) return;
        if (Array.isArray(json.dirs)) setDirs(json.dirs);
        setCwd((prev) => prev || (typeof json.cwd === "string" ? json.cwd : "") || json.dirs?.[0] || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.project, task.assignments]);

  const go = async () => {
    if (busy || !cwd.trim()) return;
    setBusy(true);
    setError(null);
    const failure = await onSpawn(task, engine, cwd.trim());
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };

  const listId = "task-spawn-dirs-" + task.id;
  return (
    <div
      data-task-pop
      className="absolute left-0 top-full z-30 mt-1 flex w-[280px] flex-col gap-1.5 rounded-[10px] border border-line bg-panel p-2 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
    >
      <div className="flex items-center gap-1" role="radiogroup" aria-label={t("draft.engineAria")}>
        {(["claude", "codex"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={engine === key}
            disabled={busy}
            onClick={() => setEngine(key)}
            className={`rounded-full border px-2 py-0.5 text-[10.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
              engine === key ? "border-accent bg-accent/10 text-accent" : "border-transparent text-dim hover:text-ink"
            }`}
          >
            {key === "claude" ? "Claude" : "Codex"}
          </button>
        ))}
      </div>
      <input
        value={cwd}
        disabled={busy}
        onChange={(event) => setCwd(event.target.value)}
        list={listId}
        placeholder="/home/…/Projects/…"
        aria-label={t("draft.dirAria")}
        className="min-w-0 rounded-[6px] border border-line bg-panel px-2 py-1 font-mono text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
      />
      <datalist id={listId}>
        {dirs.map((dir) => (
          <option key={dir} value={dir} />
        ))}
      </datalist>
      {error ? <span className="text-[10.5px] font-semibold text-err">{error}</span> : null}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          className="rounded-[8px] px-2 py-1 text-[11px] font-semibold text-dim hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onClose}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={busy || !cwd.trim()}
          className="inline-flex items-center gap-1 rounded-[8px] border border-accent bg-accent px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
          onClick={() => void go()}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Zap className="h-3 w-3" aria-hidden />}
          {t("tasks.spawnGo")}
        </button>
      </div>
    </div>
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
  task: BoardTask;
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
     text), so deliveries are blocked until the user restores the text. */
  const [blankEdit, setBlankEdit] = useState(false);
  const [pop, setPop] = useState<"send" | "spawn" | null>(null);
  const [armDelete, setArmDelete] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!armDelete) return;
    const timer = window.setTimeout(() => setArmDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armDelete]);

  /* Autosave while typing; blur/Esc commit instantly. The effect closes over
     the latest draft because it re-arms on every draft change. Deliveries
     never race these saves: taskApi tracks in-flight text PATCHes per task
     and sendTask/spawnTaskAgent wait them out (aborting on failure). */
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
     classified the edit by the time these guards run. */
  const deliveryBlocked = (): boolean => {
    if (editing ? !draft.trim() : blankEdit) {
      pushTaskToast("err", t("tasks.emptyTextBlocked"));
      return true;
    }
    return false;
  };
  const guardedSend = (target: BoardTask, paths: string[]) => {
    if (deliveryBlocked()) return;
    handlers.send(target, paths);
  };
  const guardedSpawn = async (target: BoardTask, engine: "claude" | "codex", cwd: string): Promise<string | null> => {
    if (deliveryBlocked()) return t("tasks.emptyTextBlocked");
    return handlers.spawn(target, engine, cwd);
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
    /* A stationary press on the text is the inline-edit gesture. */
    if ((event.target as HTMLElement).closest("[data-task-body]")) beginEdit();
  };

  const tone = TASK_TONES[task.status];
  const title = taskTitle(task.text) || t("tasks.untitled");
  const rest = task.text.includes("\n") ? task.text.slice(task.text.indexOf("\n") + 1) : "";
  const byPath = new Map(files.map((file) => [file.path, file]));
  const lifted = editing || drag !== null || pop !== null;

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
        className={`flex flex-col overflow-hidden rounded-[8px] border border-line border-t-4 shadow-card ${
          task.status === "done" ? "opacity-60 saturate-50" : ""
        } ${editing ? "ring-2 ring-accent/50" : ""}`}
        style={{ borderTopColor: tone.color, backgroundColor: tone.soft }}
      >
        {editing ? (
          <textarea
            ref={editRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitEdit}
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
        {task.assignments.length ? (
          <div className="flex flex-col gap-1 px-2 pb-2">
            {task.assignments.map((assignment, index) => (
              <AssignmentChip
                key={(assignment.path ?? "spawning") + "::" + index}
                task={task}
                assignment={assignment}
                file={assignment.path ? (byPath.get(assignment.path) ?? null) : null}
                onRetry={(target, path) => guardedSend(target, [path])}
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
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-panel px-2 text-[10.5px] font-semibold text-dim shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("tasks.sendTitle")}
          onClick={() => {
            const selection = handlers.selectionPaths();
            if (selection.length) {
              guardedSend(task, selection);
              return;
            }
            setPop((prev) => (prev === "send" ? null : "send"));
          }}
        >
          <Send className="h-3 w-3" aria-hidden /> {t("tasks.send")}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-panel px-2 text-[10.5px] font-semibold text-dim shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("tasks.spawnTitle")}
          onClick={() => setPop((prev) => (prev === "spawn" ? null : "spawn"))}
        >
          <Zap className="h-3 w-3" aria-hidden /> {t("tasks.spawn")}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-full border px-2 text-[10.5px] font-bold shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          style={{ backgroundColor: "#fff", color: tone.color, borderColor: tone.color }}
          title={t("tasks.statusTitle", { label: t(`tasks.status.${task.status}`) })}
          onClick={() => void handlers.patch(task.id, { status: nextTaskStatus(task.status) })}
        >
          {t(`tasks.status.${task.status}`)}
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

      {pop === "send" ? (
        <SendPicker task={task} files={files} project={task.project} onSend={guardedSend} onClose={() => setPop(null)} />
      ) : null}
      {pop === "spawn" ? <SpawnPopover task={task} onSpawn={guardedSpawn} onClose={() => setPop(null)} /> : null}
    </div>
  );
});

/**
 * The not-yet-persisted card the «задача» tool drops: a focused textarea at
 * the clicked world point. Blur/Esc with text creates the task; empty text
 * discards the card.
 */
export function NewTaskCard({
  pos,
  onCommit,
  onCancel,
}: {
  pos: { x: number; y: number };
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const commit = () => {
    if (text.trim()) onCommit(text);
    else onCancel();
  };
  return (
    <div
      data-scheme-task="new"
      className="absolute z-30"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, width: TASK_W }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-[8px] border border-line border-t-4 shadow-card ring-2 ring-accent/50"
        style={{ borderTopColor: TASK_TONES.inbox.color, backgroundColor: TASK_TONES.inbox.soft }}
      >
        <textarea
          ref={ref}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              commit();
            }
          }}
          placeholder={t("tasks.newPlaceholder")}
          aria-label={t("tasks.editAria")}
          rows={4}
          className="w-full resize-none bg-transparent px-3 py-2 text-[12.5px] leading-[17px] text-[#26262c] placeholder:text-dim focus-visible:outline-none"
          maxLength={6000}
        />
      </div>
    </div>
  );
}
