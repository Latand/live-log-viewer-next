import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyClaudeSpawnPolicy, fenceViewerSpawnPrompt, NATIVE_MULTI_AGENT_HOOK_MATCHER, NATIVE_MULTI_AGENT_TOOLS, NATIVE_SUBAGENT_DENY_MESSAGE, prepareManagedClaudeSpawnHome, VIEWER_SPAWN_PROMPT_FENCE } from "./spawnPolicy";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-policy-"));
  homes.push(directory);
  return directory;
}

test("Claude spawn policy installs a multi-agent deny hook with Viewer lineage guidance", async () => {
  const accountHome = home();

  const installed = applyClaudeSpawnPolicy(accountHome, { profileId: "denied" });
  const settings = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };

  expect(settings.hooks.PreToolUse).toContainEqual({
    matcher: "Task|Agent|Workflow|TeamCreate|TeamDelete|SendMessage",
    hooks: [{ type: "command", command: installed.command }],
  });
  expect((settings as unknown as { disableAllHooks: boolean }).disableAllHooks).toBe(false);
  expect((settings as unknown as { allowManagedHooksOnly: boolean }).allowManagedHooksOnly).toBe(false);

  const denied = Bun.spawn(["sh", "-c", installed.command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  denied.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {} }));
  denied.stdin.end();

  expect(await denied.exited).toBe(2);
  expect(await new Response(denied.stderr).text()).toBe(`${NATIVE_SUBAGENT_DENY_MESSAGE}\n`);
});

test("Claude spawn policy pins the audited multi-agent set and denies Workflow and team tools (#381)", async () => {
  expect([...NATIVE_MULTI_AGENT_TOOLS]).toEqual(["Task", "Agent", "Workflow", "TeamCreate", "TeamDelete", "SendMessage"]);
  expect(NATIVE_MULTI_AGENT_HOOK_MATCHER).toBe("Task|Agent|Workflow|TeamCreate|TeamDelete|SendMessage");
  /* The installed Claude CLI (2.1.214) applies a PreToolUse matcher by splitting
     it on "|" and testing exact membership of the tool name, so "Task" denies
     only Task and never TaskOutput. A substring or unanchored-regex model would
     wrongly swallow the task-list tools, so the assertions below model the exact
     split-membership semantics. */
  const deniedByMatcher = (tool: string): boolean => NATIVE_MULTI_AGENT_HOOK_MATCHER.split("|").includes(tool);
  for (const tool of NATIVE_MULTI_AGENT_TOOLS) expect(deniedByMatcher(tool)).toBe(true);
  /* Task-list tools, background-shell tools, and full Bash/filesystem access
     must remain allowed on denied structured hosts. */
  const allowedTools = [
    "TaskOutput", "TaskStop", "TaskCreate",
    "BashOutput", "KillShell",
    "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "NotebookEdit",
  ];
  for (const tool of allowedTools) {
    expect(deniedByMatcher(tool)).toBe(false);
    expect(NATIVE_MULTI_AGENT_TOOLS).not.toContain(tool);
  }

  const installed = applyClaudeSpawnPolicy(home(), { profileId: "audited" });
  for (const tool of ["Workflow", "TeamCreate", "SendMessage"]) {
    const denied = Bun.spawn(["sh", "-c", installed.command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    denied.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} }));
    denied.stdin.end();
    expect(await denied.exited).toBe(2);
    expect(await new Response(denied.stderr).text()).toBe(`${NATIVE_SUBAGENT_DENY_MESSAGE}\n`);
  }
});

test("Claude spawn policy rejects an account restriction that suppresses flag-provided hooks", () => {
  const accountHome = home();
  fs.writeFileSync(path.join(accountHome, "settings.json"), JSON.stringify({ allowManagedHooksOnly: true }));

  expect(() => applyClaudeSpawnPolicy(accountHome, { profileId: "worker" }))
    .toThrow("allowManagedHooksOnly");
});

test("Claude spawn policy preserves user settings and re-injects one managed hook", () => {
  const accountHome = home();
  const settingsPath = path.join(accountHome, "settings.json");
  const userSettings = JSON.stringify({
    model: "claude-user-choice",
    env: { USER_SETTING: "kept" },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "user-session-hook" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-bash-hook" }] }],
    },
  });
  fs.writeFileSync(settingsPath, userSettings);

  const installed = applyClaudeSpawnPolicy(accountHome, { profileId: "worker" });
  applyClaudeSpawnPolicy(accountHome, { profileId: "worker" });
  const profile = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
  };

  expect(fs.readFileSync(settingsPath, "utf8")).toBe(userSettings);
  expect(profile.hooks.PreToolUse.filter((group) => group.matcher === "Task|Agent|Workflow|TeamCreate|TeamDelete|SendMessage")).toHaveLength(1);
});

