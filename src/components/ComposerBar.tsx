"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Loader2, Play } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { UseComposerReturn } from "@/hooks/useComposer";
import { prewarmLiveToken } from "@/hooks/useDictation";

import { Hint } from "./Hint";
import { ImagePickerButton, ImagePreviewStrip } from "./imageAttachments";
import { MicButtonView } from "./MicButton";

export interface SendMenuAction {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  tone?: "ok";
  onSelect: () => void;
}

export interface ComposerBarProps {
  composer: UseComposerReturn;
  placeholder: string;
  textareaAriaLabel: string;
  imageAriaLabel: string;
  /** The left side of the bottom row: the mode/target chip and any adjacent
      controls (interrupt/compact on a live pane, a plain label on a draft). */
  leftSlot: ReactNode;
  /** Send-button accessible label, one for each dictation state. */
  sendLabelIdle: string;
  sendLabelRecording: string;
  /** Tooltip while recording (the pane composer explains stop-and-send). */
  sendTitleRecording?: string;
  /** Idle-state send-button appearance: the pane composer paints itself with
      the accent classes, the draft with an inline engine tint. */
  sendIdleClassName: string;
  sendIdleStyle?: CSSProperties;
  sendMenuLabel?: string;
  sendMenuActions?: SendMenuAction[];
  /** The phone composer moves the image picker behind the leftSlot toggle;
      this hides the inline one so the picker exists only once. */
  showImage?: boolean;
  /** Overrides both the inline picker and the paste target — the task composer
      routes images to its durable, upload-on-add store instead of the in-memory
      `useImageAttachments`. When set, the in-memory preview strip is suppressed
      (the caller renders its own from staged refs). */
  onImageFiles?: (files: File[]) => void;
  imageDisabled?: boolean;
  imageDisabledReason?: string;
  /** Durable runtime receipt chips for the last sends on this target (issue
      #25). Rendered under the status line; absent while the runtime bus is off,
      so the composer is unchanged on the landing-disabled path. */
  receipts?: ReactNode;
}

