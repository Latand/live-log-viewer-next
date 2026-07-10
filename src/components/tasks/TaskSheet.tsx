"use client";

import { ChevronLeft, Loader2, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ComposerBar } from "@/components/ComposerBar";
import { X } from "@/components/icons";
import { MicButtonView } from "@/components/MicButton";
import { activityDot, cleanTitle, engineBadge, fmtAge, syntheticFile } from "@/components/utils";
import { useAutosizePinned } from "@/hooks/useAutosizePinned";
import { useComposer } from "@/hooks/useComposer";
import { useDictation } from "@/hooks/useDictation";
import { useLocale } from "@/lib/i18n";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { broadcastSummary, tmuxSend } from "./broadcast";
import { createTask, deleteTask, sendTask, updateTask } from "./taskApi";
import { TASK_STATUS_CYCLE, TASK_TONES, taskTitle } from "./taskModel";
import { TargetChecklist } from "./TargetChecklist";
import { pushTaskToast, sendSummary } from "./taskToast";

export type TaskSheetView = "list" | "new" | { taskId: string };

const sheetDraftKey = (project: string) => "llvTaskSheetDraft:" + project;

function StatusRow({ value, onPick }: { value: TaskStatus; onPick: (status: TaskStatus) => void }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {TASK_STATUS_CYCLE.map((status) => {
        const tone = TASK_TONES[status];
        const active = status === value;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            className="rounded-full border px-2 py-0.5 text-[10.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            style={
              active
                ? { backgroundColor: tone.soft, color: tone.color, borderColor: tone.color }
                : { borderColor: "transparent", color: "#8b8b95" }
            }
            onClick={() => onPick(status)}
          >
            {t(`tasks.status.${status}`)}
          </button>
        );
      })}
    </div>
  );
}

