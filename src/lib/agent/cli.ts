import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeTranscriptPath, headCwd } from "./transcript";

/**
 * The one home for "how do we start an agent CLI": binary resolution, shell
 * quoting, and the boot/resume command specs for both engines. Flag changes
 * (permissions mode, session ids, read-only sandboxes) land here and nowhere
 * else.
 */

export type AgentEngine = "claude" | "codex";

/** Absolute path of an agent CLI when we can find one; bare name otherwise. */
export function resolveBinary(name: string): string {
  const home = os.homedir();
  /* ~/.bun/bin goes first: on this machine the system-wide /usr/bin/claude is
     an npm install that crashes under the current Node, while the bun shim is
     the CLI the user actually runs. */
  for (const candidate of [
    path.join(home, ".bun", "bin", name),
    path.join(home, ".npm-global", "bin", name),
    path.join(home, ".local", "bin", name),
    path.join(home, "go", "bin", name),
    "/usr/local/bin/" + name,
    "/usr/bin/" + name,
  ]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return name;
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export interface ResumeSpec {
  command: string;
  cwd: string;
  windowName: string;
  /** Transcript path the session will write, when knowable at spawn time —
      a fresh claude session launched with a pre-chosen --session-id. */
  transcript?: string;
}

export interface FreshSpecOptions {
  model?: string | null;
  effort?: string | null;
  readOnly?: boolean;
}

/** Boot spec for a brand-new agent (no prior conversation) in a chosen directory. */
export function freshSpecFor(engine: AgentEngine, cwd: string, options: FreshSpecOptions = {}): ResumeSpec {
  if (engine === "claude") {
    /* A pre-chosen session id makes the transcript path knowable right at
       spawn time (handoff lineage links it before the file exists) and lets
       the scanner pid-match the session by argv, where the cwd fallback would
       stay ambiguous with several agents in one directory. */
    const sid = crypto.randomUUID();
    const args = [resolveBinary("claude"), "--dangerously-skip-permissions", "--session-id", sid];
    if (options.model) args.push("--model", options.model);
    if (options.readOnly) args.push("--disallowedTools", "Edit,Write,NotebookEdit");
    return {
      command: args.map(shellQuote).join(" "),
      cwd,
      windowName: "claude-new",
      transcript: claudeTranscriptPath(cwd, sid),
    };
  }
  const args = [resolveBinary("codex")];
  if (options.model) args.push("-m", options.model);
  if (options.effort) args.push("-c", `model_reasoning_effort=${options.effort}`);
  if (options.readOnly) args.push("--sandbox", "read-only");
  return { command: args.map(shellQuote).join(" "), cwd, windowName: "codex-new" };
}

/**
 * Shell command that reopens a finished conversation interactively so a new
 * prompt can be typed into it. Claude subagent transcripts have no resumable
 * session of their own, so only root session files qualify.
 */
export function resumeSpecFor(root: string, pathname: string): ResumeSpec | null {
  const base = path.basename(pathname);
  if (root === "claude-projects" && base.endsWith(".jsonl") && !pathname.includes(path.sep + "subagents" + path.sep)) {
    const sid = base.slice(0, -".jsonl".length);
    if (!/^[0-9a-f-]{36}$/.test(sid)) return null;
    return {
      command: `${resolveBinary("claude")} --dangerously-skip-permissions --resume ${sid}`,
      cwd: resumeCwd(pathname),
      windowName: "claude-resume",
    };
  }
  if (root === "codex-sessions" && base.endsWith(".jsonl")) {
    const id = base.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
    if (!id) return null;
    return {
      command: `${resolveBinary("codex")} resume ${id}`,
      cwd: resumeCwd(pathname),
      windowName: "codex-resume",
    };
  }
  return null;
}

/** A resume window must land in a directory that still exists; the home
    directory is the safe fallback when the transcript's cwd is gone. */
function resumeCwd(pathname: string): string {
  return headCwd(pathname, { maxLines: 30, requireDir: true }) ?? os.homedir();
}