test("Claude spawn policy seeds a fresh account from the shared user settings snapshot", () => {
  const accountHome = home();
  const shared = path.join(home(), "settings.json");
  fs.writeFileSync(shared, JSON.stringify({ model: "shared-model", env: { SHARED: "kept" } }));

  const installed = applyClaudeSpawnPolicy(accountHome, { baseSettingsPath: shared, profileId: "worker" });
  const settings = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as {
    model: string;
    env: Record<string, string>;
    hooks: { PreToolUse: unknown[] };
  };

  expect(settings.model).toBe("shared-model");
  expect(settings.env).toEqual({ SHARED: "kept" });
  expect(settings.hooks.PreToolUse).toHaveLength(1);
});

test("Claude spawn settings force Viewer into a custom allowlist and omit unrelated servers", () => {
  const accountHome = home();
  fs.writeFileSync(path.join(accountHome, ".claude.json"), JSON.stringify({
    mcpServers: {
      viewer: { type: "stdio", command: "viewer-mcp", args: ["--viewer"] },
      "agent-browser": { type: "stdio", command: "browser-mcp" },
      "telegram-readonly": { type: "stdio", command: "telegram-mcp" },
    },
  }));

  const installed = applyClaudeSpawnPolicy(accountHome, {
    profileId: "custom-mcp",
    cwd: "/repo",
    mcpServers: ["agent-browser"],
  });
  const settings = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };

  expect(settings.mcpServers).toEqual({
    viewer: { type: "stdio", command: "viewer-mcp", args: ["--viewer"] },
    "agent-browser": { type: "stdio", command: "browser-mcp" },
  });
});

test("Claude spawn settings default to the registered Viewer server only", () => {
  const accountHome = home();
  fs.writeFileSync(path.join(accountHome, ".claude.json"), JSON.stringify({
    mcpServers: {
      viewer: { type: "stdio", command: "viewer-mcp" },
      "agent-browser": { type: "stdio", command: "browser-mcp" },
    },
  }));

  const installed = applyClaudeSpawnPolicy(accountHome, { profileId: "default-mcp", cwd: "/repo" });
  const settings = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };

  expect(settings.mcpServers).toEqual({ viewer: { type: "stdio", command: "viewer-mcp" } });
});

test("allowSubagents uses an isolated profile while the denied profile stays enforced", () => {
  const accountHome = home();
  const shared = path.join(home(), "settings.json");
  fs.writeFileSync(shared, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "user-read-hook" }] }] },
  }));
  const installed = applyClaudeSpawnPolicy(accountHome, { baseSettingsPath: shared, profileId: "worker" });

  const allowedProfile = applyClaudeSpawnPolicy(accountHome, { allowSubagents: true, baseSettingsPath: shared, profileId: "orchestrator" });
  const denied = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
  };
  const allowed = JSON.parse(fs.readFileSync(allowedProfile.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };

  expect(denied.hooks.PreToolUse.some((group) => group.matcher === "Task|Agent|Workflow|TeamCreate|TeamDelete|SendMessage")).toBe(true);
  expect(allowed.hooks.PreToolUse).toEqual([{ matcher: "Read", hooks: [{ type: "command", command: "user-read-hook" }] }]);
});

test("managed Claude launch state accepts bypass mode and trusts the exact spawn directory", () => {
  const accountHome = home();
  const statePath = path.join(accountHome, ".claude.json");
  fs.writeFileSync(statePath, JSON.stringify({
    theme: "dark",
    projects: { "/existing": { hasTrustDialogAccepted: true, custom: "kept" } },
  }));

  prepareManagedClaudeSpawnHome(accountHome, "/repo/worktree");

  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    theme: string;
    hasCompletedOnboarding: boolean;
    bypassPermissionsModeAccepted: boolean;
    projects: Record<string, Record<string, unknown>>;
  };
  expect(state.theme).toBe("dark");
  expect(state.hasCompletedOnboarding).toBe(true);
  expect(state.bypassPermissionsModeAccepted).toBe(true);
  expect(state.projects["/existing"]).toEqual({ hasTrustDialogAccepted: true, custom: "kept" });
  expect(state.projects["/repo/worktree"]).toMatchObject({
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  });
  expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
});

test("Codex spawn prompts carry the Viewer lineage fence", () => {
  expect(fenceViewerSpawnPrompt("codex", "Implement the change")).toBe(`Implement the change\n\n${VIEWER_SPAWN_PROMPT_FENCE}`);
  expect(fenceViewerSpawnPrompt("claude", "Implement the change")).toBe("Implement the change");
});
