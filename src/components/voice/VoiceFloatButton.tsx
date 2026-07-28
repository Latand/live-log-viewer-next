"use client";

import { PictureInPicture2 } from "lucide-react";

import { Hint } from "@/components/Hint";
import type { TFunction } from "@/lib/i18n";
import type { CodexRealtimePhase } from "@/lib/realtime/codexRealtimeClient";

import { requestVoiceFloat } from "./floatRequest";
import { documentPictureInPictureSupported } from "./useDocumentPictureInPicture";

/**
 * The card's way back to the floating window (#691 §5).
 *
 * Deliberately not a dock/float toggle. U4 settles that the floater opens on every
 * voice start and remembers nothing, so there is no arrangement to toggle — there is
 * only the case where the operator closed the window and wants it again. Absent
 * outside a live call, and absent where Document PiP does not exist, because a control
 * that cannot work is worse than no control.
 */
export function VoiceFloatButton({ phase, t }: { phase: CodexRealtimePhase; t: TFunction }) {
  const live = phase === "connecting" || phase === "live";
  /* Read at render rather than in an effect: the API's presence is a property of the
     browser, not state that changes, and gating on an effect would flash the control
     in on every mount. */
  if (!live || !documentPictureInPictureSupported()) return null;
  return (
    <Hint label={t("voice.float")} align="right">
      <button
        type="button"
        data-testid="voice-float-button"
        aria-label={t("voice.float")}
        onClick={() => requestVoiceFloat()}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-border text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <PictureInPicture2 className="h-4 w-4" aria-hidden />
      </button>
    </Hint>
  );
}
