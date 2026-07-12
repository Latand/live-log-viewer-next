"use client";

import { useRef, useState } from "react";

import { newClientRequestId, uploadTaskAttachment } from "@/components/tasks/taskApi";
import { useComposer } from "@/hooks/useComposer";
import { getLocale, translate } from "@/lib/i18n";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";
import { isTaskAttachment } from "@/lib/tasks/attachmentModel";
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
  /** Staged, already-uploaded refs — durable, so they survive reload. */
  attachments: TaskAttachment[];
  updatedAt: string;
}

interface DraftSnapshot {
  text: string;
  dueAt?: string;
  dueTz?: string;
  attachments: TaskAttachment[];
}

function readDraft(project: string): DraftSnapshot {
  if (typeof window === "undefined") return { text: "", attachments: [] };
  try {
    const raw = window.localStorage.getItem(draftKey(project));
    if (raw) {
      const draft = JSON.parse(raw) as Partial<TaskDraftV1>;
      if (draft && draft.v === 1 && typeof draft.text === "string") {
        return {
          text: draft.text,
          dueAt: typeof draft.dueAt === "string" ? draft.dueAt : undefined,
          dueTz: typeof draft.dueTz === "string" ? draft.dueTz : undefined,
          attachments: Array.isArray(draft.attachments) ? draft.attachments.filter(isTaskAttachment) : [],
        };
      }
    }
    /* One-time migration of the legacy sessionStorage sheet text. */
    const legacy = window.sessionStorage.getItem(legacyKey(project));
    if (legacy) {
      window.sessionStorage.removeItem(legacyKey(project));
      return { text: legacy, attachments: [] };
    }
  } catch {
    /* corrupt storage: start clean rather than throw at mount */
  }
  return { text: "", attachments: [] };
}

/**
 * The shared task-creation draft: `useComposer` (text, voice dictation) plus an
 * optional deadline and durable, content-addressed image attachments, persisted
 * per project in `localStorage`. Images are uploaded the moment they are picked
 * or pasted (not at commit), so the staged refs — text and deadline alongside —
 * survive reload and carry across every entry point. Esc/close keeps the draft;
 * an explicit discard clears it.
 */
export function useTaskDraft(project: string, submit: (overrideText?: string) => void | Promise<void>) {
  /* Read the persisted draft once at mount (a stable value, never re-set). */
  const [initial] = useState(() => readDraft(project));
  /* One id per draft lifecycle, reused across commit retries so a double-fire
     dedups to one task; a fresh id is minted after a task lands. */
  const requestIdRef = useRef(newClientRequestId());
  const [dueAt, setDueAt] = useState<string | undefined>(initial.dueAt);
  const [dueTz, setDueTz] = useState<string | undefined>(initial.dueTz);
  const [attachments, setAttachments] = useState<TaskAttachment[]>(initial.attachments);
  const stateRef = useRef<{ dueAt?: string; dueTz?: string; attachments: TaskAttachment[] }>({
    dueAt: initial.dueAt,
    dueTz: initial.dueTz,
    attachments: initial.attachments,
  });

  const persist = (text: string) => {
    if (typeof window === "undefined") return;
    try {
      const { dueAt: at, dueTz: tz, attachments: atts } = stateRef.current;
      if (!text && !at && atts.length === 0) {
        window.localStorage.removeItem(draftKey(project));
        return;
      }
      const draft: TaskDraftV1 = { v: 1, project, text, dueAt: at, dueTz: tz, attachments: atts, updatedAt: new Date().toISOString() };
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
    stateRef.current = { ...stateRef.current, dueAt: next.dueAt, dueTz: next.dueTz };
    setDueAt(next.dueAt);
    setDueTz(next.dueTz);
    persist(composer.textRef.current);
  };

  const clearDue = () => {
    stateRef.current = { ...stateRef.current, dueAt: undefined, dueTz: undefined };
    setDueAt(undefined);
    setDueTz(undefined);
    persist(composer.textRef.current);
  };

  /** Validate against the shared image policy, upload each accepted file to the
      content-addressed store, and stage the durable ref (persisted at once so it
      survives reload). A failed upload is surfaced on the composer status line;
      nothing is silently dropped. */
  const addFiles = async (files: File[]) => {
    const accepted: File[] = [];
    for (const file of files) {
      if (inboxImageExt(file.type) === null) {
        composer.setStatus({ kind: "err", text: translate(getLocale(), "img.unsupported", { name: file.name || file.type || translate(getLocale(), "img.unknownFile") }) });
        continue;
      }
      if (file.size > MAX_INBOX_IMAGE_BYTES) {
        composer.setStatus({ kind: "err", text: translate(getLocale(), "img.tooLarge", { name: file.name || translate(getLocale(), "img.image") }) });
        continue;
      }
      accepted.push(file);
    }
    for (const file of accepted) {
      const res = await uploadTaskAttachment(file);
      if ("error" in res) {
        composer.setStatus({ kind: "err", text: res.error });
        continue;
      }
      const ref = res.attachment;
      stateRef.current = { ...stateRef.current, attachments: [...stateRef.current.attachments, ref] };
      setAttachments(stateRef.current.attachments);
      persist(composer.textRef.current);
    }
  };

  const removeAttachment = (id: string) => {
    stateRef.current = { ...stateRef.current, attachments: stateRef.current.attachments.filter((att) => att.id !== id) };
    setAttachments(stateRef.current.attachments);
    persist(composer.textRef.current);
  };

  /** The already-uploaded staged refs — the create body owns these. */
  const stagedAttachments = (): TaskAttachment[] => stateRef.current.attachments;

  /** Clears the persisted draft after a successful commit (or explicit discard). */
  const reset = () => {
    requestIdRef.current = newClientRequestId();
    stateRef.current = { dueAt: undefined, dueTz: undefined, attachments: [] };
    setDueAt(undefined);
    setDueTz(undefined);
    setAttachments([]);
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

  return {
    composer,
    dueAt,
    dueTz,
    setDue,
    clearDue,
    attachments,
    addFiles,
    removeAttachment,
    stagedAttachments,
    getRequestId: () => requestIdRef.current,
    reset,
    discard,
  };
}

export type UseTaskDraftReturn = ReturnType<typeof useTaskDraft>;
