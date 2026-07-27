"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { useBridgeReportRelay } from "@/hooks/useBridgeReportRelay";
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
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";

import { composerStore } from "./composerStore";
import {
  getServerVoiceFloatRequest,
  getVoiceFloatRequest,
  subscribeVoiceFloatRequest,
} from "./floatRequest";
import { useDocumentPictureInPicture } from "./useDocumentPictureInPicture";
import { VoiceFloatSurface } from "./VoiceFloatSurface";

/**
 * Where the floating voice rendering is mounted (#691 §2.3).
 *
 * At Viewer level, beside `AttentionHost`, and that placement is the whole reason
 * this component exists. The voice surface used to live only inside `TmuxComposer`,
 * which unmounts when the card scrolls out of view or the operator opens another
 * project — while the call, a module-scoped singleton, keeps running. A floater
 * mounted there would die on board navigation with the call still up (AC13).
 *
 * What it owns: the PiP window's lifetime, and nothing else. It holds no lines, no
 * phase, no draft, no session. It resolves the conversation that currently has a
 * call from the client registry, resolves that conversation's one realtime client
 * and one composer store, and subscribes to both like any other consumer. If the OS
 * kills the window, there is nothing here to recover — which is the invariant the
 * design asks for: the PiP window adds zero domain state.
 *
 * What it deliberately does NOT own (§4 rules 1–5): the outbox dispatcher, the cue
 * hooks, the ambient bed, the worker-delivery reconciliation, or any polling. All of
 * those mount exactly once, in the card's tree. This host and the surface it portals
 * are presentation.
 */

/** Below this measured window height the surface renders compact (§6). No mode
    toggle: the operator resizing the window is the only input. */
const COMPACT_HEIGHT = 460;

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
  /* The relay's two seams. Held here because this host owns the live report loop:
     the card that used to own it unmounts on board navigation while the call keeps
     running, so a card-scoped relay stopped delivering mid-call. */
  reconcileWorkerDeliveries: (deliveries: readonly RuntimeVoiceDelivery[]) => void;
  onDeliveryAcknowledged: (listener: (deliveryId: string) => void) => () => void;
}

export interface VoicePipHostProps {
  /** Mobile has no Document PiP and stays chat-first (§7). */
  mobile: boolean;
  /**
   * Test seam only. Production leaves this unset and the floater delivers through
   * the sender the card registered on the shared store — §4 rule 5, one send path.
   */
  onSend?: (conversationId: string, draft: string, sendKey: string) => void;
  /** Test seam. Production passes none of these. */
  resolveClient?: (conversationId: string) => VoicePipClient;
}

