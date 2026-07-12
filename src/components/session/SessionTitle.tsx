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

/** Whether two entry snapshots are the same session. The transcript path is the
    stable anchor; when it changes (account/compaction succession) a matching
    conversation id still proves the same session. Deliberately tolerant of
    conversation-id *enrichment* (path unchanged, id undefined→defined), which is
    a later poll filling identity in — not a switch to a different session. */
function isSameSession(a: SessionRef, b: SessionRef): boolean {
  return a.path === b.path || (a.conversationId != null && b.conversationId != null && a.conversationId === b.conversationId);
}

interface SessionRef {
  path: string;
  conversationId?: string;
}

interface SessionTitleProps {
  file: FileEntry;
  /** Truncation applied to the displayed title. */
  displayMax?: number;
  /** Extra classes on the title text element. */
  titleClassName?: string;
  /** Extra classes on the wrapper. */
  className?: string;
  /** Keep the rename control always visible with a 44px touch target (mobile),
      instead of the desktop focus/hover reveal. */
  alwaysVisible?: boolean;
  /** Opens the editor when this changes to a new defined value. Used by the
      scheme board's F2 to open exactly the overlay instance it expanded — a
      broadcast would also open the node's still-mounted board pane and its blur
      would persist an unintended rename. */
  autoEditToken?: number;
}

/**
 * The rename affordance (issue #33). Shows the effective session title with a
 * focus/hover pencil and double-click to edit; F2 while focused also edits.
 * The inline input preselects the current title, Enter/blur save, Escape
 * cancels, an empty save or the Reset action clears the override back to the
 * auto-derived title. Saves are optimistic: a revision conflict adopts the
 * server record and retries once, a network failure reverts and offers retry.
 */
