import fs from "node:fs";

import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { headCwd } from "@/lib/agent/transcript";
import { isUnderClaudeSubagentsDir } from "@/lib/scanner/claudeNative";
import { transcriptLiveOwnership, type TranscriptLiveOwnership } from "@/lib/scanner/transcripts";
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
  /** Injectable so the focused tests decide liveness without touching real
      processes. Production passes the uncapped destructive-operation probe,
      classified by the evidence behind the match. */
  liveOwnership?: (entry: FileEntry) => TranscriptLiveOwnership | null;
  /** The transcript's own head, read only when the scanner recorded no cwd. */
  headCwd?: (pathname: string) => string | null;
  now?: () => string;
}

function transcriptReadable(pathname: string): boolean {
  try {
    return fs.statSync(pathname).isFile();
  } catch {
    return false;
  }
}

/** The same head sniff the scanner's inventory and the legacy resume path use
    when `entry.cwd` is absent: without it the bridge spawns the host in an
    undefined directory and the resumed agent's tools run outside the repo. */
function admissionHeadCwd(pathname: string): string | null {
  return headCwd(pathname, { maxLines: 40 });
}

/**
 * A process outside the viewer may be writing this transcript right now.
 * Resuming would put a second agent on one session, so the refusal says so
 * instead of forking the operator's live terminal out from under them.
 *
 * Liveness cannot rest on `entry.proc` alone. That field is the scanner's
 * best-effort UI attribution and it is documented to leave a live owner unset
 * for exactly this population: the cwd-fallback pool excludes `idle` entries,
 * the fd-holder scan is capped by recency, and a plain `claude` typed in a
 * shell carries no session id in its argv. Admitting a session into structured
 * hosting is at least as destructive as deleting its file, so it asks the same
 * uncapped probe every other destructive route asks — but it reads the
 * evidence class, because unlike a delete it must also decide whether the whole
 * request ends here.
 *
 * `entry.proc === "running"` is session evidence: the scanner attributes that
 * pid to this one transcript, and at most one entry per project ever gets it.
 * The raw cwd-slug fallback is not — one plain `claude` in a repo matches every
 * transcript of that repo — so it suppresses admission without ending the
 * request.
 */
function foreignLiveOwnership(
  registry: AgentRegistry,
  entry: FileEntry,
  key: { engine: "claude" | "codex"; sessionId: string },
  probe: (entry: FileEntry) => TranscriptLiveOwnership | null,
): TranscriptLiveOwnership | null {
  const evidence = entry.proc === "running" ? "session" : probe(entry);
  if (!evidence) return null;
  const hosted = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  return hosted?.host || hosted?.structuredHost ? null : evidence;
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
  /* Admission runs before eligibility, so a shape eligibility refuses by name
     must be refused here too or that refusal is unreachable: a delegated leaf
     would mint a root identity and pay for a `claude --resume` host for a
     session it does not have. One grammar answers for both gates. */
  if (engine === "claude" && isUnderClaudeSubagentsDir(entry.path)) {
    return { ok: false, reason: "a Claude subagent transcript has no session of its own to resume" };
  }
  const key = sessionKeyFromTranscript(engine, entry.path);
  if (!key) return { ok: false, reason: `the transcript filename carries no ${engine === "claude" ? "Claude" : "Codex"} session id` };
  if (!(dependencies.readable ?? transcriptReadable)(entry.path)) {
    return { ok: false, reason: "the conversation transcript cannot be read from disk" };
  }
  const live = foreignLiveOwnership(registry, entry, { engine, sessionId: key.sessionId }, dependencies.liveOwnership ?? transcriptLiveOwnership);
  if (live === "session") {
    return {
      ok: false,
      blocking: true,
      reason: "the session is still running in a terminal the viewer does not own; close it there, then continue from here",
    };
  }
  if (live === "cwd") {
    /* Not blocking: the evidence is a live agent in this conversation's working
       directory, which may be any other session of that repo. Minting an
       identity and buying a host on that would risk a second agent on one
       session, so admission declines — but the request keeps its turn on the
       legacy ladder instead of ending on a refusal naming a terminal the
       operator is not holding. */
    return {
      ok: false,
      reason: `another ${engine === "claude" ? "Claude" : "Codex"} process is running in this conversation's working directory, so the viewer cannot tell whether this session is still open there`,
    };
  }
  const owner = (dependencies.resolveAccount ?? accountManager.resolveTranscriptOwner)(engine, entry.path);
  const observedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  registry.reconcileConversations([{
    engine,
    path: entry.path,
    accountId: owner?.accountId ?? null,
    launchProfile: emptyLaunchProfile({
      cwd: entry.cwd || (dependencies.headCwd ?? admissionHeadCwd)(entry.path) || "",
      model: entry.launchModel ?? entry.model,
      effort: entry.effort ?? null,
      title: entry.title || null,
      project: entry.project || null,
    }),
    turn: { state: "unknown", source: "empty", terminalAt: null },
    /* The same lineage edge the scanner's inventory supplies (issue #339):
       without it an admitted child carries no parent and surfaces as its own
       root card. */
    parentArtifactPath: entry.parent,
    observedAt,
  }]);
  const conversation = registry.conversationForPath(entry.path);
  if (!conversation) return { ok: false, reason: "the viewer could not record an identity for this conversation" };
  return { ok: true, conversationId: conversation.id };
}
