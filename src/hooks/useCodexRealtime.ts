"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { codexRealtimeClient } from "@/lib/realtime/codexRealtimeClient";

const IDLE = { phase: "idle" as const, lines: [], error: null };

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

  return {
    ...snapshot,
    start: () => client?.start() ?? Promise.resolve(),
    stop: () => client?.stop() ?? Promise.resolve(),
  };
}
