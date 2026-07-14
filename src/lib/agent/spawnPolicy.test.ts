import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyClaudeSpawnPolicy, fenceViewerSpawnPrompt, NATIVE_SUBAGENT_DENY_MESSAGE, prepareManagedClaudeSpawnHome, VIEWER_SPAWN_PROMPT_FENCE } from "./spawnPolicy";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-policy-"));
  homes.push(directory);
  return directory;
}

test("Claude spawn policy installs a Task/Agent hook that denies with Viewer lineage guidance", async () => {
  const accountHome = home();

  const installed = applyClaudeSpawnPolicy(accountHome, { profileId: "denied" });
  const settings = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };

  expect(settings.hooks.PreToolUse).toContainEqual({
    matcher: "Task|Agent",
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
  expect(profile.hooks.PreToolUse.filter((group) => group.matcher === "Task|Agent")).toHaveLength(1);
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

  expect(denied.hooks.PreToolUse.some((group) => group.matcher === "Task|Agent")).toBe(true);
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
