"use client";

import { PictureInPicture2 } from "lucide-react";

import { Hint } from "@/components/Hint";
import type { TFunction } from "@/lib/i18n";
import type { CodexRealtimePhase } from "@/lib/realtime/codexRealtimeClient";

import { requestVoiceFloat } from "./floatRequest";
import { documentPictureInPictureSupported } from "./useDocumentPictureInPicture";

/**
 * The card's way INTO the floating window, and back after a close (#691 §5,
 * revised on stage).
 *
 * Detaching is the operator's explicit gesture: starting a voice call shows the
 * transcript in the card, and pressing this is what floats it — nothing opens a
 * window automatically. Deliberately not a dock/float toggle: the window's own
 * dock button closes it, so the only case here is "float it (again)". Absent
 * outside a live call, and absent where Document PiP does not exist, because a
 * control that cannot work is worse than no control.
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
