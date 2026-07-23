/**
 * Pure composition of the "attach in your terminal" command (issue #247 item 2).
 *
 * Every datum needed already sits in the registry / account manager — the
 * account home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), the cwd, and the resumable
 * session id — so the command is composed synchronously with *no spawning and
 * no waiting*. The dialog opens instantly; the user pastes the string into their
 * own terminal to take the conversation over with the correct account env.
 *
 * The command itself is exactly the `resumeSpecFor` boot string (same env
 * prefix, flags, and `--resume <sid>` / `codex … resume <id>`), so a manual
 * attach reopens the identical conversation the viewer would have resumed.
 */

import type { AgentEngine, ResumeSpec } from "./cli";
import type { FileEntry } from "@/lib/types";

/** Shell-quote a value for the one-line `cd '<cwd>' && …` copy. Kept local so
    this module stays free of the node-only bits of `cli.ts`. */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export interface AttachCommand {
  engine: AgentEngine;
  accountId: string;
  accountLabel: string;
  cwd: string;
  /** The resume/attach command with its account env prefix and flags. */
  command: string;
  /** Shell-quoted `cd '<cwd>'` for the "Copy working directory" row, so a path
      with spaces or apostrophes pastes correctly (finding 5). */
  cdCommand: string;
  /** One-liner for "Copy full command": `cd '<cwd>' && <command>`. */
  fullCommand: string;
  /** Claude subagents resume through their root session — the dialog says so. */
  note?: "subagent-root";
}

/** Build the {@link AttachCommand} from an already-resolved resume spec. Pure.
    `cwd` overrides the spec's own working directory: the resume spec re-derives
    it by sniffing the transcript head and silently falls back to `$HOME` when
    that read comes up empty, which is exactly the wrong-path command #561
    reported. The conversation's recorded cwd is authoritative, so when the
    caller knows it, it wins. */
export function attachCommandFromSpec(
  spec: ResumeSpec,
  meta: { accountId: string; accountLabel: string; note?: "subagent-root"; cwd?: string | null },
): AttachCommand {
  const cwd = meta.cwd || spec.cwd;
  return {
    engine: spec.engine,
    accountId: meta.accountId,
    accountLabel: meta.accountLabel,
    cwd,
    command: spec.command,
    cdCommand: `cd ${shellQuote(cwd)}`,
    fullCommand: `cd ${shellQuote(cwd)} && ${spec.command}`,
    ...(meta.note ? { note: meta.note } : {}),
  };
}

export type AttachResolution =
  | { ok: true; value: AttachCommand }
  | { ok: false; error: string; status: number };

export interface AttachResolverDeps {
  files: FileEntry[];
  resumeSpecFor: (root: string, path: string, options?: { model?: string | null; effort?: string | null; allowSubagents?: boolean; mcpServers?: readonly string[] }) => ResumeSpec | null;
  accountIdForPath: (path: string) => string;
  accountLabelFor: (engine: AgentEngine, accountId: string) => string;
  allowSubagentsForPath?: (path: string) => boolean | undefined;
  mcpServersForPath?: (path: string) => readonly string[] | undefined;
}

/**
 * Resolve the attach command for a transcript path. A Claude subagent has no
 * resumable session of its own, so it walks up its `parent` chain to the root
 * conversation and returns that command with a `subagent-root` note.
 */
export function resolveAttachCommand(path: string, deps: AttachResolverDeps): AttachResolution {
  const entry = deps.files.find((f) => f.path === path);
  if (!entry) return { ok: false, error: "file is unknown to the viewer", status: 404 };
  if (entry.engine === "shell") return { ok: false, error: "shell tasks have no agent session to attach", status: 409 };

  const target = resolvableTarget(entry, deps.files);
  if (!target) return { ok: false, error: "this conversation cannot be attached", status: 409 };

  const spec = deps.resumeSpecFor(target.entry.root, target.entry.path, {
    model: target.entry.launchModel ?? target.entry.model,
    effort: target.entry.effort,
    allowSubagents: deps.allowSubagentsForPath?.(target.entry.path),
    mcpServers: deps.mcpServersForPath?.(target.entry.path),
  });
  if (!spec) return { ok: false, error: "this conversation cannot be attached", status: 409 };

  const accountId = deps.accountIdForPath(target.entry.path);
  return {
    ok: true,
    value: attachCommandFromSpec(spec, {
      accountId,
      accountLabel: deps.accountLabelFor(spec.engine, accountId),
      cwd: target.entry.cwd ?? entry.cwd ?? null,
      ...(target.viaRoot ? { note: "subagent-root" as const } : {}),
    }),
  };
}

/** The launch-receipt fields the terminal command is composed from (round-1
    P1#6). Everything here is durable registry state, so a queued launch window —
    whose transcript path is the synthetic `spawn:<launchId>` — still yields a
    real working command from the recorded account home, cwd, and session id. */
