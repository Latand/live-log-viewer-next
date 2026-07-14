import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { AgentEngine } from "./cli";

type JsonObject = Record<string, unknown>;

const MANAGED_HOOK_PREFIX = "LLV_MANAGED_NATIVE_SUBAGENT_DENY=1 ";
const MANAGED_DIR = ".llv";
const MANAGED_HOOK = "deny-native-subagents.sh";

export const VIEWER_SPAWN_ENDPOINT = "http://127.0.0.1:8898/api/spawn";
export const VIEWER_SPAWN_CAPABILITY_ENV = "LLV_SPAWN_CAPABILITY";
export const VIEWER_SPAWN_CAPABILITY_HEADER = "x-llv-spawn-capability";
const SPAWN_AUTH_GUIDANCE = `Send header ${VIEWER_SPAWN_CAPABILITY_HEADER}: $${VIEWER_SPAWN_CAPABILITY_ENV}.`;
export const NATIVE_SUBAGENT_DENY_MESSAGE = `Sub-agents are disabled on this surface. Spawn через POST ${VIEWER_SPAWN_ENDPOINT} with {engine, model, cwd, prompt, src: <your transcript path>, role, reviews?} and ${SPAWN_AUTH_GUIDANCE} The worker then appears on the board with correct lineage.`;
export const VIEWER_SPAWN_PROMPT_FENCE = `Viewer spawn policy: avoid native sub-agent, collaboration, and background-agent features. Spawn every helper through POST ${VIEWER_SPAWN_ENDPOINT} with {engine, model, cwd, prompt, src: <your transcript path>, role, reviews?}. ${SPAWN_AUTH_GUIDANCE} The worker appears on the board with correct lineage.`;

export const CODEX_VIEWER_SPAWN_FEATURES = {
  plugins: false,
  apps: false,
  multi_agent: false,
} as const;

export interface ClaudeSpawnPolicyResult {
  settingsPath: string;
  hookPath: string;
  command: string;
}

export function claudeSpawnPolicyPaths(home: string, profileId: string): ClaudeSpawnPolicyResult {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profileId)) throw new Error("Claude spawn policy profile id is invalid");
  const hookPath = path.join(home, MANAGED_DIR, "hooks", MANAGED_HOOK);
  return {
    settingsPath: path.join(home, MANAGED_DIR, "spawn-settings", `${profileId}.json`),
    hookPath,
    command: `${MANAGED_HOOK_PREFIX}${shellQuote(hookPath)}`,
  };
}

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function atomicWrite(pathname: string, contents: string, mode: number): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, pathname);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readSettings(pathname: string): JsonObject {
  if (!fs.existsSync(pathname)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    throw new Error(`Claude settings are invalid JSON: ${pathname}`);
  }
  const settings = record(parsed);
  if (!settings) throw new Error(`Claude settings must contain a JSON object: ${pathname}`);
  return settings;
}

/** Seeds the mutable Claude home state before a managed bypass launch. */
export function prepareManagedClaudeSpawnHome(home: string, cwd: string): void {
  const pathname = path.join(home, ".claude.json");
  try {
    const stat = fs.lstatSync(pathname);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Claude state path is unsafe: ${pathname}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let state: JsonObject = {};
  if (fs.existsSync(pathname)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(pathname, "utf8"));
    } catch {
      throw new Error(`Claude state is invalid JSON: ${pathname}`);
    }
    const value = record(parsed);
    if (!value) throw new Error(`Claude state must contain a JSON object: ${pathname}`);
    state = value;
  }
  const projects = state.projects === undefined ? {} : record(state.projects);
  if (!projects) throw new Error(`Claude state projects must contain a JSON object: ${pathname}`);
  const existingProject = projects[cwd] === undefined ? {} : record(projects[cwd]);
  if (!existingProject) throw new Error(`Claude project state must contain a JSON object: ${cwd}`);
  atomicWrite(pathname, JSON.stringify({
    ...state,
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      ...projects,
      [cwd]: {
        ...existingProject,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  }, null, 2) + "\n", 0o600);
}

function managedCommand(command: unknown): boolean {
  return typeof command === "string" && command.startsWith(MANAGED_HOOK_PREFIX);
}

function withoutManagedHandlers(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Claude settings hooks.PreToolUse must be an array");
  return value.flatMap((candidate) => {
    const group = record(candidate);
    if (!group || !Array.isArray(group.hooks)) return [candidate];
    const handlers = group.hooks.filter((handler) => !managedCommand(record(handler)?.command));
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
}

/** Reconciles the Viewer-owned Claude hook while preserving every user key and handler. */
export function applyClaudeSpawnPolicy(
  home: string,
  options: { allowSubagents?: boolean; baseSettingsPath?: string | null; profileId?: string } = {},
): ClaudeSpawnPolicyResult {
  const sourceSettingsPath = path.join(home, "settings.json");
  const profileId = options.profileId ?? crypto.randomUUID();
  const result = claudeSpawnPolicyPaths(home, profileId);
  const sourceExists = fs.existsSync(sourceSettingsPath);
  const sourceSettings = sourceExists
    ? readSettings(sourceSettingsPath)
    : options.baseSettingsPath ? readSettings(options.baseSettingsPath) : {};
  const settings = sourceExists ? {} : sourceSettings;
  if (!options.allowSubagents && sourceSettings.disableAllHooks === true) {
    throw new Error("Claude settings disableAllHooks prevents the Viewer spawn policy from enforcing native sub-agent denial");
  }
  if (!options.allowSubagents && sourceSettings.allowManagedHooksOnly === true) {
    throw new Error("Claude settings allowManagedHooksOnly prevents the Viewer spawn policy from enforcing native sub-agent denial");
  }
  const hooks = settings.hooks === undefined ? {} : record(settings.hooks);
  if (!hooks) throw new Error("Claude settings hooks must contain a JSON object");

  const preToolUse = withoutManagedHandlers(hooks.PreToolUse);
  if (!options.allowSubagents) {
    const script = `#!/bin/sh\nprintf '%s\\n' ${shellQuote(NATIVE_SUBAGENT_DENY_MESSAGE)} >&2\nexit 2\n`;
    atomicWrite(result.hookPath, script, 0o700);
    preToolUse.push({
      matcher: "Task|Agent",
      hooks: [{ type: "command", command: result.command }],
    });
  }

  const enforcedSettings = options.allowSubagents
    ? settings
    : { ...settings, disableAllHooks: false, allowManagedHooksOnly: false };
  atomicWrite(result.settingsPath, JSON.stringify({ ...enforcedSettings, hooks: { ...hooks, PreToolUse: preToolUse } }, null, 2) + "\n", 0o600);
  return result;
}

export function fenceViewerSpawnPrompt(engine: AgentEngine, prompt: string): string {
  if (engine !== "codex") return prompt;
  return [prompt.trim(), VIEWER_SPAWN_PROMPT_FENCE].filter(Boolean).join("\n\n");
}
