"use client";

import { useRuntimeEnabled, useRuntimeSession } from "@/hooks/useRuntime";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";

import { capabilitiesFor } from "../agentCapabilities";

/**
 * Whether the seat conversation's host is gone — the §4 capability matrix
 * (`../agentCapabilities`), read for a file the feed may not have delivered yet.
 *
 * `useAgentCapabilities` is the entry point wherever a PANE is mounted and needs
 * a `FileEntry`; the panel header has to state liveness before it has one, so it
 * reads the same pure matrix through the same runtime store. A designated
 * orchestrator is always a root conversation, so no root-host resolution (the
 * Claude-subagent case) applies here.
 */
export function useSeatHostDead(file: FileEntry | null): boolean {
  const runtimeEnabled = useRuntimeEnabled();
  const runtime = useRuntimeSession(file ? conversationIdentity(file) : null);
  if (!file) return false;
  return capabilitiesFor(file, runtime, { runtimeEnabled }).surface === "dead";
}
