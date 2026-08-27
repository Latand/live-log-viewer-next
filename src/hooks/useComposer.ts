"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { useImageAttachments } from "@/components/imageAttachments";
import { performVoiceSend } from "@/hooks/composerVoiceSend";
import { useAutosizePinned } from "@/hooks/useAutosizePinned";
import { useDictation } from "@/hooks/useDictation";
import { useIsMobile } from "@/hooks/useIsMobile";
import { COMPOSER_MAX_PX, keyboardInset, mobileComposerCeiling, visibleViewportHeight } from "@/lib/composerScroll";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

/* Live VISIBLE viewport height, tracked the same way as `useIsMobile`
   (external store, no setState-in-effect) so the phone grow ceiling
   re-measures on rotation and the server render stays stable. The on-screen
   keyboard is the reason both event sources matter (#983): browsers honoring
   the app's interactive-widget=resizes-content shrink the layout viewport and
   fire window `resize`, but iOS Safari ignores that meta — there the keyboard
   shrinks only `window.visualViewport`, whose own `resize` is the one signal
   that the visible area halved. */
function subscribeViewport(onChange: () => void) {
  window.addEventListener("resize", onChange);
  const visual = window.visualViewport;
  visual?.addEventListener("resize", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    visual?.removeEventListener("resize", onChange);
  };
}
function useViewportHeight(): number {
  return useSyncExternalStore(subscribeViewport, () => visibleViewportHeight(window.innerHeight, window.visualViewport), () => 800);
}

/**
 * The on-screen keyboard's overlap with the layout viewport (#983): how much of
 * a full-height (100dvh) surface the keyboard covers when the browser refuses
 * to shrink the layout viewport (iOS Safari). The mobile focus root pads this
 * away so the composer's controls stay above the keyboard and the browser
 * never scrolls the window to reach the focused field. Zero whenever the two
 * viewports agree — keyboard closed, resizes-content honored, no
 * visualViewport, desktop — so every other layout is byte-identical.
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribeViewport, () => keyboardInset(window.innerHeight, window.visualViewport), () => 0);
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
  /** Whether this composer can deliver a non-image attachment (issue #1224):
      the pane composer writes it to the conversation's inbox and names its path
      in the message, so it takes any file. A composer without that road refuses
      one by name instead of dropping it. */
  acceptFiles?: boolean;
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
export function useComposer({ initialText, persistText, submit, disabled = false, imageCapability = null, acceptFiles = false, holdInputWhileBusy = true }: UseComposerOptions) {
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
     kept current in an effect.

     Attached through a callback ref rather than a mount-time effect: the voice
     card's `ComposerBar` moves between the card and the floating PiP document
     mid-call, which remounts the textarea while this hook stays put — a one-shot
     effect would leave the new element without its IME mirror. */
  const setTextRef = useRef(setText);
  useLayoutEffect(() => { setTextRef.current = setText; });
  const detachInput = useRef<(() => void) | null>(null);
  const attachInput = useCallback((el: HTMLTextAreaElement | null) => {
    detachInput.current?.();
    detachInput.current = null;
    inputRef.current = el;
    if (!el) return;
    let composing = false;
    const onCompositionStart = () => { composing = true; };
    const onInput = () => { if (composing) setTextRef.current(el.value); };
    const onCompositionEnd = () => { composing = false; setTextRef.current(el.value); };
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("input", onInput);
    el.addEventListener("compositionend", onCompositionEnd);
    detachInput.current = () => {
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  /* Grow ceiling: the desktop keeps its fixed ~6-row cap; the phone budgets
     against the live VISIBLE viewport height so the field can open into a tall
     multi-line input and re-measures on rotation/resize (issue #177 item 3).
     With the on-screen keyboard up the visible viewport is roughly half the
     screen — budgeting against the full layout height there grew the field
     past what fits above the keyboard and pushed the picker/send controls out
     of view (#983); on a short rotated viewport even the 160px cap overflows,
     so the ceiling yields the chrome's share first and shrinks below it. */
  const isMobile = useIsMobile();
  const viewportH = useViewportHeight();
  const maxPx = isMobile ? mobileComposerCeiling(viewportH) : COMPOSER_MAX_PX;

  const attachments = useImageAttachments({
    onError: (message) => setStatus({ kind: "err", text: message }),
    onAdded: () => setStatus(null),
    imageCapability,
    acceptFiles,
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
     error through onError above. The orchestration lives in a pure, injected
     helper (`performVoiceSend`) so the "same submit as click/Enter" unification
     is provable without a leaky useDictation module mock (round-1 P1#1). The
     draft is read live through the ref: realtime commits and typing may have
     grown it while this closure's render was in flight. */
  const stopAndSend = () => performVoiceSend({
    busy,
    voiceSending,
    setVoiceSending,
    stop: dictation.stop,
    currentText: () => textRef.current,
    setText,
    submit,
  });

  const dictationRecording = dictation.phase === "rec";
  const dictationBusy = dictation.phase === "busy";
  const fieldsDisabled = (holdInputWhileBusy && busy) || voiceSending || disabled;
  /* An attachment still decoding, or one that failed to read, blocks Send with a
     visible reason (issue #419): a send now would silently drop that image, so
     the composer waits for every slot to settle (or be removed/retried). */
  const attachmentsBlocked = attachments.hasReading || attachments.hasError;
  const canSend =
    !fieldsDisabled && !dictationBusy && !attachmentsBlocked
    && (dictationRecording || Boolean(text.trim()) || attachments.images.length > 0 || attachments.files.length > 0);

  return {
    text,
    textRef,
    setText,
    /* The raw setter, for restoring an already-persisted draft from outside
       (a link-arrow drop) without re-persisting it through setText. */
    setTextState,
    displayText,
    inputRef,
    /* The textarea's ref: keeps `inputRef` current AND (re)wires the IME mirror,
       so the field keeps working after a move between documents. */
    attachInput,
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
