"use client";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useRuntime, useRuntimeSession, useRuntimeSessionByArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";

import {
  attachModeFor,
  capabilitiesFor,
  rootLivenessFrom,
  type AttachMode,
  type HostOptions,
  type StripCapabilities,
} from "./agentCapabilities";

export interface AgentCapabilities {
  caps: StripCapabilities;
  /** The conversation's own runtime session view (null when the bus doesn't
      carry it or the plane is off). */
  runtime: RuntimeSessionView | null;
  /** Whether the runtime plane is the authority for host capability. */
  runtimeEnabled: boolean;
  attachMode: AttachMode;
}

/**
 * The single client entry point for the §4 capability matrix. It resolves the
 * two inputs the pure matrix needs beyond the FileEntry: whether the runtime
 * plane is authoritative (so an unresolved host fails safe instead of falling
 * back to `file.proc`, issue #241 finding 1), and — for a Claude subagent whose
 * own proc/pid the scanner leaves null — its canonical root host's liveness
 * (issue #241 finding 2). Every strip/header/composer consumer reads through
 * here so the matrix is resolved identically wherever a pane is mounted.
 */
export function useAgentCapabilities(file: FileEntry): AgentCapabilities {
  const { enabled } = useRuntime();
  const cardId = conversationIdentity(file);
  const runtime = useRuntimeSession(cardId);
  // A Claude subagent relays through its root; resolve the root host from the
  // runtime store by matching the root transcript path (the child's `parent`).
  const isClaudeSubagent = file.root === "claude-projects" && file.kind === "subagent";
  const rootView = useRuntimeSessionByArtifact(isClaudeSubagent ? file.parent : null);
  // Root liveness only matters when the runtime plane is authoritative. With the
  // plane off (pure-legacy mode) there is no store to read, so `file.proc` drives
  // subagent classification exactly as before — never a spurious "unknown" root.
  const opts: HostOptions = {
    runtimeEnabled: enabled,
    ...(enabled && isClaudeSubagent ? { root: rootLivenessFrom(rootView ? rootView.session : null) } : {}),
  };
  return {
    caps: capabilitiesFor(file, runtime, opts),
    runtime,
    runtimeEnabled: enabled,
    attachMode: attachModeFor(file, runtime, opts),
  };
}
