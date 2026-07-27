"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { setVoiceConnected } from "@/lib/audio/app";
import { codexRealtimeClient } from "@/lib/realtime/codexRealtimeClient";
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";

const IDLE = { phase: "idle" as const, lines: [], error: null, startedAt: null, micMuted: false, outputMuted: false };

/**
 * One mounted realtime surface's lease on "a call is up".
 *
 * The lease is per MOUNT, not per conversation: several conversation cards can
 * have composers mounted at once, and the operator switches between them
 * constantly. Each mount releases only its own lease, so a switch that mounts
 * the next card before unmounting the last one never lets the count reach zero
 * — which is what keeps the background music from restarting, duplicating or
 * dropping when the selected card changes.
 *
 * What the music then DOES with that signal is the audio module's business: with
 * music enabled on both sides of the call boundary this hook's edges change
 * nothing audible at all.
 */
export function useAmbientCallLease(live: boolean): void {
  const owner = useRef(Symbol("realtime-ambient-owner"));
  useEffect(() => {
    const held = owner.current;
    setVoiceConnected(held, live);
    return () => setVoiceConnected(held, false);
  }, [live]);
}

export function useCodexRealtime(
  conversationId: string,
  enabled: boolean,
  workerTurnId: string,
  workerProgress: string,
  workerRunning: boolean,
  workerDeliveries: readonly RuntimeVoiceDelivery[],
) {
  const client = useMemo(
    () => enabled && conversationId.startsWith("conversation_") ? codexRealtimeClient(conversationId) : null,
    [conversationId, enabled],
  );
  const snapshot = useSyncExternalStore(
    client?.subscribe ?? (() => () => undefined),
    client?.getSnapshot ?? (() => IDLE),
    () => IDLE,
  );
  useEffect(() => {
    if (!client || !workerTurnId || !workerProgress) return;
    client.updateWorkerProgress(workerTurnId, workerProgress, workerRunning);
  }, [client, snapshot.phase, workerProgress, workerRunning, workerTurnId]);
  useEffect(() => {
    client?.reconcileWorkerDeliveries(workerDeliveries);
  }, [client, snapshot.phase, workerDeliveries]);

  /* Which side of the call boundary the background music is on. `live` is the
     only phase with two participants who can talk; connecting, stopping and
     error are not a call. */
  useAmbientCallLease(snapshot.phase === "live");

  return {
    ...snapshot,
    /* Read at render time rather than stored: the stream appears with the
       `live` phase, which already re-renders this subtree. */
    micStream: client?.micStream() ?? null,
    toggleMic: () => client?.toggleMic(),
    toggleOutput: () => client?.toggleOutput(),
    start: () => client?.start() ?? Promise.resolve(),
    stop: () => client?.stop() ?? Promise.resolve(),
  };
}
