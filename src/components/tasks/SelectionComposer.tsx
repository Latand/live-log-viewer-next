"use client";

import { memo, useState } from "react";

import { ComposerBar } from "@/components/ComposerBar";
import { useComposer } from "@/hooks/useComposer";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { broadcastSummary, tmuxSend } from "./broadcast";
import { createTask, sendTask } from "./taskApi";
import { pushTaskToast, sendSummary } from "./taskToast";

const draftKey = (project: string) => "llvSelDraft:" + project;

/**
 * Docked composer over the board while conversation nodes are selected: the
 * full pane composer (dictation, image paste, one-tap voice send) aimed at
 * the whole selection. The «створити задачу» toggle (default on) persists
 * the text as a task card near the selection centroid and delivers it as
 * assignments; off, it loops the plain tmux message route and leaves no
 * trace.
 */
export const SelectionComposer = memo(function SelectionComposer({
  project,
  selection,
  centroid,
}: {
  project: string;
  /** Selected conversation nodes, already filtered to send targets. */
  selection: FileEntry[];
  /** Center of the selected nodes in world coordinates — the new card's home. */
  centroid: { x: number; y: number };
}) {
  const { t } = useLocale();
  const [asTask, setAsTask] = useState(true);

  const composer = useComposer({
    initialText: () => (typeof window === "undefined" ? "" : (sessionStorage.getItem(draftKey(project)) ?? "")),
    persistText: (value) => {
      if (value) sessionStorage.setItem(draftKey(project), value);
      else sessionStorage.removeItem(draftKey(project));
    },
    submit: (overrideText) => send(overrideText),
  });
  const { text, setText, setStatus, busy, setBusy, voiceSending, attachments, inputRef } = composer;

  const send = async (overrideText?: string) => {
    const payloadText = overrideText ?? text;
    const images = attachments.images.map((image) => ({ base64: image.base64, mime: image.mime }));
    if (busy || voiceSending || !selection.length) return;
    if (!payloadText.trim() && !images.length) return;
    if (asTask && !payloadText.trim()) {
      setStatus({ kind: "err", text: t("tasks.composerNeedsText") });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (asTask) {
        const created = await createTask({
          project,
          text: payloadText,
          pos: { x: Math.round(centroid.x), y: Math.round(centroid.y) },
        });
        if ("error" in created) {
          setStatus({ kind: "err", text: created.error });
          return;
        }
        const sent = await sendTask(created.task.id, selection.map((file) => file.path));
        if ("error" in sent) {
          pushTaskToast("err", sent.error);
        } else {
          const summary = sendSummary(sent, selection);
          pushTaskToast(summary.kind, summary.text);
          /* Images never live inside a task body — they ride the plain
             message route to the same targets, exactly like the pane
             composer sends. A top-level send failure skips them: nothing
             says the panes are reachable. */
          if (images.length) {
            const errors: (string | null)[] = [];
            for (const file of selection) errors.push(await tmuxSend(file, "", images));
            if (errors.some((error) => error !== null)) {
              const imageSummary = broadcastSummary(selection, errors);
              pushTaskToast(imageSummary.kind, imageSummary.text);
            }
          }
        }
      } else {
        const errors: (string | null)[] = [];
        for (const file of selection) errors.push(await tmuxSend(file, payloadText, images));
        const summary = broadcastSummary(selection, errors);
        pushTaskToast(summary.kind, summary.text);
      }
      setText("");
      attachments.clear();
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-scheme-ui
      className="absolute bottom-3 left-1/2 z-40 w-[min(600px,92%)] -translate-x-1/2"
      aria-label={t("tasks.composerAria")}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-panel/95 px-2.5 py-2 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
      >
        <ComposerBar
          composer={composer}
          placeholder={t("tasks.composerPlaceholder")}
          textareaAriaLabel={t("composer.textAria")}
          imageAriaLabel={t("composer.addImages")}
          sendLabelIdle={t("composer.sendToAgent")}
          sendLabelRecording={t("composer.stopAndSend")}
          sendTitleRecording={t("composer.stopAndSendTitle")}
          sendIdleClassName="border-accent bg-accent hover:opacity-90"
          leftSlot={
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-chip px-1.5 py-1 text-[9.5px] font-semibold text-[#555]">
                {t("tasks.composerCount", { count: selection.length })}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={asTask}
                title={t("tasks.composerToggleTitle")}
                onClick={() => setAsTask((value) => !value)}
                className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  asTask ? "border-accent bg-accent/10 text-accent" : "border-line bg-panel text-dim hover:text-ink"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${asTask ? "bg-accent" : "bg-[#c9c9d1]"}`}
                  aria-hidden
                />
                {t("tasks.composerToggle")}
              </button>
            </div>
          }
        />
      </form>
    </div>
  );
});
