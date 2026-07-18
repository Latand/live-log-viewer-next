"use client";

import { ChevronDown, ChevronUp, Crosshair, FoldVertical, Link2, Loader2, Send, Trash2, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { AssignmentRef, BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { useLinkDrag } from "@/components/AgentLink";
import { pushTaskToast } from "@/components/tasks/taskToast";
import { nextTaskStatus, TASK_TONES, taskTitle } from "@/components/tasks/taskModel";
import { activityDot, cleanTitle, engineBadge, engineBadgeFor } from "@/components/utils";

import type { Camera } from "./Minimap";
import { MOVE_EASE, MOVE_MS } from "./nodes";
import { assignmentAgentState, assignmentOpenable } from "./assignmentState";
import { TASK_W, taskCardExpandable, taskRect, type PlacedTask, type SchemeRect } from "./taskGeometry";

const TITLE_CLAMP_CLASS = "line-clamp-2";
const PREVIEW_CLAMP_CLASS = "line-clamp-3";
/* A clipped compact preview fades out over its last line instead of ending on a
   hard cut — the visual cue that the in-card Expand control reveals more. */
const PREVIEW_FADE_MASK = "linear-gradient(to bottom, #000 calc(100% - 18px), transparent)";

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
  /** Detach one assignment through its durable identity. */
  unassign: (task: BoardTask, ref: AssignmentRef) => void;
  center: (rect: SchemeRect) => void;
  /** Fold the card back into its compact status stack (drops its durable
      expand pin); the stack strip re-lists it immediately. */
  collapse?: (task: BoardTask) => void;
  /** Toggle compact and full-text presentation. */
  toggleExpand: (id: string) => void;
  /** Open the current assigned-agent generation. */
  openAgent: (file: FileEntry) => void;
}

function ChipAction({
  icon,
  ariaLabel,
  title,
  hoverClass,
  disabled,
  onClick,
  dataAttr,
}: {
  icon: React.ReactNode;
  ariaLabel: string;
  title: string;
  hoverClass: string;
  disabled?: boolean;
  onClick: () => void;
  /** Stable test/query hook, e.g. `data-task-open-agent`. */
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      {...(dataAttr ? { [dataAttr]: "" } : {})}
      className={`-my-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${hoverClass} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted`}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function AssignmentChip({
  task,
  assignment,
  file,
  onDetach,
  onOpen,
}: {
  task: BoardTask;
  assignment: BoardTask["assignments"][number];
  file: FileEntry | null;
  onDetach: (task: BoardTask, ref: AssignmentRef) => void;
  onOpen: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const state = assignmentAgentState(assignment, file);
  const detachRef: AssignmentRef = {
    path: assignment.path,
    conversationId: assignment.conversationId ?? null,
    panePid: assignment.panePid,
  };
  if (state === "spawning") {
    return (
      <span className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[7px] border border-border bg-card/80 px-2 text-[10.5px] font-semibold text-muted">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("tasks.spawning")}</span>
        <ChipAction
          icon={<X className="h-3 w-3" aria-hidden />}
          ariaLabel={t("tasks.detachAria", { title: t("tasks.spawning") })}
          title={t("tasks.detach")}
          hoverClass="hover:bg-black/5 hover:text-danger"
          onClick={() => onDetach(task, detachRef)}
        />
      </span>
    );
  }
  const failed = state === "failed";
  const openable = assignmentOpenable(state);
  const handoff = assignment.state === "handoff";
  const badge = file ? engineBadge(file) : null;
  const title = file
    ? cleanTitle(file.title, 40)
    : assignment.path
      ? (assignment.path.split("/").pop() ?? assignment.path)
      : t("tasks.failedChip");
  const stateTitle = failed
    ? assignment.error
      ? t("tasks.chipFailedTitle", { error: assignment.error })
      : t("tasks.failedChip")
    : state === "gone"
      ? t("tasks.deadChip")
      : state === "migrating"
        ? t("tasks.migratingChip")
        : state === "killed"
          ? t("tasks.killedChip")
          : state === "unhosted"
            ? t("tasks.unhostedChip")
            : handoff
              ? t("tasks.handoffChip")
              : file
                ? cleanTitle(file.title)
                : undefined;
  const wrapClass = failed
    ? "border-danger/25 bg-danger-soft text-danger"
    : state === "gone" || state === "killed"
      ? "border-border bg-sunken text-muted opacity-70"
      : state === "migrating" || state === "unhosted"
        ? "border-border bg-sunken text-muted"
        : "border-border bg-card/80";
  return (
    <span className={`flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[7px] border px-2 ${wrapClass}`} title={stateTitle}>
      {handoff ? <Link2 className="h-3 w-3 shrink-0 text-info" aria-hidden /> : null}
      {file ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} /> : null}
      {badge ? (
        <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
          {badge.label}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold">{title}</span>
      {failed ? <span aria-hidden>⚠</span> : null}
      <ChipAction
        icon={<Crosshair className="h-3 w-3" aria-hidden />}
        ariaLabel={t("tasks.openAgentAria", { title })}
        title={openable ? t("tasks.openAgent") : (stateTitle ?? t("tasks.openAgent"))}
        hoverClass="hover:bg-black/5 hover:text-accent"
        disabled={!openable}
        onClick={() => {
          if (file && openable) onOpen(file);
        }}
        dataAttr="data-task-open-agent"
      />
      <ChipAction
        icon={<X className="h-3 w-3" aria-hidden />}
        ariaLabel={t("tasks.detachAria", { title })}
        title={t("tasks.detach")}
        hoverClass="hover:bg-black/5 hover:text-danger"
        onClick={() => onDetach(task, detachRef)}
      />
    </span>
  );
}

function SourceChip({ task, file, onOpen }: { task: BoardTask; file: FileEntry | null; onOpen: (file: FileEntry) => void }) {
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
      className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[7px] border border-info/20 bg-info-soft px-2 text-info"
      title={`${t("tasks.sourceTitle")}: ${source.text}`}
    >
      <Link2 className="h-3 w-3 shrink-0" aria-hidden />
      <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
        {badge.label}
      </span>
      <span className="shrink-0 text-[10.5px] font-bold">{t("tasks.source")}</span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold">{title}</span>
      {/* The task-side mirror of the pane's relation strip (issue #292): a
          capture navigates back to its origin exactly like an assignment opens
          its agent. Disabled — with a truthful title — once the origin has left
          the current list. */}
      <ChipAction
        icon={<Crosshair className="h-3 w-3" aria-hidden />}
        ariaLabel={t("tasks.openSourceAria", { title })}
        title={file ? t("tasks.openSource") : t("tasks.sourceGone")}
        hoverClass="hover:bg-black/5 hover:text-accent"
        disabled={!file}
        onClick={() => {
          if (file) onOpen(file);
        }}
        dataAttr="data-task-open-source"
      />
    </span>
  );
}

/**
 * A task as a sticky card on the board: tinted by status with a colored top
 * strip, compact/full text disclosure, assignment chips and a hover action
 * row. Owns its drag (world deltas via the camera ref, one PATCH on drop) and
 * its inline editing (blur/Esc saves, autosave debounce).
 */
export const TaskCard = memo(function TaskCard({
  task,
  files,
  camRef,
  handlers,
  selected = false,
  expanded = false,
}: {
  task: PlacedTask;
  files: FileEntry[];
  camRef: React.RefObject<Camera>;
  handlers: TaskCardHandlers;
  selected?: boolean;
  expanded?: boolean;
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
    if ((camRef.current?.z ?? 1) < EDIT_MIN_Z) handlers.center(taskRect(task, expanded));
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
  const expandable = taskCardExpandable(task);
  /* Compact presentation is hiding text: fade the clamped preview out so the
     cut reads as «more below» and the Expand control announces where it is. */
  const clipped = !expanded && expandable;
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const byConversationId = useMemo(
    () => new Map(files.filter((file) => file.conversationId).map((file) => [file.conversationId!, file])),
    [files],
  );
  const resolveAgent = (assignment: BoardTask["assignments"][number]): FileEntry | null => {
    if (assignment.conversationId) {
      const current = byConversationId.get(assignment.conversationId);
      if (current) return current;
    }
    return assignment.path ? (byPath.get(assignment.path) ?? null) : null;
  };
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
        className={`flex flex-col overflow-hidden rounded-[10px] border border-border shadow-1 transition-shadow ${
          task.status === "done" ? "opacity-60 saturate-50" : ""
        } ${lifted ? "shadow-2" : "group-hover:shadow-2"} ${
          editing ? "ring-2 ring-accent/50" : selected ? "ring-2 ring-accent ring-offset-1 ring-offset-canvas" : ""
        }`}
        style={{ backgroundColor: tone.soft }}
      >
        <div aria-hidden className="h-1.5 w-full shrink-0" style={{ backgroundColor: tone.color }} />
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
            className="w-full resize-none bg-transparent px-3 py-2 text-[12.5px] leading-[17px] text-primary placeholder:text-muted focus-visible:outline-none"
            maxLength={6000}
          />
        ) : (
          <div
            data-task-body
            {...(clipped ? { "data-task-clipped": "" } : {})}
            className="cursor-text px-3 py-2"
            style={clipped ? { maskImage: PREVIEW_FADE_MASK, WebkitMaskImage: PREVIEW_FADE_MASK } : undefined}
          >
            <div
              className={`whitespace-pre-wrap break-words text-[12.5px] font-semibold leading-[17px] tracking-[-0.006em] text-primary ${
                expanded ? "" : TITLE_CLAMP_CLASS
              }`}
            >
              {title}
            </div>
            {rest.trim() ? (
              <div className={`whitespace-pre-wrap break-words text-[12.5px] leading-[17px] text-secondary ${expanded ? "" : PREVIEW_CLAMP_CLASS}`}>
                {rest}
              </div>
            ) : null}
          </div>
        )}
        {task.source || task.assignments.length ? (
          <div className="flex flex-col gap-1 px-2 pb-2">
            <SourceChip task={task} file={task.source ? (byPath.get(task.source.path) ?? null) : null} onOpen={handlers.openAgent} />
            {task.assignments.map((assignment, index) => (
              <AssignmentChip
                key={assignment.conversationId ?? assignment.path ?? (assignment.panePid != null ? `pane:${assignment.panePid}` : `index:${index}`)}
                task={task}
                assignment={assignment}
                file={resolveAgent(assignment)}
                onDetach={(target, ref) => handlers.unassign(target, ref)}
                onOpen={handlers.openAgent}
              />
            ))}
          </div>
        ) : null}
        {!editing && expandable ? (
          <div className="px-2 pb-2">
            <button
              type="button"
              data-task-disclosure
              aria-expanded={expanded}
              className="flex h-6 w-full items-center justify-center gap-1 rounded-[7px] border border-border bg-card/60 text-[10.5px] font-semibold text-muted transition-colors hover:bg-card hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => handlers.toggleExpand(task.id)}
            >
              {expanded ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
              {t(expanded ? "tasks.collapse" : "tasks.expand")}
            </button>
          </div>
        ) : null}
      </div>

      {/* Action row floats under the card on hover/edit so the card's own
          height keeps matching the pure geometry estimate. An expanded card
          keeps it pinned visible: full-text reading must never strand the
          collapse/status/delete actions behind a hover the reader hasn't made. */}
      <div
        data-task-actions
        className={`absolute left-0 top-full flex -translate-y-8 items-center gap-1.5 ${
          lifted || expanded ? "" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
        } transition-opacity`}
      >
        {/* One pill, two handoffs, neither auto-sends: drag the arrow onto a
            pane to drop the task into that agent's composer, or click (drop on
            empty canvas) to seed a fresh draft conversation. */}
        <button
          type="button"
          className="inline-flex h-7 touch-none items-center gap-1 rounded-full border border-border bg-card px-2 text-[10.5px] font-semibold text-muted shadow-1 hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
          className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-bold shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          style={{ backgroundColor: tone.soft, color: tone.color, borderColor: tone.color }}
          title={t("tasks.statusTitle", { label: t(`tasks.status.${task.status}`) })}
          onClick={() => void handlers.patch(task.id, { status: nextTaskStatus(task.status) })}
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tone.color }} />
          {t(`tasks.status.${task.status}`)}
        </button>
        {handlers.collapse ? (
          <button
            type="button"
            className="inline-flex h-7 items-center rounded-full border border-border bg-card px-2 text-[10.5px] font-semibold text-muted shadow-1 hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("taskStacks.collapse")}
            title={t("taskStacks.collapse")}
            onClick={() => handlers.collapse!(task)}
          >
            <FoldVertical className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[10.5px] font-semibold shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            armDelete ? "border-danger bg-danger text-white" : "border-border bg-card text-muted hover:border-danger/40 hover:text-danger"
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