export interface LaunchAttachReceipt {
  engine: AgentEngine;
  cwd: string;
  accountId: string | null;
  key: { engine: AgentEngine; sessionId: string } | null;
  launchProfile: { model: string | null; effort: string | null; fast: boolean | null; allowSubagents?: boolean; mcpServers?: readonly string[] };
}

export interface LaunchAttachDeps {
  receipt: LaunchAttachReceipt | null;
  /** The conversation's materialized transcript path, when it is already in the
      scan — preferred, so a launch that has since materialized resolves through
      the full path flow (subagent walk, cwd override). */
  materializedPath: string | null;
  resolveByPath: (path: string) => AttachResolution;
  resumeSpecForSession: (
    engine: AgentEngine,
    sessionId: string,
    cwd: string,
    home: string,
    options?: { model?: string | null; effort?: string | null; fast?: boolean | null; allowSubagents?: boolean; mcpServers?: readonly string[] },
  ) => ResumeSpec | null;
  homeForAccount: (engine: AgentEngine, accountId: string) => string | null;
  accountLabelFor: (engine: AgentEngine, accountId: string) => string;
}

/**
 * Resolve the terminal command for a `spawn:<launchId>` launch window (round-1
 * P1#6). Prefers the materialized transcript once it exists; before then it
 * composes the resume command directly from the durable receipt's recorded
 * account home, cwd, and session id — never handing the synthetic launch path to
 * a filesystem-path endpoint (the HTTP 400 the review flagged). Pure: all I/O is
 * injected.
 */
export function resolveLaunchAttachCommand(deps: LaunchAttachDeps): AttachResolution {
  const receipt = deps.receipt;
  if (!receipt) return { ok: false, error: "the launch is unknown to the viewer", status: 404 };
  if (deps.materializedPath) {
    const byPath = deps.resolveByPath(deps.materializedPath);
    if (byPath.ok) return byPath;
    /* A transient path-resolution miss (scan lag) falls through to the durable
       receipt composition below rather than surfacing the path error. */
  }
  if (!receipt.key) {
    return { ok: false, error: "the launch is still starting — the terminal command is available once its session binds", status: 409 };
  }
  const home = receipt.accountId ? deps.homeForAccount(receipt.engine, receipt.accountId) : null;
  if (!home) return { ok: false, error: "the launch account is unavailable for a terminal command", status: 409 };
  const spec = deps.resumeSpecForSession(receipt.engine, receipt.key.sessionId, receipt.cwd, home, {
    model: receipt.launchProfile.model,
    effort: receipt.launchProfile.effort,
    fast: receipt.launchProfile.fast,
    allowSubagents: receipt.launchProfile.allowSubagents,
    /* Re-apply the launch's recorded MCP allowlist (PR #610) so the resumed
       command enforces the same server scope the launch ran under. */
    mcpServers: receipt.launchProfile.mcpServers,
  });
  if (!spec) return { ok: false, error: "this launch cannot be attached", status: 409 };
  return {
    ok: true,
    value: attachCommandFromSpec(spec, {
      accountId: receipt.accountId ?? "",
      accountLabel: deps.accountLabelFor(receipt.engine, receipt.accountId ?? ""),
      cwd: receipt.cwd,
    }),
  };
}

/**
 * The transcript path the composed command actually resumes: the entry itself
 * when resumable, otherwise its nearest resumable ancestor (Claude subagent →
 * root). Null when the path is unknown or nothing resumable exists. The
 * migration fence must consult THIS path's conversation — the command captures
 * the resolved target's account home, not the requested transcript's.
 */
export function attachTargetPath(path: string, files: FileEntry[]): string | null {
  const entry = files.find((f) => f.path === path);
  if (!entry) return null;
  return resolvableTarget(entry, files)?.entry.path ?? null;
}

/** The entry whose resume command represents this conversation: itself when
    resumable, otherwise the nearest resumable ancestor (Claude subagent → root). */
function resolvableTarget(entry: FileEntry, files: FileEntry[]): { entry: FileEntry; viaRoot: boolean } | null {
  if (isResumable(entry)) return { entry, viaRoot: false };
  const seen = new Set<string>();
  let current: FileEntry | undefined = entry;
  while (current?.parent && !seen.has(current.parent)) {
    seen.add(current.parent);
    const parentPath: string = current.parent;
    const parent: FileEntry | undefined = files.find((f) => f.path === parentPath);
    if (!parent) break;
    if (isResumable(parent)) return { entry: parent, viaRoot: true };
    current = parent;
  }
  return null;
}

function isResumable(entry: FileEntry): boolean {
  if (entry.root === "claude-projects") return entry.kind === "session";
  return entry.root === "codex-sessions";
}
