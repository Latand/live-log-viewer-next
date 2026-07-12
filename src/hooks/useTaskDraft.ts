"use client";

import { useRef, useState } from "react";

import { newClientRequestId, uploadTaskAttachment } from "@/components/tasks/taskApi";
import { useComposer } from "@/hooks/useComposer";
import { getLocale, translate } from "@/lib/i18n";
import type { TaskAttachment } from "@/lib/tasks/types";

/** One draft per project, shared by every creation entry point. */
const draftKey = (project: string) => "llvTaskDraft:" + project;
/** The sheet's former per-project text draft, migrated on first read. */
const legacyKey = (project: string) => "llvTaskSheetDraft:" + project;

interface TaskDraftV1 {
  v: 1;
  project: string;
  text: string;
  dueAt?: string;
  dueTz?: string;
  updatedAt: string;
}

function readDraft(project: string): { text: string; dueAt?: string; dueTz?: string } {
  if (typeof window === "undefined") return { text: "" };
  try {
    const raw = window.localStorage.getItem(draftKey(project));
    if (raw) {
      const draft = JSON.parse(raw) as Partial<TaskDraftV1>;
      if (draft && draft.v === 1 && typeof draft.text === "string") {
        return { text: draft.text, dueAt: typeof draft.dueAt === "string" ? draft.dueAt : undefined, dueTz: typeof draft.dueTz === "string" ? draft.dueTz : undefined };
      }
    }
    /* One-time migration of the legacy sessionStorage sheet text. */
    const legacy = window.sessionStorage.getItem(legacyKey(project));
    if (legacy) {
      window.sessionStorage.removeItem(legacyKey(project));
      return { text: legacy };
    }
  } catch {
    /* corrupt storage: start clean rather than throw at mount */
  }
  return { text: "" };
}

/**
 * The shared task-creation draft: `useComposer` (text, voice dictation, image
 * attachments) plus an optional deadline, persisted per project in
 * `localStorage` so a draft started at one entry point can be finished at
 * another and survives reload. Esc/close keeps the draft; an explicit discard
 * clears it. The caller supplies `submit` (the one-tap voice-send path) and
 * calls {@link stageAttachments} at commit to turn the picked images into
 * durable, task-ownable refs.
 */
export function useTaskDraft(project: string, submit: (overrideText?: string) => void | Promise<void>) {
  /* Read the persisted draft once at mount (a stable value, never re-set). */
  const [initial] = useState(() => readDraft(project));
  /* One id per draft lifecycle, reused across commit retries so a double-fire
     dedups to one task; a fresh id is minted after a task lands. */
  const requestIdRef = useRef(newClientRequestId());
  const [dueAt, setDueAt] = useState<string | undefined>(initial.dueAt);
  const [dueTz, setDueTz] = useState<string | undefined>(initial.dueTz);
  const dueRef = useRef<{ dueAt?: string; dueTz?: string }>({ dueAt: initial.dueAt, dueTz: initial.dueTz });

  const persist = (text: string) => {
    if (typeof window === "undefined") return;
    try {
      if (!text && !dueRef.current.dueAt) {
        window.localStorage.removeItem(draftKey(project));
        return;
      }
      const draft: TaskDraftV1 = { v: 1, project, text, ...dueRef.current, updatedAt: new Date().toISOString() };
      window.localStorage.setItem(draftKey(project), JSON.stringify(draft));
    } catch {
      /* storage full / disabled: the draft just won't survive reload */
    }
  };

  const composer = useComposer({
    initialText: () => initial.text,
    persistText: persist,
    submit,
  });

  const setDue = (next: { dueAt: string; dueTz: string }) => {
    dueRef.current = next;
    setDueAt(next.dueAt);
    setDueTz(next.dueTz);
    persist(composer.textRef.current);
  };

  const clearDue = () => {
    dueRef.current = {};
    setDueAt(undefined);
    setDueTz(undefined);
    persist(composer.textRef.current);
  };

  /** Uploads every picked image to the content-addressed store and returns the
      durable refs, so the create body owns them. Rejects loudly on failure —
      the caller keeps the draft and shows the error rather than dropping images. */
  const stageAttachments = async (): Promise<TaskAttachment[] | { error: string }> => {
    const refs: TaskAttachment[] = [];
    for (const image of composer.attachments.images) {
      const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "attachment", { type: image.mime });
      const res = await uploadTaskAttachment(file);
      if ("error" in res) return { error: res.error };
      refs.push(res.attachment);
    }
    return refs;
  };

  /** Clears the persisted draft after a successful commit (or explicit discard). */
  const reset = () => {
    dueRef.current = {};
    requestIdRef.current = newClientRequestId();
    setDueAt(undefined);
    setDueTz(undefined);
    composer.setText("");
    composer.attachments.clear();
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(draftKey(project));
      } catch {
        /* ignore */
      }
    }
  };

  const discard = () => {
    reset();
    composer.setStatus({ kind: "ok", text: translate(getLocale(), "tasks.draftDiscarded") });
  };

  return { composer, dueAt, dueTz, setDue, clearDue, stageAttachments, getRequestId: () => requestIdRef.current, reset, discard };
}

export type UseTaskDraftReturn = ReturnType<typeof useTaskDraft>;
