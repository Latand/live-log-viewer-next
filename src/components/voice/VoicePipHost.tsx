"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { PictureInPicture2 } from "lucide-react";

import { VoiceConversationPanel } from "@/components/VoiceConversation";
import { useCallAmbience } from "@/hooks/useCodexRealtime";
import { useLocale } from "@/lib/i18n";
import {
  getActiveCall,
  getServerActiveCall,
  subscribeActiveCall,
} from "@/lib/realtime/activeCall";
import {
  codexRealtimeClient,
  type CodexRealtimeLine,
  type CodexRealtimePhase,
} from "@/lib/realtime/codexRealtimeClient";

import {
  getServerVoiceFloatRequest,
  getVoiceFloatRequest,
  subscribeVoiceFloatRequest,
} from "./floatRequest";
import { useDocumentPictureInPicture } from "./useDocumentPictureInPicture";
import {
  getServerVoiceSlot,
  getVoiceDockSlot,
  publishVoiceComposerSlot,
  subscribeVoiceSlots,
} from "./voiceSlots";

/**
 * The one home of the voice conversation panel (#691 §2.3, ownership inverted).
 *
 * Mounted at Viewer level, beside `AttentionHost`, because the conversation card
 * unmounts whenever the operator scrolls it away or opens another project — while
 * the call, a module-scoped singleton, keeps running. So the panel is rendered HERE,
 * exactly once, and portalled into whichever containment currently shows it:
 *
 * - docked: the slot node the card publishes above its composer (`voiceSlots`);
 * - floating: the Document Picture-in-Picture window this host owns.
 *
 * Floating and docking change containment only. There is no second panel, no second
 * composer, no mirrored state: the card's own `ComposerBar` follows the panel into
 * the PiP window through the composer slot this host publishes, so the floater has
 * dictation, images, paste, history, receipts and the send menu because it has THE
 * composer, not a copy of one.
 *
 * What this host owns: the PiP window's lifetime, the panel's placement, and the
 * call's ambient lease (which died mid-call while it was card-scoped). It still
 * holds no lines, no phase, no draft — those live in the one realtime client and
 * the card's composer, subscribed to like any other consumer.
 */

/**
 * The narrow slice of the realtime client this host consumes.
 *
 * Read-and-command only: subscribe, read, toggle, start, stop. There is no
 * constructor here and no way to make a transport, which is what keeps rule 1
 * ("one realtime client") a property of the type rather than of a review comment.
 */
