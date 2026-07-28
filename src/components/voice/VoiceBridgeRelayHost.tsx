"use client";

import { useMemo, useSyncExternalStore } from "react";

import { useBridgeReportRelay, type BridgeRelayClient } from "@/hooks/useBridgeReportRelay";
import {
  getActiveCall,
  getServerActiveCall,
  subscribeActiveCall,
} from "@/lib/realtime/activeCall";
import { codexRealtimeClient } from "@/lib/realtime/codexRealtimeClient";

/**
 * The live report relay's one mount (#691 §4).
 *
 * The relay used to ride along inside `VoicePipHost`, which conflated two
 * lifetimes: the polling loop that feeds manager reports into the live call, and
 * the window that happens to show the call. They end for different reasons — the
 * loop with the call, the window with a click — so the loop gets its own
 * Viewer-level mount. Renders nothing, ever; polls only while a call is live.
 */
export function VoiceBridgeRelayHost({
  resolveClient = codexRealtimeClient,
}: {
  /** Test seam. Production passes nothing. */
  resolveClient?: (conversationId: string) => BridgeRelayClient;
}) {
  const activeCall = useSyncExternalStore(subscribeActiveCall, getActiveCall, getServerActiveCall);
  const conversationId = activeCall?.conversationId ?? null;
  /* The same module-scoped registry the card and the PiP host resolve through:
     one conversation id, one client, however many consumers. */
  const client = useMemo(
    () => (conversationId ? resolveClient(conversationId) : null),
    [conversationId, resolveClient],
  );
  useBridgeReportRelay(client, activeCall?.phase === "live");
  return null;
}
