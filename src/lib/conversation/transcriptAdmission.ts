import fs from "node:fs";

import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import type { FileEntry } from "@/lib/types";

/**
 * Admission of a transcript the registry never inventoried (issue #935).
 *
 * The transcript-host bridge — `claude --resume <sessionId>` under a pane-less
 * structured host — can only own a conversation the registry holds an identity
 * for. Sessions born in a plain terminal, and sessions that aged past the
 * scan's recency cap before any inventory pass saw them, hold none, so the
 * bridge declined them and continuation fell through to a legacy tmux launch
 * that structured transport prohibits for Claude. Birth mode decided whether
 * continuation existed at all.
 *
 * Admission mints that identity from the transcript's own provenance —
 * account, cwd, model and effort as the scanner read them — so the bridge can
 * take it. It refuses only for reasons it can name.
 */
export type TranscriptAdmission =
  | { ok: true; conversationId: ViewerConversationId }
  /** `blocking` marks a refusal that must end the request: something else owns
      this session right now, so no other route may be tried either. A
      non-blocking refusal only means the bridge cannot take it — the legacy
      ladder still gets its turn. */
  | { ok: false; reason: string; blocking?: true };

export interface TranscriptAdmissionDependencies {
  readable?: (pathname: string) => boolean;
  resolveAccount?: typeof accountManager.resolveTranscriptOwner;
  now?: () => string;
}

function transcriptReadable(pathname: string): boolean {
  try {
    return fs.statSync(pathname).isFile();
  } catch {
    return false;
  }
}

/** A process outside the viewer is writing this transcript right now. Resuming
    would put a second agent on one session, so the refusal says so instead of
    forking the operator's live terminal out from under them. */
function foreignLiveOwner(registry: AgentRegistry, entry: FileEntry, key: { engine: "claude" | "codex"; sessionId: string }): boolean {
  if (entry.proc !== "running") return false;
  const hosted = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  return !hosted?.host && !hosted?.structuredHost;
}

export function admitTranscriptConversation(
  registry: AgentRegistry,
  entry: FileEntry,
  dependencies: TranscriptAdmissionDependencies = {},
): TranscriptAdmission {
  if (entry.engine !== "claude" && entry.engine !== "codex") {
    return { ok: false, reason: "this entry is not an agent conversation, so it has no session to continue" };
  }
  const engine = entry.engine;
  const key = sessionKeyFromTranscript(engine, entry.path);
  if (!key) return { ok: false, reason: `the transcript filename carries no ${engine === "claude" ? "Claude" : "Codex"} session id` };
  if (!(dependencies.readable ?? transcriptReadable)(entry.path)) {
    return { ok: false, reason: "the conversation transcript cannot be read from disk" };
  }
  if (foreignLiveOwner(registry, entry, { engine, sessionId: key.sessionId })) {
    return {
      ok: false,
      blocking: true,
      reason: "the session is still running in a terminal the viewer does not own; close it there, then continue from here",
    };
  }
  const owner = (dependencies.resolveAccount ?? accountManager.resolveTranscriptOwner)(engine, entry.path);
  const observedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  registry.reconcileConversations([{
    engine,
    path: entry.path,
    accountId: owner?.accountId ?? null,
    launchProfile: emptyLaunchProfile({
      cwd: entry.cwd || "",
      model: entry.launchModel ?? entry.model,
      effort: entry.effort ?? null,
      title: entry.title || null,
      project: entry.project || null,
    }),
    turn: { state: "unknown", source: "empty", terminalAt: null },
    observedAt,
  }]);
  const conversation = registry.conversationForPath(entry.path);
  if (!conversation) return { ok: false, reason: "the viewer could not record an identity for this conversation" };
  return { ok: true, conversationId: conversation.id };
}
