import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accountForSpawn, codexHomeOwningSessionPath, isManagedCodexHome } from "@/lib/accounts/codex";
import { claudeHomeOwningTranscript, claudeSettingsPath, isManagedClaudeHome, legacyClaudeHome } from "@/lib/accounts/claude";

import { claudeTranscriptPath, headCwd } from "./transcript";
import { normalizeSpawnMcpServers } from "./mcpAllowlist";
import { normalizeClaudeLaunchModel } from "./models";
import { applyClaudeSpawnPolicy, claudeSpawnPolicyPaths, VIEWER_SPAWN_CAPABILITY_ENV } from "./spawnPolicy";
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
  /** Non-interactive `claude -p` command that can never present a permission
      acceptance gate; the only Claude shape a tmux window may still host
      under structured transport (the migration successor fork). */
  printMode?: true;
  launchProfile?: LaunchProfile;
}

export function withSpawnCapability(spec: ResumeSpec, capability: string): ResumeSpec {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("Viewer spawn capability is invalid");
  return {
    ...spec,
    command: `env ${VIEWER_SPAWN_CAPABILITY_ENV}=${shellQuote(capability)} ${spec.command}`,
  };
}

export interface FreshSpecOptions {
  model?: string | null;
  effort?: string | null;
  /** Codex only: true → `service_tier=priority` ("Fast" in the TUI), false →
      `service_tier=standard`; unset leaves the user's config.toml default. */
  fast?: boolean | null;
  readOnly?: boolean;
  /** Claude only: override the CLI permission mode for a fresh launch. */
  permissionMode?: string | null;
  /** Codex only: explicit account home scoped into the typed host command. */
  codexHome?: string | null;
  /** Claude only: an already-resolved managed config home. */
  claudeConfigDir?: string | null;
  claudeProjectsDir?: string | null;
  /** Allow native Claude sub-agents and the Codex multi-agent feature. */
  allowSubagents?: boolean;
  mcpServers?: readonly string[];
  /** Route admission owns policy materialization after its durable reservation. */
  deferClaudeSpawnPolicy?: boolean;
}

const CLAUDE_SHADOWED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEXAI_PROJECT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "LLV_TOKEN"];
export function claudeEnvPrefix(home: string): string { return `env ${CLAUDE_SHADOWED_ENV.map((key) => `-u ${key}`).join(" ")} CLAUDE_CONFIG_DIR=${shellQuote(home)}`; }

export interface ResumeSpecOptions {
  model?: string | null;
  effort?: string | null;
  /** Codex only: override the service tier when reopening a conversation. */
  fast?: boolean | null;
  /** Execution policy inherited from the generation being replaced. */
  readOnly?: boolean | null;
  permissionMode?: string | null;
  allowSubagents?: boolean;
  mcpServers?: readonly string[];
}

function normalizedMcpServers(value: readonly string[] | undefined): string[] {
  const normalized = normalizeSpawnMcpServers(value);
  if (!normalized.ok) throw new Error(normalized.error);
  return normalized.value;
}

