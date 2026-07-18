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

/** Build the {@link AttachCommand} from an already-resolved resume spec. Pure. */
export function attachCommandFromSpec(
  spec: ResumeSpec,
  meta: { accountId: string; accountLabel: string; note?: "subagent-root" },
): AttachCommand {
  return {
    engine: spec.engine,
    accountId: meta.accountId,
    accountLabel: meta.accountLabel,
    cwd: spec.cwd,
    command: spec.command,
    cdCommand: `cd ${shellQuote(spec.cwd)}`,
    fullCommand: `cd ${shellQuote(spec.cwd)} && ${spec.command}`,
    ...(meta.note ? { note: meta.note } : {}),
  };
}

export type AttachResolution =
  | { ok: true; value: AttachCommand }
  | { ok: false; error: string; status: number };

export interface AttachResolverDeps {
  files: FileEntry[];
  resumeSpecFor: (root: string, path: string, options?: { model?: string | null; effort?: string | null; allowSubagents?: boolean }) => ResumeSpec | null;
  accountIdForPath: (path: string) => string;
  accountLabelFor: (engine: AgentEngine, accountId: string) => string;
  allowSubagentsForPath?: (path: string) => boolean | undefined;
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
  });
  if (!spec) return { ok: false, error: "this conversation cannot be attached", status: 409 };

  const accountId = deps.accountIdForPath(target.entry.path);
  return {
    ok: true,
    value: attachCommandFromSpec(spec, {
      accountId,
      accountLabel: deps.accountLabelFor(spec.engine, accountId),
      ...(target.viaRoot ? { note: "subagent-root" as const } : {}),
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
