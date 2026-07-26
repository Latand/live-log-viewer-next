"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { ambientLoop, setVoiceConnected } from "@/lib/audio/app";
import { speakingFromLines } from "@/lib/audio/speech";
import { codexRealtimeClient } from "@/lib/realtime/codexRealtimeClient";

const IDLE = { phase: "idle" as const, lines: [], error: null, startedAt: null, micMuted: false, outputMuted: false };

export function useCodexRealtime(
  conversationId: string,
  enabled: boolean,
  workerProgress: string,
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
  const previousProgress = useRef("");

  useEffect(() => {
    if (!client) {
      previousProgress.current = "";
      return;
    }
    if (workerProgress) {
      previousProgress.current = workerProgress;
      client.queueWorkerProgress(workerProgress);
      return;
    }
    if (previousProgress.current) {
      client.finishWorkerProgress(previousProgress.current);
      previousProgress.current = "";
    }
  }, [client, snapshot.phase, workerProgress]);

  /* The ambient bed is eligible only while a call is up, and it fades on both
     edges. `live` is the only phase with two participants who can talk;
     connecting, stopping and error are not a call. */
  const live = snapshot.phase === "live";
  useEffect(() => {
    setVoiceConnected(live);
    return () => setVoiceConnected(false);
  }, [live]);

  /* Ducking reads the transcript the call already produces — no analyser on
     either stream, no second signal path to keep in step with this one. */
  const speaking = live ? speakingFromLines(snapshot.lines) : null;
  useEffect(() => {
    ambientLoop().setSpeaking(speaking);
  }, [speaking]);

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
