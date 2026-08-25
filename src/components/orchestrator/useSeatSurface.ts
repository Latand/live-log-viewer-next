"use client";

import { useRuntimeEnabled, useRuntimeSession } from "@/hooks/useRuntime";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";

import { surfaceFor, type StripSurface } from "../agentCapabilities";

/**
 * The seat conversation's capability surface — the §4 matrix
 * (`../agentCapabilities`), read for a file the feed may not have delivered yet.
 *
 * `useAgentCapabilities` is the entry point wherever a PANE is mounted and needs
 * the whole control matrix; the panel header only has to say what the operator
 * can do with the conversation, so it reads the same pure classifier through the
 * same runtime store. A designated orchestrator is always a root conversation,
 * so no root-host resolution (the Claude-subagent case) applies here.
 */
export function useSeatSurface(file: FileEntry | null): StripSurface | null {
  const runtimeEnabled = useRuntimeEnabled();
  const runtime = useRuntimeSession(file ? conversationIdentity(file) : null);
  if (!file) return null;
  return surfaceFor(file, runtime, { runtimeEnabled });
}
