"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { setVoiceConnected } from "@/lib/audio/app";
import { codexRealtimeClient } from "@/lib/realtime/codexRealtimeClient";

const IDLE = { phase: "idle" as const, lines: [], error: null, startedAt: null, micMuted: false, outputMuted: false };

export function useCodexRealtime(
  conversationId: string,
  enabled: boolean,
  workerTurnId: string,
  workerProgress: string,
  workerRunning: boolean,
) {
  const ambientOwner = useRef(Symbol("realtime-ambient-owner"));
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
    if (workerRunning) client.queueWorkerProgress(workerTurnId, workerProgress);
    else client.finishWorkerProgress(workerTurnId, workerProgress);
  }, [client, snapshot.phase, workerProgress, workerRunning, workerTurnId]);

  /* The ambient bed is eligible only while a call is up, and it fades on both
     edges. `live` is the only phase with two participants who can talk;
     connecting, stopping and error are not a call. */
  const live = snapshot.phase === "live";
  useEffect(() => {
    const owner = ambientOwner.current;
    setVoiceConnected(owner, live);
    return () => setVoiceConnected(owner, false);
  }, [live]);

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