export function SessionTitle({ file, displayMax = 90, titleClassName = "", className = "", alwaysVisible = false, autoEditToken }: SessionTitleProps) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [optimistic, setOptimistic] = useState<Optimistic>(null);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [retryTitle, setRetryTitle] = useState<string | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLSpanElement | null>(null);
  /* Set whenever the editor closes through an explicit action (Enter, Escape,
     Save/Reset/Cancel). The input then unmounts and fires a blur we must not
     treat as a second, plain "save the field" save. */
  const suppressBlur = useRef(false);
  /* Set when an explicit close should return focus to the launcher (keyboard
     users must not lose their place after Enter/Escape/Reset/Cancel). */
  const restoreFocus = useRef(false);

  // Reset all edit state when the component is reused for a *different* session
  // (e.g. the scheme board's expanded overlay switching A→B), so a stale
  // blur/retry never submits A's value under B's identity. Enrichment of the
  // same session (a poll adding `conversationId`, or a succession changing the
  // path while the id holds) is NOT a switch — it keeps the draft. Tracking the
  // previous ref in state is React's sanctioned reset-on-prop-change pattern.
  const [rendered, setRendered] = useState<SessionRef>({ path: file.path, conversationId: file.conversationId });
  if (rendered.path !== file.path || rendered.conversationId !== file.conversationId) {
    const switched = !isSameSession(rendered, file);
    setRendered({ path: file.path, conversationId: file.conversationId });
    if (switched) {
      setEditing(false);
      setValue("");
      setOptimistic(null);
      setBusy(false);
      setAnnounce("");
      setRetryTitle(undefined);
    }
  }
  // Latest session ref for async guards, kept current in an effect (ref writes
  // are not allowed during render).
  const identityRef = useRef<SessionRef>({ path: file.path, conversationId: file.conversationId });
  useEffect(() => {
    identityRef.current = { path: file.path, conversationId: file.conversationId };
  });

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
    } else if (restoreFocus.current) {
      // Restore focus to the launcher when the editor closes. The launcher is
      // never disabled (a save in flight is guarded inside openEditor instead),
      // so focus always lands on an enabled control, never on <body>.
      restoreFocus.current = false;
      launcherRef.current?.focus();
    }
  }, [editing]);

  const openEditor = () => {
    // A save is optimistic and brief; ignore a re-open while one is in flight
    // rather than disabling the launcher (a disabled launcher can't receive the
    // post-save focus restore).
    if (busy) return;
    // Clear any suppression left armed by a prior close: removing a focused
    // input does not reliably emit blur, so a stale flag could otherwise make
    // the next genuine blur a no-op that silently drops the edit.
    suppressBlur.current = false;
    setValue(effectiveTitle);
    setRetryTitle(undefined);
    setEditing(true);
  };
  // Latest openEditor for the token effect, which fires on token change only —
  // openEditor closes over the changing effective title, so read it via a ref.
  const openEditorRef = useRef(openEditor);
  useEffect(() => {
    openEditorRef.current = openEditor;
  });

  // Open when an external caller (scheme-board F2) bumps the token. Only the
  // instance handed a token opens, so the node's other board pane stays closed.
  useEffect(() => {
    if (autoEditToken !== undefined) openEditorRef.current();
  }, [autoEditToken]);

  const attemptSave = async (title: string | null, allowRetry: boolean) => {
    // Capture the session this save belongs to; if the component is reused for
    // another session before the request resolves, drop the stale result rather
    // than write it (e.g. a failed A-save must not arm B's retry with A's value).
    const forSession: SessionRef = { path: file.path, conversationId: file.conversationId };
    const stale = () => !isSameSession(forSession, identityRef.current);
    setBusy(true);
    setRetryTitle(undefined);
    const trimmed = title && title.trim() ? title.trim() : null;
    const result = await saveSessionTitle({
      path: file.path,
      conversationId: file.conversationId,
      title: trimmed,
      baseRevision,
      windowName: trimmed ?? autoTitle,
    });
    if (stale()) return;
    if (result.ok) {
      // The server reports the effective store revision (active record's or the
      // tombstone's), so the overlay waits for exactly that revision — even a
      // no-op clear against an existing tombstone never fabricates N+1.
      setOptimistic({ title: result.override?.title ?? null, revision: result.revision });
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
        title: trimmed,
        baseRevision: serverRevision,
        windowName: trimmed ?? autoTitle,
      });
      if (stale()) return;
      if (retried.ok) {
        // Use the server-reported effective revision, so a retry that resolved
        // to a no-op tombstone records N (not a fabricated N+1) and settles.
        setOptimistic({ title: retried.override?.title ?? null, revision: retried.revision });
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
    restoreFocus.current = true;
    setEditing(false);
    void attemptSave(title, true);
  };

  const cancel = () => {
    suppressBlur.current = true;
    restoreFocus.current = true;
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

  const onEditorBlur = (event: React.FocusEvent<HTMLElement>) => {
    if (suppressBlur.current) {
      suppressBlur.current = false;
      return;
    }
    // Focus moving to another control inside the editor (Tab to Save/Reset/
    // Cancel) is internal — keep the editor open so those buttons are reachable
    // by keyboard. Only a focus loss that leaves the whole editor saves.
    const next = event.relatedTarget as Node | null;
    if (next && editorRef.current?.contains(next)) return;
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
      <span
        ref={editorRef}
        className={`inline-flex min-w-0 flex-1 items-center gap-1 ${className}`}
        onPointerDown={stop}
        onBlur={onEditorBlur}
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          maxLength={120}
          className="min-w-0 flex-1 rounded-[6px] border border-accent/50 bg-bg px-1.5 py-0.5 text-[12px] font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("rename.inputAria")}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="inline-flex shrink-0 items-center rounded-[6px] border border-line bg-bg px-1 py-0.5 text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("rename.save")}
          title={t("rename.save")}
          onClick={() => commit(inputRef.current?.value ?? value)}
        >
          <Check className="h-3 w-3" aria-hidden />
        </button>
        {hasOverride ? (
          <button
            type="button"
            className="inline-flex shrink-0 items-center rounded-[6px] border border-line bg-bg px-1 py-0.5 text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("rename.reset")}
            title={t("rename.resetHint", { title: cleanTitle(autoTitle, 60) })}
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
        ref={launcherRef}
        type="button"
        className={`inline-flex shrink-0 items-center justify-center rounded-[6px] border border-line bg-bg text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          alwaysVisible
            ? "h-11 w-11"
            : "px-1 py-0.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/title:opacity-100"
        }`}
        aria-label={t("rename.editAria", { title: cleanTitle(effectiveTitle, 60) })}
        title={t("rename.edit")}
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
