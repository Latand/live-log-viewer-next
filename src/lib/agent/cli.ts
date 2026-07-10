import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accountForSpawn, codexHomeOwningSessionPath, isManagedCodexHome } from "@/lib/accounts/codex";
import { claudeHomeOwningTranscript, claudeSettingsPath, isManagedClaudeHome, legacyClaudeHome } from "@/lib/accounts/claude";

import { claudeTranscriptPath, headCwd } from "./transcript";
import { normalizeClaudeLaunchModel } from "./models";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";

export { ENGINE_EFFORTS, isEngineEffort } from "./efforts";

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
  if (process.env.LLV_DOCKER_NSENTER_SHIMS === "1" && (name === "claude" || name === "codex")) {
    const shim = "/usr/local/bin/" + name;
    try {
      fs.accessSync(shim, fs.constants.X_OK);
      return shim;
    } catch {
      /* keep looking */
    }
  }
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
  engine: AgentEngine;
  /** Transcript path the session will write, when knowable at spawn time —
      a fresh claude session launched with a pre-chosen --session-id. */
  transcript?: string;
  launchProfile?: LaunchProfile;
}

export interface FreshSpecOptions {
  model?: string | null;
  effort?: string | null;
  /** Codex only: true → `service_tier=priority` ("Fast" in the TUI), false →
      `service_tier=standard`; unset leaves the user's config.toml default. */
  fast?: boolean | null;
  readOnly?: boolean;
  /** Codex only: explicit account home scoped into the typed host command. */
  codexHome?: string | null;
  /** Claude only: an already-resolved managed config home. */
  claudeConfigDir?: string | null;
  claudeProjectsDir?: string | null;
}

const CLAUDE_SHADOWED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEXAI_PROJECT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
export function claudeEnvPrefix(home: string): string { return `env ${CLAUDE_SHADOWED_ENV.map((key) => `-u ${key}`).join(" ")} CLAUDE_CONFIG_DIR=${shellQuote(home)}`; }

export interface ResumeSpecOptions {
  model?: string | null;
  effort?: string | null;
}

/** Boot spec for a brand-new agent (no prior conversation) in a chosen directory. */
export function freshSpecFor(engine: AgentEngine, cwd: string, options: FreshSpecOptions = {}): ResumeSpec {
  if (engine === "claude") {
    /* A pre-chosen session id makes the transcript path knowable right at
       spawn time (handoff lineage links it before the file exists) and lets
       the scanner pid-match the session by argv, where the cwd fallback would
       stay ambiguous with several agents in one directory. */
    const sid = crypto.randomUUID();
    const args = [resolveBinary("claude")];
    /* Read-only rounds must not inherit the skip-permissions bypass: with it,
       denying Edit/Write still leaves Bash free to mutate the worktree. Plan
       mode is the CLI's real read-only policy — mutating actions need an
       approval the reviewer never gets. */
    if (options.readOnly) args.push("--permission-mode", "plan", "--disallowedTools", "Edit,Write,NotebookEdit");
    else args.push("--dangerously-skip-permissions");
    args.push("--session-id", sid);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    const managed = Boolean(options.claudeConfigDir && isManagedClaudeHome(options.claudeConfigDir));
    const settings = managed ? claudeSettingsPath() : null;
    if (settings) args.push("--settings", settings);
    const command = args.map(shellQuote).join(" ");
    return {
      command: managed ? `${claudeEnvPrefix(options.claudeConfigDir!)} ${command}` : command,
      cwd,
      windowName: "claude-new",
      engine: "claude",
      transcript: claudeTranscriptPath(cwd, sid, options.claudeProjectsDir ?? path.join(legacyClaudeHome(), "projects")),
      launchProfile: {
        cwd,
        model: options.model ?? null,
        effort: options.effort ?? null,
        fast: null,
        permissionMode: options.readOnly ? "plan" : "bypassPermissions",
        readOnly: options.readOnly ?? false,
        title: null,
        project: null,
        parentConversationId: null,
        role: "worker",
        goal: null,
        plan: null,
      },
    };
  }
  const args = [resolveBinary("codex")];
  const home = options.codexHome ?? accountForSpawn().home;
  if (isManagedCodexHome(home)) args.push("-c", "cli_auth_credentials_store=file");
  if (options.model) args.push("-m", options.model);
  if (options.effort) args.push("-c", `model_reasoning_effort=${options.effort}`);
  if (options.fast != null) args.push("-c", `service_tier=${options.fast ? "priority" : "standard"}`);
  if (options.readOnly) args.push("--sandbox", "read-only");
  const command = args.map(shellQuote).join(" ");
  return {
    command: `CODEX_HOME=${shellQuote(home)} ${command}`,
    cwd,
    windowName: "codex-new",
    engine: "codex",
    launchProfile: {
      cwd,
      model: options.model ?? null,
      effort: options.effort ?? null,
      fast: options.fast ?? null,
      permissionMode: options.readOnly ? "never" : null,
      readOnly: options.readOnly ?? false,
      title: null,
      project: null,
      parentConversationId: null,
      role: "worker",
      goal: null,
      plan: null,
    },
  };
}

