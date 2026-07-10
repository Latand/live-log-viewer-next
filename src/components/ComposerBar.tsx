"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Loader2, Play } from "@/components/icons";
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
      className="absolute bottom-[calc(100%+6px)] right-0 z-40 w-[220px] rounded-[12px] border border-line bg-panel p-1.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
    >
      <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-bold uppercase tracking-wide text-dim">
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
          className={`flex w-full items-start gap-2 rounded-[9px] px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${
            action.tone === "ok" ? "hover:bg-ok/10" : "hover:bg-bg"
          }`}
        >
          <Play className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${action.tone === "ok" ? "text-ok" : "text-dim"}`} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-semibold text-ink">{action.label}</span>
            {action.description ? <span className="block text-[10.5px] leading-snug text-dim">{action.description}</span> : null}
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
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const hasSendMenu = sendMenuActions.length > 0;
  const sendDisabled = !canSend && !hasSendMenu;

  return (
    <>
      <textarea
        ref={inputRef}
        value={displayText}
        rows={1}
        readOnly={Boolean(dictation.liveText)}
        onChange={(event) => setText(event.target.value)}
        /* Focusing the composer often precedes a dictation; minting the live
           token here hides its round-trip from the eventual mic press. */
        onFocus={prewarmLiveToken}
        onPaste={attachments.handlePaste}
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
        className="w-full resize-none overflow-y-auto rounded-[10px] border border-line bg-panel px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[#222] placeholder:text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
      />
      <div className="flex items-center justify-between gap-1.5">
        {leftSlot}
        <div className="flex shrink-0 items-center gap-1.5">
          <MicButtonView {...dictation} busy={voiceSending} onText={insertSpoken} />
          {showImage ? (
            <Hint label={imageAriaLabel}>
              <ImagePickerButton
                ariaLabel={imageAriaLabel}
                className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onFiles={attachments.addFiles}
              />
            </Hint>
          ) : null}
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
                aria-disabled={!canSend}
                aria-label={dictationRecording ? sendLabelRecording : sendLabelIdle}
                style={dictationRecording ? undefined : sendIdleStyle}
                className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border p-2 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 aria-disabled:opacity-40 ${
                  dictationRecording ? "border-err bg-err hover:opacity-90" : sendIdleClassName
                }`}
              >
                {busy || voiceSending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              </button>
            </Hint>
            {sendMenuOpen && hasSendMenu && sendMenuLabel ? (
              <SendMenu label={sendMenuLabel} actions={sendMenuActions} onClose={() => setSendMenuOpen(false)} />
            ) : null}
          </span>
        </div>
      </div>
      <ImagePreviewStrip images={attachments.images} onRemove={attachments.removeAt} />
      {status ? (
        <span className={`truncate text-[10.5px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>
          {status.text}
        </span>
      ) : null}
      {receipts ? <div className="flex flex-wrap gap-1.5">{receipts}</div> : null}
    </>
  );
}
