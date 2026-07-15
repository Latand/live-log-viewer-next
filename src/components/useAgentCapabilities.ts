"use client";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useRuntime, useRuntimeSession, useRuntimeSessionByArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";

import {
  attachModeFor,
  capabilitiesFor,
  rootHostFrom,
  type AttachMode,
  type HostOptions,
  type StripCapabilities,
} from "./agentCapabilities";

/** A currently-alive structured (pane-less) host view, else null. Honors the
    LLV_STRUCTURED_HOSTS rollback gate: with the flag off every conversation —
    including one with structured registry state — must take the legacy path. */
function structuredSessionOf(rv: RuntimeSessionView | null): RuntimeSessionView | null {
  if (!rv?.structuredControlsEnabled || rv.legacy) return null;
  return rv.session.hostKind === "codex-app-server" || rv.session.hostKind === "claude-broker" ? rv : null;
}

export interface AgentCapabilities {
  caps: StripCapabilities;
  /** The conversation's own runtime session view (null when the bus doesn't
      carry it or the plane is off). */
  runtime: RuntimeSessionView | null;
  /** The structured session Stop/Send must route through, or null for the legacy
      tmux path: the conversation's own structured host, or — for a structured-root
      subagent — its ROOT's structured host (so a claude-broker root's child never
      hits /api/tmux or /api/proc, issue #241 finding 1). */
  structuredSession: RuntimeSessionView | null;
  /** Whether the runtime plane is the authority for host capability. */
  runtimeEnabled: boolean;
  attachMode: AttachMode;
}

/**
 * The single client entry point for the §4 capability matrix. It resolves the
 * inputs the pure matrix needs beyond the FileEntry: whether the runtime plane
 * is authoritative (so an unresolved host fails safe instead of falling back to
 * `file.proc`, finding 1), and — for a Claude subagent whose own proc/pid the
 * scanner leaves null — its canonical root host's liveness *and kind* (finding
 * 2). Structured-root children route their controls through the root's
 * structured session; legacy-root children keep canonical tmux routing. Every
 * strip/header/composer consumer reads through here so the matrix resolves
 * identically wherever a pane is mounted.
 */
export function useAgentCapabilities(file: FileEntry): AgentCapabilities {
  const { enabled } = useRuntime();
  const cardId = conversationIdentity(file);
  const runtime = useRuntimeSession(cardId);
  // A Claude subagent relays through its root; resolve the root host from the
  // runtime store by matching the root transcript path (the child's `parent`).
  const isClaudeSubagent = file.root === "claude-projects" && file.kind === "subagent";
  const rootView = useRuntimeSessionByArtifact(isClaudeSubagent ? file.parent : null);
  // Root host only matters when the runtime plane is authoritative. With the
  // plane off (pure-legacy mode) there is no store to read, so `file.proc` drives
  // subagent classification exactly as before.
  const opts: HostOptions = {
    runtimeEnabled: enabled,
    ...(enabled && isClaudeSubagent ? { root: rootHostFrom(rootView) } : {}),
  };
  const caps = capabilitiesFor(file, runtime, opts);
  const structuredSession = structuredSessionOf(runtime)
    ?? (caps.surface === "structured-subagent" ? rootView : null);
  return { caps, runtime, structuredSession, runtimeEnabled: enabled, attachMode: attachModeFor(file, runtime, opts) };
}