/** Create view: the full composer (dictation + images) plus target checkboxes. */
function NewTaskView({
  project,
  files,
  onCreated,
}: {
  project: string;
  files: FileEntry[];
  onCreated: (task: BoardTask) => void;
}) {
  const { t } = useLocale();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const composer = useComposer({
    initialText: () => (typeof window === "undefined" ? "" : (sessionStorage.getItem(sheetDraftKey(project)) ?? "")),
    persistText: (value) => {
      if (value) sessionStorage.setItem(sheetDraftKey(project), value);
      else sessionStorage.removeItem(sheetDraftKey(project));
    },
    submit: (overrideText) => save(overrideText),
  });
  const { text, setText, setStatus, busy, setBusy, voiceSending, attachments } = composer;

  const save = async (overrideText?: string) => {
    const payloadText = overrideText ?? text;
    if (busy || voiceSending) return;
    if (!payloadText.trim()) {
      setStatus({ kind: "err", text: t("tasks.composerNeedsText") });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const created = await createTask({ project, text: payloadText, pos: { x: 120, y: 120 } });
      if ("error" in created) {
        setStatus({ kind: "err", text: created.error });
        return;
      }
      const targets = [...checked];
      if (targets.length) {
        const sent = await sendTask(created.task.id, targets);
        if ("error" in sent) {
          /* Nothing was delivered — keep the images out of unreachable panes. */
          pushTaskToast("err", sent.error);
        } else {
          const summary = sendSummary(sent, files);
          pushTaskToast(summary.kind, summary.text);
          const images = attachments.images.map((image) => ({ base64: image.base64, mime: image.mime }));
          if (images.length) {
            /* Images ride the plain message route, but only to targets whose
               task delivery succeeded — a failed target must not get detached
               images with no task context. Failures show the «Delivered N of
               M» breakdown before the attachments clear, so a lost image is
               never silent. */
            const byPath = new Map(files.map((file) => [file.path, file]));
            const okEntries = sent.results
              .filter((result) => result.ok)
              .map((result) => byPath.get(result.path) ?? syntheticFile(result.path));
            const errors: (string | null)[] = [];
            for (const entry of okEntries) errors.push(await tmuxSend(entry, "", images));
            if (errors.some((error) => error !== null)) {
              const imageSummary = broadcastSummary(okEntries, errors);
              pushTaskToast(imageSummary.kind, imageSummary.text);
            }
          }
        }
      }
      setText("");
      attachments.clear();
      onCreated(created.task);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
    >
      <div className="flex flex-col gap-1.5">
        <ComposerBar
          composer={composer}
          placeholder={t("tasks.newPlaceholder")}
          textareaAriaLabel={t("tasks.editAria")}
          imageAriaLabel={t("composer.addImages")}
          sendLabelIdle={t("tasks.sheetCreate")}
          sendLabelRecording={t("composer.stopAndSend")}
          sendIdleClassName="border-accent bg-accent hover:opacity-90"
          leftSlot={
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-chip px-1.5 py-1 text-[9.5px] font-semibold text-[#555]">
              {t("tasks.sheetTargets", { count: checked.size })}
            </span>
          }
        />
      </div>
      <div className="flex flex-col gap-1 rounded-[10px] border border-line bg-panel p-1.5">
        <div className="px-1 text-[10.5px] font-bold text-dim">{t("tasks.pickerTitle")}</div>
        <TargetChecklist files={files} project={project} checked={checked} onChange={setChecked} maxHeight={9999} />
      </div>
    </form>
  );
}

/** Edit view: text with dictation, status chips, assignments, send, delete. */
function TaskDetailView({
  task,
  files,
  onDeleted,
}: {
  task: BoardTask;
  files: FileEntry[];
  onDeleted: () => void;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(task.text);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  const [armDelete, setArmDelete] = useState(false);

  useEffect(() => {
    if (!armDelete) return;
    const timer = window.setTimeout(() => setArmDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armDelete]);

  const editRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    onError: (message) => pushTaskToast("err", message),
    onUnclaimedText: (spoken) => setDraft((prev) => (prev ? prev.trimEnd() + " " + spoken : spoken)),
    onLiveCommit: (spoken) => setDraft((prev) => (prev ? prev.trimEnd() + " " + spoken : spoken)),
  });

  /* Same grow-and-pin seam as the composers: the edit field keeps the newest
     dictated/typed words visible instead of the old wrapped-line `rows`
     heuristic that miscounted height and pinned the view to the top. */
  const displayText = dictation.liveText ? (draft ? draft.trimEnd() + " " : "") + dictation.liveText : draft;
  useAutosizePinned(editRef, displayText, { maxPx: 260, minPx: 84, pinned: Boolean(dictation.liveText) });

  /* Re-created each render, so blur/send always commit the latest draft.
     Returns the PATCH error: deliveries read the persisted text server-side,
     so they must wait for the save and abort when it fails, or a quick send
     after editing would deliver the previous body. A blank draft is never
     persisted (the server rejects empty text) — deliveries treat it as an
     error too, or the blank editor would silently send the old body. */
  const commitText = async (): Promise<string | null> => {
    if (draft === task.text) return null;
    if (!draft.trim()) return t("tasks.emptyTextBlocked");
    const error = await updateTask(task.id, { text: draft });
    if (error) pushTaskToast("err", error);
    return error;
  };

  const send = async () => {
    const targets = [...checked];
    if (!targets.length || sending) return;
    if (!draft.trim()) {
      pushTaskToast("err", t("tasks.emptyTextBlocked"));
      return;
    }
    setSending(true);
    try {
      if ((await commitText()) !== null) return;
      const sent = await sendTask(task.id, targets);
      if ("error" in sent) pushTaskToast("err", sent.error);
      else {
        const summary = sendSummary(sent, files);
        pushTaskToast(summary.kind, summary.text);
        setChecked(new Set());
      }
    } finally {
      setSending(false);
    }
  };

  const byPath = new Map(files.map((file) => [file.path, file]));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel p-2">
        <textarea
          ref={editRef}
          value={displayText}
          readOnly={Boolean(dictation.liveText)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitText()}
          rows={4}
          aria-label={t("tasks.editAria")}
          maxLength={6000}
          className="w-full resize-none overflow-y-auto rounded-[8px] border border-line bg-panel px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[#222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        <div className="flex items-center justify-between gap-1.5">
          <StatusRow
            value={task.status}
            onPick={(status) => {
              if (status === task.status) return;
              void updateTask(task.id, { status }).then((error) => {
                if (error) pushTaskToast("err", error);
              });
            }}
          />
          <MicButtonView {...dictation} onText={(spoken) => setDraft((prev) => (prev ? prev.trimEnd() + " " + spoken : spoken))} />
        </div>
      </div>

      {task.assignments.length ? (
        <div className="flex flex-col gap-1 rounded-[10px] border border-line bg-panel p-2">
          <div className="text-[10.5px] font-bold text-dim">{t("tasks.sheetAssignments")}</div>
          {task.assignments.map((assignment, index) => {
            const file = assignment.path ? (byPath.get(assignment.path) ?? null) : null;
            const failed = assignment.state === "failed";
            const badge = file ? engineBadge(file) : null;
            const title = assignment.path
              ? file
                ? cleanTitle(file.title, 44)
                : (assignment.path.split("/").pop() ?? assignment.path)
              : t("tasks.spawning");
            return (
              <div
                key={(assignment.path ?? "spawning") + index}
                className={`flex h-7 items-center gap-1.5 rounded-[6px] px-1.5 ${
                  failed ? "bg-[#faeee9] text-[#a04a2e]" : file ? "bg-bg" : "bg-bg opacity-60"
                }`}
                title={failed ? t("tasks.chipFailedTitle", { error: assignment.error ?? "" }) : undefined}
              >
                {file ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} /> : null}
                {badge ? (
                  <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
                    {badge.label}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{title}</span>
                {failed ? <span aria-hidden>⚠</span> : null}
                {assignment.path && (failed || !file) ? (
                  <button
                    type="button"
                    className="shrink-0 rounded px-1 text-[10px] font-bold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onClick={() => {
                      void (async () => {
                        if (!draft.trim()) {
                          pushTaskToast("err", t("tasks.emptyTextBlocked"));
                          return;
                        }
                        if ((await commitText()) !== null) return;
                        const sent = await sendTask(task.id, [assignment.path!]);
                        if ("error" in sent) pushTaskToast("err", sent.error);
                        else {
                          const summary = sendSummary(sent, files);
                          pushTaskToast(summary.kind, summary.text);
                        }
                      })();
                    }}
                  >
                    {t("tasks.retry")}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-col gap-1 rounded-[10px] border border-line bg-panel p-1.5">
        <div className="px-1 text-[10.5px] font-bold text-dim">{t("tasks.pickerTitle")}</div>
        <TargetChecklist files={files} project={task.project} checked={checked} onChange={setChecked} maxHeight={9999} />
        <button
          type="button"
          disabled={!checked.size || sending}
          className="mt-1 inline-flex h-8 items-center justify-center gap-1.5 rounded-[8px] border border-accent bg-accent text-[11.5px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
          onClick={() => void send()}
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
          {t("tasks.pickerSend", { count: checked.size })}
        </button>
      </div>

      <button
        type="button"
        className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-[8px] border text-[11.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          armDelete ? "border-err bg-err text-white" : "border-line bg-panel text-dim hover:border-err/40 hover:text-err"
        }`}
        onClick={() => {
          if (!armDelete) {
            setArmDelete(true);
            return;
          }
          void deleteTask(task.id).then((error) => {
            if (error) pushTaskToast("err", error);
            else onDeleted();
          });
        }}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        {armDelete ? t("tasks.deleteConfirm") : t("tasks.delete")}
      </button>
    </div>
  );
}

/**
 * The phone's task surface: list → detail/create, full-screen over the focus
 * view. Everything the desktop card offers minus spatial gestures — text with
 * dictation and images, manual status, delete, and multi-target assignment
 * through the same checkbox picker.
 */
export function TaskSheet({
  project,
  tasks,
  files,
  initialView,
  onClose,
}: {
  project: string;
  tasks: BoardTask[];
  files: FileEntry[];
  initialView: TaskSheetView;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [view, setView] = useState<TaskSheetView>(initialView);
  const rows = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const doneRank = (task: BoardTask) => (task.status === "done" ? 1 : 0);
        return doneRank(a) - doneRank(b) || b.updatedAt.localeCompare(a.updatedAt);
      }),
    [tasks],
  );
  const openTask = typeof view === "object" ? (tasks.find((task) => task.id === view.taskId) ?? null) : null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        {view !== "list" ? (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("tasks.sheetBack")}
            onClick={() => setView("list")}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        <span className="shrink-0 text-[13px] font-bold">
          {view === "new" ? t("tasks.sheetNew") : openTask ? taskTitle(openTask.text) || t("tasks.untitled") : t("tasks.panelTitle")}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">{project}</span>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {view === "list" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          <button
            type="button"
            className="flex h-9 shrink-0 items-center justify-center gap-1 rounded-[10px] border border-dashed border-accent/50 text-[12px] font-bold text-accent hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => setView("new")}
          >
            + {t("tasks.sheetNew")}
          </button>
          {rows.map((task) => {
            const tone = TASK_TONES[task.status];
            return (
              <button
                key={task.id}
                type="button"
                className={`flex w-full min-w-0 flex-col gap-0.5 rounded-[10px] border border-line bg-panel px-2.5 py-2 text-left shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  task.status === "done" ? "opacity-60" : ""
                }`}
                onClick={() => setView({ taskId: task.id })}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                    style={{ backgroundColor: tone.soft, color: tone.color }}
                  >
                    {t(`tasks.status.${task.status}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                    {taskTitle(task.text) || t("tasks.untitled")}
                  </span>
                </span>
                <span className="flex items-center gap-2 pl-0.5 text-[10.5px] text-dim">
                  {task.assignments.length ? <span>⤷ {task.assignments.length}</span> : null}
                  <span>{fmtAge(new Date(task.updatedAt).getTime() / 1000)}</span>
                </span>
              </button>
            );
          })}
          {!rows.length ? <div className="px-2 py-4 text-center text-[11.5px] text-dim">{t("tasks.sheetEmpty")}</div> : null}
        </div>
      ) : view === "new" ? (
        <NewTaskView project={project} files={files} onCreated={(task) => setView({ taskId: task.id })} />
      ) : openTask ? (
        <TaskDetailView key={openTask.id} task={openTask} files={files} onDeleted={() => setView("list")} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[12px] text-dim">{t("tasks.sheetGone")}</div>
      )}
    </div>
  );
}
