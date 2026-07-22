"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

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
  /** Whether an in-flight delivery locks the text field. Queue-first composers
      (issue #561) pass `false`: a submitted message is already in the durable
      queue, so the input must stay typable while it is delivered — there is no
      long-lived "sending" state holding the draft hostage. */
  holdInputWhileBusy?: boolean;
}

/**
 * The composer state machine shared by the pane composer and the spawn draft:
 * the ref-backed draft with persistence, dictation wiring (batch + realtime
 * overlay), image attachments, the auto-growing textarea measurement, one-tap
 * voice send, and the busy/status/canSend derivations. Each caller keeps its
 * own delivery (`submit`) and its own surrounding chrome; everything below the
 * text lives in `ComposerBar`.
 */
export function useComposer({ initialText, persistText, submit, disabled = false, imageCapability = null, holdInputWhileBusy = true }: UseComposerOptions) {
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

  /* IME-safe input across live board/feed refreshes (issue #272). While an IME
     composition is in flight — every word on a mobile keyboard: CJK, Cyrillic,
     autocorrect, emoji — the browser suppresses React's controlled-input change
     event, so the `text` state falls behind the half-composed DOM value. A
     background board/feed refresh then re-renders this controlled textarea, and
     React re-asserts the stale `text` over the field: the composition is wiped
     and the caret jumps to the end mid-word.

     The mirror must read the field in the browser's own order. `compositionupdate`
     fires BEFORE the engine applies that step's composed value to the field, so
     reading `el.value` there captures the previous value and still lags a step
     behind (the exact clobber). The native `input` event — which every engine
     fires on each composition step, unlike the unreliable synthetic
     composition events — fires AFTER the value is applied, so reading `el.value`
     there mirrors the true half-composed DOM value into the draft. A refresh
     then re-renders identical text and never disturbs the caret. Outside a
     composition React's own onChange already owns the value, so the input
     listener is gated on an in-flight composition to avoid double-persisting
     each keystroke; `compositionend` does the authoritative final sync some
     engines omit a trailing change for and clears the gate. The listeners
     outlive any single render, so they read the latest `setText` through a ref
     kept current in an effect. */
  const setTextRef = useRef(setText);
  useLayoutEffect(() => { setTextRef.current = setText; });
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    let composing = false;
    const onCompositionStart = () => { composing = true; };
    const onInput = () => { if (composing) setTextRef.current(el.value); };
    const onCompositionEnd = () => { composing = false; setTextRef.current(el.value); };
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("input", onInput);
    el.addEventListener("compositionend", onCompositionEnd);
    return () => {
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

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
  const fieldsDisabled = (holdInputWhileBusy && busy) || voiceSending || disabled;
  /* An attachment still decoding, or one that failed to read, blocks Send with a
     visible reason (issue #419): a send now would silently drop that image, so
     the composer waits for every slot to settle (or be removed/retried). */
  const attachmentsBlocked = attachments.hasReading || attachments.hasError;
  const canSend =
    !fieldsDisabled && !dictationBusy && !attachmentsBlocked && (dictationRecording || Boolean(text.trim()) || attachments.images.length > 0);

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
    attachmentsBlocked,
  };
}

export type UseComposerReturn = ReturnType<typeof useComposer>;