export function VoicePipHost({ mobile, onSend, resolveClient = codexRealtimeClient }: VoicePipHostProps) {
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
  const store = useMemo(
    () => (conversationId ? composerStore(conversationId) : null),
    [conversationId],
  );

  const snapshot = useSyncExternalStore(
    client?.subscribe ?? NO_SUBSCRIBE,
    client?.getSnapshot ?? IDLE_SNAPSHOT,
    IDLE_SNAPSHOT,
  );
  const composer = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIBE,
    store?.getSnapshot ?? EMPTY_COMPOSER,
    EMPTY_COMPOSER,
  );

  /* U4: the floater opens on every voice start, remembers nothing, and there is no
     preference to consult. `requestWindow` needs transient user activation, which
     the operator's press of the call button provides — the phase reaches
     `connecting` synchronously inside `start()`, so this effect still runs inside
     that activation. When it has lapsed anyway, `requestWindow` rejects and the hook
     leaves the call docked, which is the documented fallback rather than an error.

     The decision reads the registry's phase rather than the client snapshot, because
     the registry is what this host subscribed to in order to find the conversation
     at all. Two reads of the same phase through two paths could disagree for a
     render, and the disagreement would be a window that opens for a call that
     already ended. */
  const phase = activeCall?.phase ?? "idle";
  const calling = phase === "connecting" || phase === "live";

  /* Once per call, not once per render with a call up. Without this latch, closing the
     floater mid-call would satisfy "a call is up and no window is open" on the very
     next render and put the window straight back — the close button would appear
     broken, and the two effects would trade turns forever. Re-floating is a separate,
     explicit gesture (below). */
  const autoOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (mobile || !supported) return;
    if (!calling || pipWindow) return;
    if (autoOpenedFor.current === conversationId) return;
    autoOpenedFor.current = conversationId;
    void open();
  }, [calling, conversationId, mobile, open, pipWindow, supported]);

  /* The call ending closes the window; the window closing does not end the call.
     `error` and `stopping` keep the floater up — the operator's next move on a failed
     call is Retry, and taking the window away would take the button with it. */
  useEffect(() => {
    if (phase !== "idle") return;
    /* Armed again for the next call, whichever conversation it belongs to. */
    autoOpenedFor.current = null;
    if (pipWindow) close();
  }, [close, phase, pipWindow]);

  /* The card's float control. An edge consumed once, so a re-render cannot re-open a
     window the operator has just closed. */
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

  /* #691 §4 — the live report relay lives HERE, not in the card.
     The card unmounts when the operator scrolls it out of view or opens another
     project, while the call — a module-scoped singleton — keeps running; a relay
     scoped to the card therefore stopped delivering mid-call, silently. This host is
     mounted once at Viewer level for exactly that reason, so it is also the right
     owner for the one polling loop. It stays out of the portal: this component runs
     in the opener, and only `VoiceFloatSurface` is portalled. */
  useBridgeReportRelay(client, phase === "live");

  const compact = useMeasuredCompact(pipWindow);

  const sendKey = store?.sendKey() ?? null;
  const handleSend = useCallback(() => {
    if (!store || !conversationId) return;
    const key = store.sendKey();
    if (!key) return;
    if (onSend) {
      onSend(conversationId, store.getSnapshot().draft, key);
      return;
    }
    /* The card's own queue-first submit, borrowed rather than duplicated. A send
       from this window and a send from the card are the same call. */
    store.send();
  }, [conversationId, onSend, store]);

  if (mobile || !pipWindow || !client || !store) return null;

  return createPortal(
    <VoiceFloatSurface
      phase={snapshot.phase}
      lines={snapshot.lines}
      error={snapshot.error}
      startedAt={snapshot.startedAt}
      /* Read at render time from the one client, exactly as the card does: the
         stream is not duplicated, it is the same MediaStream object. */
      stream={client.micStream()}
      micMuted={snapshot.micMuted}
      outputMuted={snapshot.outputMuted}
      onToggleMic={() => client.toggleMic()}
      onToggleOutput={() => client.toggleOutput()}
      onRetry={() => void client.start()}
      onHangUp={() => void client.stop()}
      onDock={close}
      draft={composer.draft}
      attachments={composer.attachments}
      onDraftChange={(draft) => store.setDraft(draft)}
      /* Through the card's tray, which owns the File and the object URL. Filtering
         the shared list here would hide a tile the card still holds. */
      onRemoveAttachment={(id) => store.removeAttachment(id)}
      onSend={handleSend}
      /* Honest about a card that went away: the floater keeps the draft and the
         transcript, and says the send path is gone rather than swallowing a press.
         An explicit `onSend` is itself a path, so it satisfies the same check. */
      sendDisabled={sendKey === null || !(onSend || composer.canSend)}
      compact={compact}
      t={t}
    />,
    pipWindow.document.body,
  );
}

/** Compact vs expanded follows the window the operator sized (§6). Measured rather
    than toggled, so there is no arrangement state to remember or restore. */
function useMeasuredCompact(pipWindow: Window | null): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!pipWindow) return;
    const measure = () => setCompact(pipWindow.innerHeight < COMPACT_HEIGHT);
    measure();
    pipWindow.addEventListener("resize", measure);
    return () => pipWindow.removeEventListener("resize", measure);
  }, [pipWindow]);
  return compact;
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
const EMPTY = { draft: "", attachments: [] as const, canSend: false };
const EMPTY_COMPOSER = () => EMPTY;