export interface VoicePipClient {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => {
    phase: CodexRealtimePhase;
    lines: readonly CodexRealtimeLine[];
    error: string | null;
    startedAt: number | null;
    micMuted: boolean;
    outputMuted: boolean;
  };
  micStream: () => MediaStream | null;
  toggleMic: () => void;
  toggleOutput: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface VoicePipHostProps {
  /** Mobile has no Document PiP and stays chat-first (§7); the docked panel still
      renders through this host there. */
  mobile: boolean;
  /** Test seam. Production passes nothing. */
  resolveClient?: (conversationId: string) => VoicePipClient;
}

export function VoicePipHost({ mobile, resolveClient = codexRealtimeClient }: VoicePipHostProps) {
  const { t } = useLocale();
  const activeCall = useSyncExternalStore(subscribeActiveCall, getActiveCall, getServerActiveCall);
  const { supported, pipWindow, open, close } = useDocumentPictureInPicture();
  const conversationId = activeCall?.conversationId ?? null;

  /* Resolving through the same factory the card uses returns the SAME instance —
     the registry is module-scoped and keyed by conversation id. This is the single
     realtime client, reached a second time, never a second client. */
  const client = useMemo(
    () => (conversationId ? resolveClient(conversationId) : null),
    [conversationId, resolveClient],
  );

  const snapshot = useSyncExternalStore(
    client?.subscribe ?? NO_SUBSCRIBE,
    client?.getSnapshot ?? IDLE_SNAPSHOT,
    IDLE_SNAPSHOT,
  );

  /* The music's lease on the call, held by the owner that survives board
     navigation. A card-scoped lease died with its card and let the music back up
     mid-call (#691 known trap). */
  useCallAmbience(snapshot.phase === "live", snapshot.lines);

  /* DETACHING IS THE OPERATOR'S EXPLICIT GESTURE, never automatic (operator
     decision on stage): starting a voice call shows the transcript in the card,
     and only the float control opens the window. So there is no auto-open here —
     the ONLY way a window appears is the consumed float-request edge below, which
     carries the click's transient user activation `requestWindow` needs. */
  const phase = activeCall?.phase ?? "idle";
  const calling = phase === "connecting" || phase === "live";

  /* The call ending closes the window; the window closing does not end the call.
     `error` and `stopping` keep the floater up — the operator's next move on a failed
     call is Retry, and taking the window away would take the button with it. */
  useEffect(() => {
    if (phase !== "idle") return;
    if (pipWindow) close();
  }, [close, phase, pipWindow]);

  /* The card's float control — the way in, and the way back after a close. An edge
     consumed once, so a re-render cannot re-open a window the operator has just
     closed. */
  const floatRequest = useSyncExternalStore(
    subscribeVoiceFloatRequest,
    getVoiceFloatRequest,
    getServerVoiceFloatRequest,
  );
  const handledFloatRequest = useRef(floatRequest);
  useEffect(() => {
    if (floatRequest === handledFloatRequest.current) return;
    handledFloatRequest.current = floatRequest;
    if (mobile || !supported || !calling || pipWindow) return;
    void open();
  }, [calling, floatRequest, mobile, open, pipWindow, supported]);

  /* Where the panel docks while no window is open: the slot the card published. */
  const dockSlot = useSyncExternalStore(
    subscribeVoiceSlots,
    () => getVoiceDockSlot(conversationId),
    getServerVoiceSlot,
  );

  /* The composer slot this host offers the card while the window is open. Stable
     per conversation, so publish/retract runs on real changes rather than renders. */
  const composerSlotRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !conversationId) return undefined;
      return publishVoiceComposerSlot(conversationId, node);
    },
    [conversationId],
  );

  if (!client || !conversationId) return null;

  /* ONE panel element — the canonical rendering, with its canonical sizing and
     motion. Which document it lands in is the only thing that varies. */
  const panel = (
    <VoiceConversationPanel
      phase={snapshot.phase}
      lines={snapshot.lines}
      error={snapshot.error}
      startedAt={snapshot.startedAt}
      /* Read at render time from the one client: the stream is not duplicated,
         it is the same MediaStream object the call owns. */
      stream={client.micStream()}
      micMuted={snapshot.micMuted}
      outputMuted={snapshot.outputMuted}
      onToggleMic={() => client.toggleMic()}
      onToggleOutput={() => client.toggleOutput()}
      onRetry={() => void client.start()}
      t={t}
    />
  );

  if (pipWindow && !mobile) {
    /* The only PiP-only chrome: one dock button, rendered OUTSIDE the shared panel.
       Hang-up, mute, retry and the whole composer are the canonical controls,
       arriving through the panel and the card's portalled ComposerBar. */
    return createPortal(
      <div
        data-testid="voice-pip-chrome"
        className="flex h-full w-full flex-col gap-2 overflow-y-auto bg-canvas p-2 text-primary"
      >
        <header className="flex shrink-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-caption uppercase tracking-wide text-muted">
            {t("voice.floatSurface")}
          </span>
          <button
            type="button"
            data-testid="voice-float-dock"
            aria-label={t("voice.dock")}
            title={t("voice.dock")}
            onClick={close}
            className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-control border border-border px-1.5 text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <PictureInPicture2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 shrink-0">{panel}</div>
        {/* The card portals its ComposerBar here — the SAME composer, moved. */}
        <div
          data-testid="voice-pip-composer-slot"
          ref={composerSlotRef}
          className="flex shrink-0 flex-col gap-1.5"
        />
      </div>,
      pipWindow.document.body,
    );
  }

  return dockSlot ? createPortal(panel, dockSlot) : null;
}

/* Stable identities: `useSyncExternalStore` treats a fresh function or object per
   render as a store change, which would resubscribe and re-render forever. */
const NO_SUBSCRIBE = () => () => undefined;
const IDLE = {
  phase: "idle" as const,
  lines: [] as const,
  error: null,
  startedAt: null,
  micMuted: false,
  outputMuted: false,
};
const IDLE_SNAPSHOT = () => IDLE;