function configuredCodexMcpServers(home: string, cwd: string): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.LLV_TOKEN;
  const listed = spawnSync(process.env.LLV_CODEX_BINARY ?? resolveBinary("codex"), ["mcp", "list", "--json"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (listed.status === 0) {
    try {
      const parsed = JSON.parse(listed.stdout) as unknown;
      if (Array.isArray(parsed) && parsed.every((server) => server && typeof server === "object" && typeof (server as { name?: unknown }).name === "string")) {
        return parsed.map((server) => (server as { name: string }).name);
      }
    } catch { /* fail closed below */ }
  }
  throw new Error("Codex MCP configuration could not be enumerated safely");
}

function codexMcpRuntimeOverrides(home: string, cwd: string, allowlist: readonly string[]): string[] {
  const enabled = new Set(allowlist);
  return configuredCodexMcpServers(home, cwd).map((name) => {
    const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
    return `mcp_servers.${key}.enabled=${enabled.has(name)}`;
  });
}

function pushClaudePolicyArgs(
  args: string[],
  policy: ReturnType<typeof applyClaudeSpawnPolicy> | ReturnType<typeof claudeSpawnPolicyPaths>,
): void {
  args.push(
    "--settings", policy.settingsPath,
    "--strict-mcp-config", "--mcp-config", policy.mcpConfigPath,
  );
}

export function effectiveClaudePermissionMode(
  options: Pick<ResumeSpecOptions, "readOnly" | "permissionMode">,
): string {
  if (options.permissionMode) return options.permissionMode;
  return options.readOnly ? "plan" : "bypassPermissions";
}

/** Boot spec for a brand-new agent (no prior conversation) in a chosen directory. */
export function freshSpecFor(engine: AgentEngine, cwd: string, options: FreshSpecOptions = {}): ResumeSpec {
  const mcpServers = normalizedMcpServers(options.mcpServers);
  if (engine === "claude") {
    /* A pre-chosen session id makes the transcript path knowable right at
       spawn time (handoff lineage links it before the file exists) and lets
       the scanner pid-match the session by argv, where the cwd fallback would
       stay ambiguous with several agents in one directory. */
    const sid = crypto.randomUUID();
    const args = [resolveBinary("claude")];
    /* Read-only rounds must not inherit the skip-permissions bypass: with it,
       denying Edit/Write still leaves Bash free to mutate the worktree. */
    const permissionMode = effectiveClaudePermissionMode(options);
    if (options.readOnly) args.push("--permission-mode", permissionMode, "--disallowedTools", "Edit,Write,NotebookEdit");
    else if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", permissionMode);
    args.push("--session-id", sid);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    const managed = Boolean(options.claudeConfigDir && isManagedClaudeHome(options.claudeConfigDir));
    const installedPolicy = options.claudeConfigDir
      ? options.deferClaudeSpawnPolicy
        ? claudeSpawnPolicyPaths(options.claudeConfigDir, sid)
        : applyClaudeSpawnPolicy(options.claudeConfigDir, {
          allowSubagents: options.allowSubagents,
          cwd,
          mcpServers,
          baseSettingsPath: managed ? claudeSettingsPath() : null,
          profileId: sid,
        })
      : null;
    if (installedPolicy) pushClaudePolicyArgs(args, installedPolicy);
    else args.push("--strict-mcp-config");
    const command = args.map(shellQuote).join(" ");
    return {
      command: managed ? `${claudeEnvPrefix(options.claudeConfigDir!)} ${command}` : command,
      cwd,
      windowName: "claude-new",
      engine: "claude",
      ["transcript"]: claudeTranscriptPath(cwd, sid, options.claudeProjectsDir ?? path.join(legacyClaudeHome(), "projects")),
      launchProfile: {
        cwd,
        model: options.model ?? null,
        effort: options.effort ?? null,
        fast: null,
        permissionMode,
        readOnly: options.readOnly ?? false,
        allowSubagents: options.allowSubagents ?? false,
        mcpServers,
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
  for (const override of codexMcpRuntimeOverrides(home, cwd, mcpServers)) args.push("-c", override);
  if (options.model) args.push("-m", options.model);
  if (options.effort) args.push("-c", `model_reasoning_effort=${options.effort}`);
  if (options.fast != null) args.push("-c", `service_tier=${options.fast ? "priority" : "standard"}`);
  if (options.readOnly) args.push("--sandbox", "read-only");
  if (!options.allowSubagents) args.push("--disable", "multi_agent");
  const command = args.map(shellQuote).join(" ");
  return {
    command: `env -u LLV_TOKEN CODEX_HOME=${shellQuote(home)} ${command}`,
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
      allowSubagents: options.allowSubagents ?? false,
      mcpServers,
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
  const permissionMode = effectiveClaudePermissionMode(input.profile);
  if (input.profile.readOnly || permissionMode === "plan") {
    args.push("--permission-mode", "plan", "--disallowedTools", "Edit,Write,NotebookEdit");
  } else if (permissionMode !== "bypassPermissions") {
    if (permissionMode.length <= 64 && /^[a-zA-Z-]+$/.test(permissionMode)) {
      args.push("--permission-mode", permissionMode);
    }
  } else {
    args.push("--dangerously-skip-permissions");
  }
  const model = normalizeClaudeLaunchModel(input.profile.model);
  if (model) args.push("--model", model);
  if (input.profile.effort && /^[a-z]+$/.test(input.profile.effort)) args.push("--effort", input.profile.effort);
  args.push("--resume", input.sourcePath, "--fork-session", "--session-id", input.candidateId);
  const cwd = input.profile.cwd || resumeCwd(input.sourcePath);
  const policy = applyClaudeSpawnPolicy(input.targetHome, {
    allowSubagents: input.profile.allowSubagents,
    baseSettingsPath: isManagedClaudeHome(input.targetHome) ? claudeSettingsPath() : null,
    profileId: input.candidateId,
    cwd,
    mcpServers: input.profile.mcpServers,
    mcpStatePath: isManagedClaudeHome(input.targetHome)
      ? path.join(input.targetHome, ".claude.json")
      : path.join(path.dirname(input.targetHome), ".claude.json"),
  });
  pushClaudePolicyArgs(args, policy);
  return {
    command: `${claudeEnvPrefix(input.targetHome)} ${args.map(shellQuote).join(" ")}`,
    cwd,
    windowName: "claude-migration-successor",
    engine: "claude",
    ["transcript"]: claudeTranscriptPath(input.profile.cwd || resumeCwd(input.sourcePath), input.candidateId, input.targetProjectsDir),
    printMode: true,
    launchProfile: { ...input.profile, model, permissionMode },
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
    return resumeSpecForSession("claude", sid, resumeCwd(pathname), home, options);
  }
  if (root === "codex-sessions" && base.endsWith(".jsonl")) {
    const id = base.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
    if (!id) return null;
    const home = codexHomeOwningSessionPath(pathname);
    if (!home) return null;
    return resumeSpecForSession("codex", id, resumeCwd(pathname), home, options);
  }
  return null;
}

/**
 * Compose the resume/attach command from an explicit engine + session id + cwd +
 * account home, without needing the transcript file to exist yet (round-1 P1#6).
 * The transcript-path form {@link resumeSpecFor} delegates here after sniffing
 * the session id and home off the path; the launch-receipt form (a queued
 * `spawn:<launchId>` window whose transcript has not materialized) passes the
 * durable receipt's recorded session id, cwd, and account home directly, so
 * "Open in terminal" composes a real working command instead of 400-ing on a
 * synthetic path.
 */
export function resumeSpecForSession(
  engine: AgentEngine,
  sessionId: string,
  cwd: string,
  home: string,
  options: ResumeSpecOptions = {},
): ResumeSpec | null {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  const mcpServers = normalizedMcpServers(options.mcpServers);
  if (engine === "claude") {
    const managed = isManagedClaudeHome(home);
    const policy = applyClaudeSpawnPolicy(home, {
      allowSubagents: options.allowSubagents,
      baseSettingsPath: managed ? claudeSettingsPath() : null,
      profileId: `resume-${sessionId}`,
      cwd,
      mcpServers,
      mcpStatePath: managed ? path.join(home, ".claude.json") : path.join(path.dirname(home), ".claude.json"),
    });
    const args = [resolveBinary("claude")];
    const permissionMode = effectiveClaudePermissionMode(options);
    if (options.readOnly || permissionMode === "plan") {
      args.push("--permission-mode", "plan", "--disallowedTools", "Edit,Write,NotebookEdit");
    } else if (permissionMode !== "bypassPermissions" && /^[a-zA-Z-]+$/.test(permissionMode)) {
      args.push("--permission-mode", permissionMode);
    } else {
      args.push("--dangerously-skip-permissions");
    }
    pushClaudePolicyArgs(args, policy);
    const launchModel = normalizeClaudeLaunchModel(options.model);
    if (launchModel) args.push("--model", launchModel);
    if (options.effort) args.push("--effort", options.effort);
    args.push("--resume", sessionId);
    const command = args.map(shellQuote).join(" ");
    return {
      command: managed ? `${claudeEnvPrefix(home)} ${command}` : command,
      cwd,
      windowName: "claude-resume",
      engine: "claude",
      launchProfile: { ...emptyLaunchProfileForResume(cwd, launchModel, options.effort ?? null), readOnly: options.readOnly ?? null, permissionMode, allowSubagents: options.allowSubagents ?? false, mcpServers },
    };
  }
  let command = `${resolveBinary("codex")}`;
  if (isManagedCodexHome(home)) command += " -c cli_auth_credentials_store=file";
  for (const override of codexMcpRuntimeOverrides(home, cwd, mcpServers)) command += ` -c ${shellQuote(override)}`;
  if (options.model) command += ` -m ${shellQuote(options.model)}`;
  if (options.effort) command += ` -c ${shellQuote(`model_reasoning_effort=${options.effort}`)}`;
  if (options.fast != null) command += ` -c ${shellQuote(`service_tier=${options.fast ? "priority" : "standard"}`)}`;
  if (options.readOnly) command += " --sandbox read-only";
  if (options.permissionMode && ["untrusted", "on-request", "never"].includes(options.permissionMode)) {
    command += ` --ask-for-approval ${shellQuote(options.permissionMode)}`;
  }
  if (!options.allowSubagents) command += " --disable multi_agent";
  command += ` resume ${sessionId}`;
  return {
    command: `env -u LLV_TOKEN CODEX_HOME=${shellQuote(home)} ${command}`,
    cwd,
    windowName: "codex-resume",
    engine: "codex",
    launchProfile: { ...emptyLaunchProfileForResume(cwd, options.model ?? null, options.effort ?? null), fast: options.fast ?? null, readOnly: options.readOnly ?? null, permissionMode: options.permissionMode ?? null, allowSubagents: options.allowSubagents ?? false, mcpServers },
  };
}

function emptyLaunchProfileForResume(cwd: string, model: string | null, effort: string | null): LaunchProfile {
  return {
    cwd,
    model,
    effort,
    fast: null,
    permissionMode: null,
    readOnly: null,
    allowSubagents: false,
    mcpServers: ["viewer"],
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
