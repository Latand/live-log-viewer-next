"use client";

import { useRef, useState, useSyncExternalStore } from "react";

import { useImageAttachments } from "@/components/imageAttachments";
import { useAutosizePinned } from "@/hooks/useAutosizePinned";
import { useDictation } from "@/hooks/useDictation";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

/* The pane / draft / bulk / task-create composers grow to ~6 rows, then scroll
   internally pinned to the newest text. */
const COMPOSER_MAX_PX = 160;
/* On the phone the field grows further — up to ~40% of the viewport (issue #177
   item 3) — so a multi-line prompt is comfortable to read while typing, past
   which it scrolls internally. The send/mic controls keep their 44px targets. */
const COMPOSER_MAX_VH = 0.4;

/* Live viewport height, tracked the same way as `useIsMobile` (external store,
   no setState-in-effect) so the phone grow ceiling re-measures on rotation and
   the server render stays stable. */
function subscribeViewport(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}
function useViewportHeight(): number {
  return useSyncExternalStore(subscribeViewport, () => window.innerHeight, () => 800);
}

export interface ComposerStatus {
  /** `info` is a neutral/pending tone (e.g. a message held for a migration). */
  kind: "ok" | "err" | "info";
  text: string;
}

export interface UseComposerOptions {
  /** The draft's initial text, read once on mount (e.g. a persisted draft or a
      seeded prompt). Passed as a lazy initializer so it runs a single time. */
  initialText: () => string;
  /** Persist the draft after every edit; called with "" when the draft empties
      so each caller can drop its own storage key. */
  persistText: (value: string) => void;
  /** Delivers the current draft with the caller's own send semantics. The hook
      only invokes it from the one-tap voice path; the form/Enter path reads it
      back off the returned object. */
  submit: (overrideText?: string) => void | Promise<void>;
  /** An extra reason the fields are locked beyond a send/voice in flight (e.g.
      a draft pane waiting on the agent it just spawned). Folds into
      `fieldsDisabled` and `canSend` exactly like the in-flight flags. */
  disabled?: boolean;
  imageCapability?: RuntimeImageCapability | null;
}

/**
 * The composer state machine shared by the pane composer and the spawn draft:
 * the ref-backed draft with persistence, dictation wiring (batch + realtime
 * overlay), image attachments, the auto-growing textarea measurement, one-tap
 * voice send, and the busy/status/canSend derivations. Each caller keeps its
 * own delivery (`submit`) and its own surrounding chrome; everything below the
 * text lives in `ComposerBar`.
 */
export function useComposer({ initialText, persistText, submit, disabled = false, imageCapability = null }: UseComposerOptions) {
  /* A remount mid-typing (column reshuffles, draft handovers) restores the
     draft from storage; the ref always holds the latest text so async
     dictation callbacks append to what the user typed meanwhile instead of
     overwriting it. */
  const [text, setTextState] = useState(initialText);
  const textRef = useRef(text);
  const setText = (value: string | ((prev: string) => string)) => {
    const next = typeof value === "function" ? value(textRef.current) : value;
    textRef.current = next;
    setTextState(next);
    persistText(next);
  };

  const [busy, setBusy] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const [status, setStatus] = useState<ComposerStatus | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* Grow ceiling: the desktop keeps its ~6-row cap; the phone tracks 40% of the
     live viewport height so the field can open into a tall multi-line input and
     re-measures on rotation/resize (issue #177 item 3). */
  const isMobile = useIsMobile();
  const viewportH = useViewportHeight();
  const maxPx = isMobile ? Math.max(COMPOSER_MAX_PX, Math.round(viewportH * COMPOSER_MAX_VH)) : COMPOSER_MAX_PX;

  const attachments = useImageAttachments({
    onError: (message) => setStatus({ kind: "err", text: message }),
    onAdded: () => setStatus(null),
    imageCapability,
  });

  const insertSpoken = (spoken: string) => {
    setText((prev) => (prev ? prev.trimEnd() + " " + spoken : spoken));
    setStatus(null);
    /* After the state-driven value updates, drop the caret at the end and
       scroll the newest words into view — an insert always follows the text,
       so the batch/unclaimed transcript never lands off-screen. */
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.scrollTop = el.scrollHeight;
    });
  };
  /* onUnclaimedText catches the cap auto-stop, whose transcript no stop()
     promise waits for — it goes into the input for review, never auto-sent.
     onLiveCommit lands realtime segments in the draft while still talking. */
  const dictation = useDictation({
    onError: (message) => setStatus({ kind: "err", text: message }),
    onUnclaimedText: insertSpoken,
    onLiveCommit: insertSpoken,
  });

  /* Realtime dictation overlays the in-flight transcript on the draft; the
     draft state itself stays clean until stop() resolves and insertSpoken
     appends the final text, so the two never double up. */
  const displayText = dictation.liveText ? (text ? text.trimEnd() + " " : "") + dictation.liveText : text;

  /* Grow-to-max plus pin-to-newest: while a live dictation overlays the draft
     the field pins to the bottom on every update so the latest spoken words
     stay visible; while typing it pins only when the caret is at the end. */
  useAutosizePinned(inputRef, displayText, {
    maxPx,
    pinned: Boolean(dictation.liveText),
  });

  /* One-tap voice send: stop the recording in flight, wait for the transcript,
     append it to whatever is already typed, then hand off to submit — no
     second tap on a separate send button. A transcription failure leaves the
     typed text untouched and never submits; useDictation already reported the
     error through onError above. */
  const stopAndSend = async () => {
    if (busy || voiceSending) return;
    setVoiceSending(true);
    try {
      const spoken = await dictation.stop();
      if (spoken === null) return;
      /* Read through the ref: live commits and typing may have grown the draft
         while this closure's render was in flight. In realtime mode `spoken`
         is just the uncommitted tail — often empty. */
      const combined = spoken ? (textRef.current ? textRef.current.trimEnd() + " " + spoken : spoken) : textRef.current;
      setText(combined);
      await submit(combined);
    } finally {
      setVoiceSending(false);
    }
  };

  const dictationRecording = dictation.phase === "rec";
  const dictationBusy = dictation.phase === "busy";
  const fieldsDisabled = busy || voiceSending || disabled;
  const canSend =
    !fieldsDisabled && !dictationBusy && (dictationRecording || Boolean(text.trim()) || attachments.images.length > 0);

  return {
    text,
    textRef,
    setText,
    /* The raw setter, for restoring an already-persisted draft from outside
       (a link-arrow drop) without re-persisting it through setText. */
    setTextState,
    displayText,
    inputRef,
    status,
    setStatus,
    busy,
    setBusy,
    voiceSending,
    dictation,
    attachments,
    insertSpoken,
    stopAndSend,
    submit,
    dictationRecording,
    dictationBusy,
    fieldsDisabled,
    canSend,
  };
}

export type UseComposerReturn = ReturnType<typeof useComposer>;
