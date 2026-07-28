"use client";

import { ImagePlus, PictureInPicture2, Send, X } from "lucide-react";

import { Square } from "@/components/icons";
import { VoiceConversationPanel } from "@/components/VoiceConversation";
import type { TFunction } from "@/lib/i18n";
import type { CodexRealtimeLine, CodexRealtimePhase } from "@/lib/realtime/codexRealtimeClient";

import type { SharedAttachment } from "./composerStore";

/**
 * The floating rendering of the voice conversation (#691 §5, §6).
 *
 * Presentation only, and that is a rule rather than a style preference. This subtree
 * renders inside the PiP document, which shares the opener's JS realm — so an effect
 * here would be a *second* copy of an effect the card already runs. Concretely:
 * nothing in this file may construct an `Audio`, call `getUserMedia`, open a peer
 * connection, mount the cue hooks, poll anything, or own the outbox dispatcher.
 * Every one of those lives once, in the opener. The floater renders pixels and emits
 * no sound.
 *
 * Everything it shows arrives as props from the one realtime client and the one
 * composer store, so "one source, two renderings" is enforced by this component
 * having no way to reach a source of its own.
 */

export interface VoiceFloatSurfaceProps {
  phase: CodexRealtimePhase;
  lines: readonly CodexRealtimeLine[];
  error: string | null;
  startedAt: number | null;
  stream: MediaStream | null;
  micMuted: boolean;
  outputMuted: boolean;
  onToggleMic: () => void;
  onToggleOutput: () => void;
  onRetry: () => void;
  onHangUp: () => void;
  /** Close the floater and keep the call: presentation change, nothing else. */
  onDock: () => void;
  draft: string;
  attachments: readonly SharedAttachment[];
  onDraftChange: (draft: string) => void;
  onRemoveAttachment: (id: string) => void;
  /** False when no card owns the tray: the tiles still show, their controls do not
      pretend to work. */
  canRemoveAttachments: boolean;
  onSend: () => void;
  sendDisabled: boolean;
  /** Derived from the measured window height, never from a mode toggle (§6). */
  compact: boolean;
  t: TFunction;
}

export function VoiceFloatSurface({
  phase,
  lines,
  error,
  startedAt,
  stream,
  micMuted,
  outputMuted,
  onToggleMic,
  onToggleOutput,
  onRetry,
  onHangUp,
  onDock,
  draft,
  attachments,
  onDraftChange,
  onRemoveAttachment,
  canRemoveAttachments,
  onSend,
  sendDisabled,
  compact,
  t,
}: VoiceFloatSurfaceProps) {
  const live = phase === "live" || phase === "connecting";
  return (
    <div
      data-testid="voice-float-surface"
      data-compact={compact ? "true" : "false"}
      /* §7: pointer targets stay reachable in a 380px window without forking the
         panel — the shared controls keep their markup and gain a 28px hit area
         here. `prefers-reduced-motion` flattens the pulse and the meter in the
         same way, by scoping the media query to this subtree rather than
         reimplementing the components without animation. */
      className="flex h-full w-full flex-col gap-2 bg-canvas p-2 text-primary [&_button]:min-h-7 [&_button]:min-w-7 motion-reduce:[&_.animate-pulse]:animate-none motion-reduce:[&_.transition-\\[height\\]]:transition-none"
    >
      <header className="flex shrink-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-caption uppercase tracking-wide text-muted">
          {t("voice.floatSurface")}
        </span>
        {live ? (
          <button
            type="button"
            data-testid="voice-float-hangup"
            aria-label={t("voice.stop")}
            title={t("voice.stop")}
            onClick={onHangUp}
            className="inline-flex items-center justify-center rounded-control border border-danger/60 bg-danger/10 px-1.5 text-danger hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          data-testid="voice-float-dock"
          aria-label={t("voice.dock")}
          title={t("voice.dock")}
          onClick={onDock}
          className="inline-flex items-center justify-center rounded-control border border-border px-1.5 text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <PictureInPicture2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>

      {/* Reused verbatim, which is the point: the transcript's `aria-live`, the
          status `role`, the error `role="alert"`, the `aria-pressed` toggles and the
          visible focus rings are all already correct there, and a second copy of
          this markup would be a second place for them to rot. */}
      <div className="min-h-0 flex-1 overflow-hidden [&>section]:h-full [&_[aria-live]]:max-h-none">
        <VoiceConversationPanel
          phase={phase}
          lines={lines}
          error={error}
          startedAt={startedAt}
          stream={stream}
          micMuted={micMuted}
          outputMuted={outputMuted}
          onToggleMic={onToggleMic}
          onToggleOutput={onToggleOutput}
          onRetry={onRetry}
          t={t}
        />
      </div>

      {attachments.length > 0 ? (
        <ul data-testid="voice-float-attachments" className="shrink-0 space-y-1">
          {attachments.map((attachment, index) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-control border border-border bg-raised/70 px-1.5 py-1"
            >
              {attachment.preview ? (
                /* A staged object-URL thumbnail the opener already holds. `next/image`
                   cannot help here: there is no route for the optimizer to fetch, and
                   the blob lives in the opener's document. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={attachment.preview} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
              ) : (
                <ImagePlus className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-caption text-secondary">{attachment.name}</span>
              {attachment.status === "error" ? (
                <span className="shrink-0 text-caption text-danger" role="alert">{attachment.error}</span>
              ) : null}
              <button
                type="button"
                aria-label={t("img.removeAria", { n: index + 1 })}
                title={t("img.removeAria", { n: index + 1 })}
                disabled={!canRemoveAttachments}
                onClick={() => onRemoveAttachment(attachment.id)}
                className="inline-flex items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* One draft, one queue, one dispatcher: this writes the shared store and asks
          the opener to send. There is no PiP-specific send route, so a race between
          this button and the card's produces one delivery. */}
      <form
        className="flex shrink-0 items-end gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!sendDisabled) onSend();
        }}
      >
        <textarea
          data-testid="voice-float-input"
          aria-label={t("voice.floatMessage")}
          placeholder={t("voice.floatMessage")}
          value={draft}
          rows={compact ? 1 : 3}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!sendDisabled) onSend();
            }
          }}
          className="min-w-0 flex-1 resize-none rounded-control border border-border bg-raised px-2 py-1.5 text-label text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        <button
          type="submit"
          data-testid="voice-float-send"
          aria-label={t("common.send")}
          title={t("common.send")}
          disabled={sendDisabled}
          className="inline-flex items-center justify-center rounded-control border border-accent/40 bg-accent-soft px-2 py-1.5 text-accent hover:bg-accent/15 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Send className="h-3.5 w-3.5" aria-hidden />
        </button>
      </form>
    </div>
  );
}