export function claudeSuccessorSpecFor(input: {
  sourcePath: string;
  candidateId: string;
  targetHome: string;
  targetProjectsDir: string;
  profile: LaunchProfile;
}): ResumeSpec {
  if (!/^[0-9a-f-]{36}$/.test(input.candidateId)) throw new Error("candidate session id is invalid");
  const args = [
    resolveBinary("claude"),
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
  ];
  if (input.profile.readOnly || input.profile.permissionMode === "plan") {
    args.push("--permission-mode", "plan", "--disallowedTools", "Edit,Write,NotebookEdit");
  } else if (input.profile.permissionMode && input.profile.permissionMode !== "bypassPermissions") {
    if (input.profile.permissionMode.length <= 64 && /^[a-zA-Z-]+$/.test(input.profile.permissionMode)) {
      args.push("--permission-mode", input.profile.permissionMode);
    }
  } else {
    args.push("--dangerously-skip-permissions");
  }
  const model = normalizeClaudeLaunchModel(input.profile.model);
  if (model) args.push("--model", model);
  if (input.profile.effort && /^[a-z]+$/.test(input.profile.effort)) args.push("--effort", input.profile.effort);
  args.push("--resume", input.sourcePath, "--fork-session", "--session-id", input.candidateId);
  const settings = isManagedClaudeHome(input.targetHome) ? claudeSettingsPath() : null;
  if (settings) args.push("--settings", settings);
  return {
    command: `${claudeEnvPrefix(input.targetHome)} ${args.map(shellQuote).join(" ")}`,
    cwd: input.profile.cwd || resumeCwd(input.sourcePath),
    windowName: "claude-migration-successor",
    engine: "claude",
    transcript: claudeTranscriptPath(input.profile.cwd || resumeCwd(input.sourcePath), input.candidateId, input.targetProjectsDir),
    launchProfile: { ...input.profile, model },
  };
}

/**
 * Shell command that reopens a finished conversation interactively so a new
 * prompt can be typed into it. Claude subagent transcripts have no resumable
 * session of their own, so only root session files qualify.
 */
export function resumeSpecFor(root: string, pathname: string, options: ResumeSpecOptions = {}): ResumeSpec | null {
  const base = path.basename(pathname);
  if (root === "claude-projects" && base.endsWith(".jsonl") && !pathname.includes(path.sep + "subagents" + path.sep)) {
    const sid = base.slice(0, -".jsonl".length);
    if (!/^[0-9a-f-]{36}$/.test(sid)) return null;
    const home = claudeHomeOwningTranscript(pathname);
    if (!home) return null;
    const managed = isManagedClaudeHome(home);
    const settings = managed ? claudeSettingsPath() : null;
    let command = `${shellQuote(resolveBinary("claude"))} --dangerously-skip-permissions`;
    if (settings) command += ` --settings ${shellQuote(settings)}`;
    const launchModel = normalizeClaudeLaunchModel(options.model);
    if (launchModel) command += ` --model ${shellQuote(launchModel)}`;
    if (options.effort) command += ` --effort ${shellQuote(options.effort)}`;
    command += ` --resume ${shellQuote(sid)}`;
    return {
      command: managed ? `${claudeEnvPrefix(home)} ${command}` : command,
      cwd: resumeCwd(pathname),
      windowName: "claude-resume",
      engine: "claude",
      launchProfile: emptyLaunchProfileForResume(resumeCwd(pathname), launchModel, options.effort ?? null),
    };
  }
  if (root === "codex-sessions" && base.endsWith(".jsonl")) {
    const id = base.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
    if (!id) return null;
    const home = codexHomeOwningSessionPath(pathname);
    if (!home) return null;
    let command = `${resolveBinary("codex")}`;
    if (isManagedCodexHome(home)) command += " -c cli_auth_credentials_store=file";
    if (options.model) command += ` -m ${shellQuote(options.model)}`;
    if (options.effort) command += ` -c ${shellQuote(`model_reasoning_effort=${options.effort}`)}`;
    command += ` resume ${id}`;
    return {
      command: `CODEX_HOME=${shellQuote(home)} ${command}`,
      cwd: resumeCwd(pathname),
      windowName: "codex-resume",
      engine: "codex",
      launchProfile: emptyLaunchProfileForResume(resumeCwd(pathname), options.model ?? null, options.effort ?? null),
    };
  }
  return null;
}

function emptyLaunchProfileForResume(cwd: string, model: string | null, effort: string | null): LaunchProfile {
  return {
    cwd,
    model,
    effort,
    fast: null,
    permissionMode: null,
    readOnly: null,
    title: null,
    project: null,
    parentConversationId: null,
    role: "worker",
    goal: null,
    plan: null,
  };
}

/** A resume window must land in a directory that still exists; the home
    directory is the safe fallback when the transcript's cwd is gone. */
function resumeCwd(pathname: string): string {
  return headCwd(pathname, { maxLines: 30, requireDir: true }) ?? os.homedir();
}
