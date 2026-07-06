"use client";

import { Loader2, Play } from "@/components/icons";
import type { UseComposerReturn } from "@/hooks/useComposer";
import { prewarmLiveToken } from "@/hooks/useDictation";

import { Hint } from "./Hint";
import { ImagePickerButton, ImagePreviewStrip } from "./imageAttachments";
import { MicButtonView } from "./MicButton";

export interface ComposerBarProps {
  composer: UseComposerReturn;
  placeholder: string;
  textareaAriaLabel: string;
  imageAriaLabel: string;
  /** The left side of the bottom row: the mode/target chip and any adjacent
      controls (interrupt/compact on a live pane, a plain label on a draft). */
  leftSlot: React.ReactNode;
  /** Send-button accessible label, one for each dictation state. */
  sendLabelIdle: string;
  sendLabelRecording: string;
  /** Tooltip while recording (the pane composer explains stop-and-send). */
  sendTitleRecording?: string;
  /** Idle-state send-button appearance: the pane composer paints itself with
      the accent classes, the draft with an inline engine tint. */
  sendIdleClassName: string;
  sendIdleStyle?: React.CSSProperties;
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
          <Hint label={imageAriaLabel}>
            <ImagePickerButton
              ariaLabel={imageAriaLabel}
              className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onFiles={attachments.addFiles}
            />
          </Hint>
          <Hint label={dictationRecording ? (sendTitleRecording ?? sendLabelRecording) : sendLabelIdle}>
            <button
              type={dictationRecording ? "button" : "submit"}
              onClick={dictationRecording ? () => void stopAndSend() : undefined}
              disabled={!canSend}
              aria-label={dictationRecording ? sendLabelRecording : sendLabelIdle}
              style={dictationRecording ? undefined : sendIdleStyle}
              className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border p-2 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 ${
                dictationRecording ? "border-err bg-err hover:opacity-90" : sendIdleClassName
              }`}
            >
              {busy || voiceSending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
            </button>
          </Hint>
        </div>
      </div>
      <ImagePreviewStrip images={attachments.images} onRemove={attachments.removeAt} />
      {status ? (
        <span className={`truncate text-[10.5px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>
          {status.text}
        </span>
      ) : null}
    </>
  );
}
