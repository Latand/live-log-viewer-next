"use client";

import { useEffect, useRef, useState } from "react";

import { Check, PencilLine, RotateCw, X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { saveSessionTitle } from "./sessionTitleApi";

/** Local, pre-poll view of a rename: `title === null` means the override was
    just cleared (revert to auto). `null` optimistic state means "trust the
    server-provided entry as-is". */
type Optimistic = { title: string | null; revision: number } | null;

interface SessionTitleProps {
  file: FileEntry;
  /** Truncation applied to the displayed title. */
  displayMax?: number;
  /** Extra classes on the title text element. */
  titleClassName?: string;
  /** Extra classes on the wrapper. */
  className?: string;
}

/**
 * The rename affordance (issue #33). Shows the effective session title with a
 * focus/hover pencil and double-click to edit; F2 while focused also edits.
 * The inline input preselects the current title, Enter/blur save, Escape
 * cancels, an empty save or the Reset action clears the override back to the
 * auto-derived title. Saves are optimistic: a revision conflict adopts the
 * server record and retries once, a network failure reverts and offers retry.
 */
export function SessionTitle({ file, displayMax = 90, titleClassName = "", className = "" }: SessionTitleProps) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [optimistic, setOptimistic] = useState<Optimistic>(null);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [retryTitle, setRetryTitle] = useState<string | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /* Set whenever the editor closes through an explicit action (Enter, Escape,
     Save/Reset/Cancel). The input then unmounts and fires a blur we must not
     treat as a second, plain "save the field" save. */
  const suppressBlur = useRef(false);

  // Ignore the optimistic overlay once the server has caught up to (or past)
  // the revision we wrote — derived at render time so no effect writes state
  // (cascading-render safe). Comparing revisions, not titles, means a tombstone
  // acknowledgement (cleared → `titleRevision` present again) and a newer
  // conflicting server rename both settle instead of masking server state
  // forever. A clear against a session with no record settles immediately.
  const optimisticSettled = optimistic !== null && (
    file.titleRevision !== undefined
      ? file.titleRevision >= optimistic.revision
      : optimistic.title === null
  );
  const opt = optimisticSettled ? null : optimistic;

  const autoTitle = file.autoTitle ?? file.title;
  // An active override is signalled by `autoTitle` (the preserved derived
  // title); a bare `titleRevision` may be a tombstone (cleared) that only
  // supplies the concurrency base, so it must not light up the Reset control.
  const hasOverride = opt ? opt.title !== null : file.autoTitle !== undefined;
  const effectiveTitle = opt ? (opt.title ?? autoTitle) : file.title;
  const baseRevision = opt ? opt.revision : file.titleRevision ?? 0;

  useEffect(() => {
    if (editing) {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }
  }, [editing]);

  const openEditor = () => {
    // Clear any suppression left armed by a prior close: removing a focused
    // input does not reliably emit blur, so a stale flag could otherwise make
    // the next genuine blur a no-op that silently drops the edit.
    suppressBlur.current = false;
    setValue(effectiveTitle);
    setRetryTitle(undefined);
    setEditing(true);
  };

  const attemptSave = async (title: string | null, allowRetry: boolean) => {
    setBusy(true);
    setRetryTitle(undefined);
    const trimmed = title && title.trim() ? title.trim() : null;
    const result = await saveSessionTitle({
      path: file.path,
      conversationId: file.conversationId,
      pid: file.pid,
      title: trimmed,
      baseRevision,
      windowName: trimmed ?? autoTitle,
    });
    if (result.ok) {
      // A clear returns no record; its tombstone lands at baseRevision + 1, so
      // the overlay waits for exactly that revision instead of settling early.
      const revision = result.override?.revision ?? baseRevision + 1;
      setOptimistic({ title: result.override?.title ?? null, revision });
      setAnnounce(trimmed === null ? t("rename.reset") : t("rename.saved", { title: cleanTitle(trimmed, 60) }));
      setBusy(false);
      return;
    }
    if (result.status === 409 && allowRetry) {
      // Adopt the server's record and retry once against its revision.
      const serverRevision = result.conflict?.revision ?? 0;
      setOptimistic(result.conflict ? { title: result.conflict.title, revision: result.conflict.revision } : { title: null, revision: 0 });
      const retried = await saveSessionTitle({
        path: file.path,
        conversationId: file.conversationId,
        pid: file.pid,
        title: trimmed,
        baseRevision: serverRevision,
        windowName: trimmed ?? autoTitle,
      });
      if (retried.ok) {
        const revision = retried.override?.revision ?? serverRevision + 1;
        setOptimistic({ title: retried.override?.title ?? null, revision });
        setAnnounce(trimmed === null ? t("rename.reset") : t("rename.saved", { title: cleanTitle(trimmed, 60) }));
        setBusy(false);
        return;
      }
      setAnnounce(t("rename.conflict"));
      setRetryTitle(trimmed);
      setBusy(false);
      return;
    }
    // Network / other failure: leave the prior title in place, offer a retry.
    setAnnounce(t("rename.failed"));
    setRetryTitle(trimmed);
    setBusy(false);
  };

  const commit = (title: string | null) => {
    suppressBlur.current = true;
    setEditing(false);
    void attemptSave(title, true);
  };

  const cancel = () => {
    suppressBlur.current = true;
    setEditing(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  const onBlur = () => {
    if (suppressBlur.current) {
      suppressBlur.current = false;
      return;
    }
    // A genuine focus loss while still editing saves the current field value.
    // Read the live input rather than `value` state so a save triggered in the
    // same tick as the last keystroke never persists a stale value.
    const latest = inputRef.current?.value ?? value;
    setEditing(false);
    void attemptSave(latest, true);
  };

  const titleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "F2") {
      event.preventDefault();
      openEditor();
    }
  };

  const stop = (event: React.PointerEvent) => event.stopPropagation();

  if (editing) {
    return (
      <span className={`inline-flex min-w-0 flex-1 items-center gap-1 ${className}`} onPointerDown={stop}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          maxLength={120}
          className="min-w-0 flex-1 rounded-[6px] border border-accent/50 bg-bg px-1.5 py-0.5 text-[12px] font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("rename.inputAria")}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        <button
          type="button"
          className="inline-flex shrink-0 items-center rounded-[6px] border border-line bg-bg px-1 py-0.5 text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("rename.save")}
          title={t("rename.save")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commit(value)}
        >
          <Check className="h-3 w-3" aria-hidden />
        </button>
        {hasOverride ? (
          <button
            type="button"
            className="inline-flex shrink-0 items-center rounded-[6px] border border-line bg-bg px-1 py-0.5 text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("rename.reset")}
            title={t("rename.resetHint", { title: cleanTitle(autoTitle, 60) })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commit(null)}
          >
            <RotateCw className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex shrink-0 items-center rounded-[6px] border border-line bg-bg px-1 py-0.5 text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("rename.cancel")}
          title={t("rename.cancel")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={cancel}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {announce}
        </span>
      </span>
    );
  }

  return (
    <span className={`group/title inline-flex min-w-0 flex-1 items-center gap-1 ${className}`}>
      <span
        className={`min-w-0 flex-1 truncate ${titleClassName}`}
        title={hasOverride ? t("rename.autoHint", { title: cleanTitle(autoTitle, 90) }) : cleanTitle(effectiveTitle)}
        tabIndex={0}
        role="button"
        aria-label={t("rename.editAria", { title: cleanTitle(effectiveTitle, 60) })}
        onDoubleClick={openEditor}
        onKeyDown={titleKeyDown}
      >
        {cleanTitle(effectiveTitle, displayMax)}
      </span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center rounded-[6px] border border-line bg-bg px-1 py-0.5 text-dim opacity-0 transition-opacity hover:border-accent/45 hover:text-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover/title:opacity-100"
        aria-label={t("rename.editAria", { title: cleanTitle(effectiveTitle, 60) })}
        title={t("rename.edit")}
        disabled={busy}
        onPointerDown={stop}
        onClick={openEditor}
      >
        <PencilLine className="h-3 w-3" aria-hidden />
      </button>
      {retryTitle !== undefined ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center rounded-[6px] border border-err/40 bg-bg px-1.5 py-0.5 text-[10px] font-semibold text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onPointerDown={stop}
          onClick={() => void attemptSave(retryTitle, true)}
        >
          {t("rename.retry")}
        </button>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </span>
  );
}