function SendMenu({ label, actions, onClose }: { label: string; actions: SendMenuAction[]; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={label}
      className="absolute bottom-[calc(100%+6px)] right-0 z-40 w-[220px] rounded-surface border border-border bg-raised p-1.5 shadow-2"
    >
      {/* Menu group-label: sentence-case label recipe (design doc §3.6). */}
      <div className="px-2 pb-1 pt-1.5 text-label font-semibold text-secondary">
        {label}
      </div>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          onClick={() => {
            action.onSelect();
            onClose();
          }}
          className={`flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${
            action.tone === "ok" ? "hover:bg-success/10" : "hover:bg-sunken"
          }`}
        >
          <Play className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${action.tone === "ok" ? "text-success" : "text-muted"}`} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-semibold text-primary">{action.label}</span>
            {action.description ? <span className="block text-caption leading-snug text-muted">{action.description}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The bottom-row cluster shared by the pane composer and the spawn draft: the
 * auto-growing textarea, the mic button, the image picker, the send button,
 * the pending-image strip, and the status line. Presentational only — all
 * state lives in `useComposer`, handed in as `composer`.
 */
export function ComposerBar({
  composer,
  placeholder,
  textareaAriaLabel,
  imageAriaLabel,
  leftSlot,
  sendLabelIdle,
  sendLabelRecording,
  sendTitleRecording,
  sendIdleClassName,
  sendIdleStyle,
  sendMenuLabel,
  sendMenuActions = [],
  showImage = true,
  onImageFiles,
  imageDisabled = false,
  imageDisabledReason,
  receipts,
}: ComposerBarProps) {
  const {
    displayText,
    inputRef,
    dictation,
    setText,
    attachments,
    voiceSending,
    insertSpoken,
    stopAndSend,
    submit,
    fieldsDisabled,
    canSend,
    dictationRecording,
    busy,
    status,
  } = composer;
  const isMobile = useIsMobile();
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const hasSendMenu = sendMenuActions.length > 0;
  const imageSendBlocked = imageDisabled && attachments.images.length > 0;
  const sendDisabled = (!canSend && !hasSendMenu) || imageSendBlocked;
  /* Composer action buttons (send, image) are a 32px visual control with a 44px
     touch hit area via a pseudo-element (design doc §3.5, matching the anchored
     mic), so the accent send never renders as a full 44×44 block on a phone;
     desktop keeps the compact p-2. */
  const iconBtn = isMobile ? "relative h-8 w-8 before:absolute before:-inset-1.5 before:content-['']" : "p-2";

  /* While recording, the mic collapses into a wide meter+timer chip and a
     cancel button (see MicButtonView). Sharing the input's row with those and
     the send button starved the live transcript into a narrow left column
     (issue #188), so recording flips the input to a column: the text spans the
     full width and the controls drop to a right-aligned row beneath it. Idle,
     the controls sit inline at the field's right edge as before. */
  const controls = (
    <>
      <MicButtonView {...dictation} busy={voiceSending} onText={insertSpoken} anchored />
      <span
        className="relative inline-flex shrink-0"
        onContextMenu={(event) => {
          if (!hasSendMenu || dictationRecording) return;
          event.preventDefault();
          setSendMenuOpen((open) => !open);
        }}
      >
        <Hint label={dictationRecording ? (sendTitleRecording ?? sendLabelRecording) : sendLabelIdle} align="right">
          <button
            type={dictationRecording ? "button" : "submit"}
            onClick={
              dictationRecording
                ? () => void stopAndSend()
                : (event) => {
                    if (!canSend) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  }
            }
            disabled={sendDisabled}
            aria-disabled={!canSend || imageSendBlocked}
            aria-label={dictationRecording ? sendLabelRecording : sendLabelIdle}
            style={dictationRecording ? undefined : sendIdleStyle}
            className={`inline-flex shrink-0 items-center justify-center rounded-control border text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 aria-disabled:opacity-40 ${iconBtn} ${
              dictationRecording ? "border-danger bg-danger hover:opacity-90" : sendIdleClassName
            }`}
          >
            {busy || voiceSending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          </button>
        </Hint>
        {sendMenuOpen && hasSendMenu && sendMenuLabel ? (
          <SendMenu label={sendMenuLabel} actions={sendMenuActions} onClose={() => setSendMenuOpen(false)} />
        ) : null}
      </span>
    </>
  );

  return (
    <>
      {/* The input is the anchor (design doc §3.5): a single sunken field that
          owns the mic and send controls. Idle it lays them out at the right
          edge (row); while recording it stacks the controls below the
          full-width transcript (column). */}
      <div
        className={`flex rounded-control border border-border bg-sunken focus-within:ring-2 focus-within:ring-accent/40 ${
          dictationRecording ? "flex-col gap-1.5 p-2.5" : "items-end gap-1 py-1 pl-2.5 pr-1"
        }`}
      >
        <textarea
          ref={inputRef}
          value={displayText}
          rows={1}
          readOnly={Boolean(dictation.liveText)}
          onChange={(event) => setText(event.target.value)}
          /* Focusing the composer often precedes a dictation; minting the live
             token here hides its round-trip from the eventual mic press. */
          onFocus={prewarmLiveToken}
          onPaste={(event) => {
            const picks = Array.from(event.clipboardData.items)
              .filter((entry) => entry.type.startsWith("image/"))
              .map((entry) => entry.getAsFile())
              .filter((entry): entry is File => entry !== null);
            if (imageDisabled && picks.length) {
              event.preventDefault();
              return;
            }
            if (onImageFiles) {
              if (picks.length) {
                event.preventDefault();
                onImageFiles(picks);
              }
              return;
            }
            attachments.handlePaste(event);
          }}
          onDragOver={(event) => {
            /* A file drop only fires when its dragover was cancelled — without
               this the browser navigates to the dropped image instead of
               attaching it. Image drags are claimed whether the picker is
               enabled (copy) or disabled (none, keeping the rejection); other
               drag payloads keep their default behavior. */
            if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) {
              event.preventDefault();
              event.dataTransfer.dropEffect = imageDisabled ? "none" : "copy";
            }
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
            if (!files.length) return;
            event.preventDefault();
            event.stopPropagation();
            if (!imageDisabled) (onImageFiles ?? attachments.addFiles)(files);
          }}
          onKeyDown={(event) => {
            /* Enter sends like the old single-line input; Shift+Enter makes a
               new line. Composition guard keeps IME confirms from sending.
               During recording Enter means stop-and-send — a plain submit would
               fire off just the typed prefix and leave the recording running. */
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (dictation.phase === "rec") void stopAndSend();
              else void submit();
            }
          }}
          placeholder={placeholder}
          aria-label={textareaAriaLabel}
          disabled={fieldsDisabled}
          className={`min-w-0 resize-none overflow-y-auto bg-transparent py-1 text-ui leading-[18px] text-primary placeholder:text-muted focus-visible:outline-none disabled:opacity-60 ${
            dictationRecording ? "w-full" : "flex-1 self-center"
          }`}
        />
        {dictationRecording ? (
          <div className="flex items-center justify-end gap-1">{controls}</div>
        ) : (
          controls
        )}
      </div>
      {/* Secondary controls (mode chip, interrupt/compact, images): one quiet
          borderless row under the input. */}
      {leftSlot || showImage ? (
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">{leftSlot}</div>
          {showImage ? (
            <Hint label={imageAriaLabel}>
              <ImagePickerButton
                ariaLabel={imageAriaLabel}
                className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${iconBtn}`}
                onFiles={onImageFiles ?? attachments.addFiles}
                disabled={imageDisabled}
                disabledReason={imageDisabledReason}
              />
            </Hint>
          ) : null}
        </div>
      ) : null}
      {/* The task composer renders its own durable-ref strip; the in-memory one
          stays for the pane/draft composers that still upload at send time. */}
      {onImageFiles ? null : <ImagePreviewStrip images={attachments.images} onRemove={attachments.removeAt} />}
      {status ? (
        <span
          role="status"
          aria-live={status.kind === "err" ? "assertive" : "polite"}
          className={`truncate text-caption font-semibold ${status.kind === "ok" ? "text-success" : status.kind === "info" ? "text-warning" : "text-danger"}`}
        >
          {status.text}
        </span>
      ) : null}
      {imageDisabled && imageDisabledReason ? (
        <span role="status" className="text-caption font-semibold text-muted">{imageDisabledReason}</span>
      ) : null}
      {receipts ? <div className="flex flex-wrap gap-1.5">{receipts}</div> : null}
    </>
  );
}
