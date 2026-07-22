import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cli-account-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
const OLD_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const { freshSpecFor, resumeSpecFor, withSpawnCapability } = await import("./cli");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  if (OLD_CLAUDE_HOME === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = OLD_CLAUDE_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("fresh Codex commands fix CODEX_HOME in the typed shell command", () => {
  const home = path.join(SANDBOX, "account with space");
  const spec = freshSpecFor("codex", "/repo", { codexHome: home });

  expect(spec.command).toStartWith(`env -u LLV_TOKEN CODEX_HOME='${home}' `);
  expect(spec.command).toContain("codex");
  expect(spec.command).toContain("'--disable' 'multi_agent'");
  expect(spec.launchProfile?.allowSubagents).toBe(false);
});

test("fresh tmux Codex commands enforce the normalized MCP allowlist at runtime", () => {
  const home = path.join(SANDBOX, "codex-mcp-runtime");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), [
    "[mcp_servers.viewer]",
    'command = "viewer-mcp"',
    "[mcp_servers.agent-browser]",
    'command = "browser-mcp"',
    "[mcp_servers.unrelated]",
    'command = "unrelated-mcp"',
    "",
  ].join("\n"));

  const spec = freshSpecFor("codex", "/repo", {
    codexHome: home,
    mcpServers: ["agent-browser"],
  });

  expect(spec.command).toContain("'mcp_servers.viewer.enabled=true'");
  expect(spec.command).toContain("'mcp_servers.agent-browser.enabled=true'");
  expect(spec.command).toContain("'mcp_servers.unrelated.enabled=false'");
  expect(spec.launchProfile?.mcpServers).toEqual(["viewer", "agent-browser"]);
});

test("fresh tmux Codex defaults disable every configured server outside Viewer", () => {
  const home = path.join(SANDBOX, "codex-mcp-default");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), [
    "[mcp_servers.viewer]",
    'command = "viewer-mcp"',
    "[mcp_servers.agent-browser]",
    'command = "browser-mcp"',
    "",
  ].join("\n"));

  const spec = freshSpecFor("codex", "/repo", { codexHome: home });

  expect(spec.command).toContain("'mcp_servers.viewer.enabled=true'");
  expect(spec.command).toContain("'mcp_servers.agent-browser.enabled=false'");
  expect(spec.launchProfile?.mcpServers).toEqual(["viewer"]);
});

test("tmux Codex enumerates MCP servers from the launched working directory", () => {
  const home = path.join(SANDBOX, "codex-mcp-cwd");
  const cwd = path.join(SANDBOX, "codex-project");
  const binary = path.join(SANDBOX, "codex-mcp-list-cwd");
  const marker = path.join(SANDBOX, "codex-mcp-list.pwd");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), "[mcp_servers.viewer]\ncommand = \"viewer-mcp\"\n");
  fs.writeFileSync(binary, `#!/bin/sh\npwd > ${JSON.stringify(marker)}\nprintf '[{"name":"viewer"},{"name":"project-sentinel"}]'\n`);
  fs.chmodSync(binary, 0o755);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    const spec = freshSpecFor("codex", cwd, { codexHome: home });
    expect(fs.readFileSync(marker, "utf8").trim()).toBe(cwd);
    expect(spec.command).toContain("'mcp_servers.project-sentinel.enabled=false'");
  } finally {
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
});

test("tmux Codex fails closed when fallback cannot enumerate an inline MCP table", () => {
  const home = path.join(SANDBOX, "codex-mcp-inline");
  const binary = path.join(SANDBOX, "codex-mcp-list-failure");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), [
    "[mcp_servers.viewer]",
    'command = "viewer-mcp"',
    'mcp_servers = { hidden = { command = "hidden-mcp" } }',
    "",
  ].join("\n"));
  fs.writeFileSync(binary, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(binary, 0o755);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    expect(() => freshSpecFor("codex", "/repo", { codexHome: home })).toThrow("could not be enumerated safely");
  } finally {
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
});

test("fresh tmux Claude uses its exclusive native MCP file", () => {
  const home = path.join(SANDBOX, "claude-mcp-runtime");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: {
      viewer: { type: "stdio", command: "viewer-mcp" },
      "agent-browser": { type: "stdio", command: "browser-mcp" },
      unrelated: { type: "stdio", command: "unrelated-mcp" },
    },
  }));

  const spec = freshSpecFor("claude", "/repo", {
    claudeConfigDir: home,
    claudeProjectsDir: path.join(home, "projects"),
    mcpServers: ["agent-browser"],
  });
  const sessionId = path.basename(spec.transcript!, ".jsonl");
  const mcpConfigPath = path.join(home, ".llv", "spawn-mcp", `${sessionId}.json`);

  expect(spec.command).toContain(`'--strict-mcp-config' '--mcp-config' '${mcpConfigPath}'`);
  expect(JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"))).toEqual({ mcpServers: {
    viewer: { type: "stdio", command: "viewer-mcp" },
    "agent-browser": { type: "stdio", command: "browser-mcp" },
  } });
  expect(spec.launchProfile?.mcpServers).toEqual(["viewer", "agent-browser"]);
});

test("allowSubagents enables Codex multi-agent for fresh and resumed launches", () => {
  const transcript = path.join(SANDBOX, "legacy", "sessions", "2026", "07", "14", "rollout-019f5f2f-743a-7f23-7773-3cf2dd4b4168.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: SANDBOX } }) + "\n");

  const fresh = freshSpecFor("codex", "/repo", { allowSubagents: true });
  const resumed = resumeSpecFor("codex-sessions", transcript, { allowSubagents: true });

  expect(fresh.command).not.toContain("--disable");
  expect(fresh.launchProfile?.allowSubagents).toBe(true);
  expect(resumed?.command).not.toContain("--disable multi_agent");
  expect(resumed?.launchProfile?.allowSubagents).toBe(true);
});

test("Viewer spawn capability is scoped into the launched agent command", () => {
  const capability = "A".repeat(43);
  const spec = withSpawnCapability(freshSpecFor("codex", "/repo"), capability);

  expect(spec.command).toStartWith(`env LLV_SPAWN_CAPABILITY='${capability}' `);
  expect(spec.launchProfile?.cwd).toBe("/repo");
});

test("Claude commands do not gain Codex environment assignments", () => {
  const spec = freshSpecFor("claude", "/repo", { codexHome: path.join(SANDBOX, "unused") });

  expect(spec.command).not.toContain("CODEX_HOME=");
});

test("fresh read-only Claude commands accept a non-interactive permission mode", () => {
  const spec = freshSpecFor("claude", "/repo", { readOnly: true, permissionMode: "dontAsk" });

  expect(spec.command).toContain("'--permission-mode' 'dontAsk'");
  expect(spec.command).toContain("'--disallowedTools' 'Edit,Write,NotebookEdit'");
  expect(spec.launchProfile).toMatchObject({ readOnly: true, permissionMode: "dontAsk" });
});

test("Codex resume derives its owning account home from the transcript path", () => {
  const transcript = path.join(SANDBOX, "legacy", "sessions", "2026", "07", "09", "rollout-019f423a-d6e9-7903-7597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: SANDBOX } }) + "\n");
  fs.writeFileSync(path.join(SANDBOX, "legacy", "config.toml"), [
    "[mcp_servers.viewer]",
    'command = "viewer-mcp"',
    "[mcp_servers.unrelated]",
    'command = "unrelated-mcp"',
    "",
  ].join("\n"));

  const spec = resumeSpecFor("codex-sessions", transcript);

  expect(spec?.command).toStartWith(
    `env -u LLV_TOKEN CODEX_HOME='${path.join(SANDBOX, "legacy")}' `,
  );
  expect(spec?.command).toContain("'mcp_servers.viewer.enabled=true'");
  expect(spec?.command).toContain("'mcp_servers.unrelated.enabled=false'");
  expect(spec?.command).toContain("--disable multi_agent");
  expect(spec?.command).toContain("resume 019f423a-d6e9-7903-7597-3e676b6ff3d4");
});

test("resume preserves the transcript model and reasoning effort for both engines", () => {
  const codexTranscript = path.join(SANDBOX, "legacy", "sessions", "2026", "07", "09", "rollout-019f423a-d6e9-7903-7597-3e676b6ff3d4.jsonl");
  const claudeTranscript = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "-repo", "019f423a-d6e9-7903-7597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(claudeTranscript), { recursive: true });
  fs.writeFileSync(claudeTranscript, JSON.stringify({ cwd: SANDBOX }) + "\n");
  const codex = resumeSpecFor("codex-sessions", codexTranscript, { model: "gpt-5.6-terra", effort: "xhigh" });
  const claude = resumeSpecFor("claude-projects", claudeTranscript, {
    model: "opus",
    effort: "max",
  });

  expect(codex?.command).toContain("-m 'gpt-5.6-terra'");
  expect(codex?.command).toContain("model_reasoning_effort=xhigh");
  expect(codex?.command).toContain("CODEX_HOME='");
  expect(claude?.command).toContain("'--model' 'opus'");
  expect(claude?.command).toContain("'--effort' 'max'");
  expect(claude?.command).toContain("'--dangerously-skip-permissions'");
  expect(claude?.launchProfile).toMatchObject({ permissionMode: "bypassPermissions" });
});

test("resume preserves read-only execution policy for both engines", () => {
  const codexTranscript = path.join(SANDBOX, "legacy", "sessions", "2026", "07", "09", "rollout-019f423a-d6e9-7903-7597-3e676b6ff3d4.jsonl");
  const claudeTranscript = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "-repo", "019f423a-d6e9-7903-7597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(claudeTranscript), { recursive: true });
  fs.writeFileSync(claudeTranscript, JSON.stringify({ cwd: SANDBOX }) + "\n");

  const codex = resumeSpecFor("codex-sessions", codexTranscript, { readOnly: true, permissionMode: "never" });
  const claude = resumeSpecFor("claude-projects", claudeTranscript, { readOnly: true, permissionMode: "plan" });

  expect(codex?.command).toContain("--sandbox read-only");
  expect(codex?.command).toContain("--ask-for-approval 'never'");
  expect(codex?.launchProfile).toMatchObject({ readOnly: true, permissionMode: "never" });
  expect(claude?.command).toContain("'--permission-mode' 'plan' '--disallowedTools' 'Edit,Write,NotebookEdit'");
  expect(claude?.command).not.toContain("'--dangerously-skip-permissions'");
  expect(claude?.launchProfile).toMatchObject({ readOnly: true, permissionMode: "plan" });
});

test("Claude resume normalizes transcript families and omits unknown model overrides", () => {
  const transcript = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "-repo", "019f423a-d6e9-7903-7597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ cwd: SANDBOX }) + "\n");

  expect(resumeSpecFor("claude-projects", transcript, { model: "claude-fable-20260701" })?.command)
    .toContain("'--model' 'fable'");
  expect(resumeSpecFor("claude-projects", transcript, { model: "mythos-1" })?.command)
    .not.toContain("'--model'");
});

test("managed Codex commands pin file-backed credential storage", () => {
  const account = createManagedCodexAccount("Review");
  const fresh = freshSpecFor("codex", "/repo", { codexHome: account.home, model: "gpt-5" });
  const transcript = path.join(account.sessionsDir, "2026", "07", "09", "rollout-019f423a-d6e9-7903-7597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: SANDBOX } }) + "\n");

  expect(fresh.command).toContain("cli_auth_credentials_store=file");
  expect(resumeSpecFor("codex-sessions", transcript)?.command).toContain("cli_auth_credentials_store=file");
  expect(fresh.command.indexOf("cli_auth_credentials_store=file")).toBeLessThan(fresh.command.indexOf("gpt-5"));
  const resumed = resumeSpecFor("codex-sessions", transcript)?.command ?? "";
  expect(resumed.indexOf("cli_auth_credentials_store=file")).toBeLessThan(resumed.indexOf("resume"));
});

test("managed Claude fresh and resume commands pin the transcript owner and scrub shadowing env", () => {
  const account = createManagedClaudeAccount("Claude Work");
  const fresh = freshSpecFor("claude", "/repo", { claudeConfigDir: account.home, claudeProjectsDir: account.projectsDir });
  const transcript = fresh.transcript!;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ cwd: SANDBOX }) + "\n");
  expect(transcript.startsWith(account.projectsDir + path.sep)).toBe(true);
  expect(fresh.command).toContain("CLAUDE_CONFIG_DIR=");
  expect(fresh.command).toContain("-u ANTHROPIC_API_KEY");
  expect(fresh.command).toContain("-u LLV_TOKEN");
  const sid = path.basename(transcript, ".jsonl");
  const settingsPath = path.join(account.home, ".llv", "spawn-settings", `${sid}.json`);
  expect(fresh.command).toContain(`'--settings' '${settingsPath}'`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
  };
  expect(settings.hooks.PreToolUse.some((group) => group.matcher === "Task|Agent|Workflow|TeamCreate|TeamDelete|SendMessage")).toBe(true);
  const resumed = resumeSpecFor("claude-projects", transcript)?.command ?? "";
  expect(resumed).toContain(`CLAUDE_CONFIG_DIR='${account.home}'`);
  expect(resumed).toContain(`'--strict-mcp-config' '--mcp-config' '${path.join(account.home, ".llv", "spawn-mcp", `resume-${sid}.json`)}'`);
  expect(resumed).toContain("--resume");
});

test("allowSubagents leaves a managed Claude fresh spawn without the Viewer hook", () => {
  const account = createManagedClaudeAccount("Claude Orchestrator");

  const fresh = freshSpecFor("claude", "/repo", {
    claudeConfigDir: account.home,
    claudeProjectsDir: account.projectsDir,
    allowSubagents: true,
  });
  const sid = path.basename(fresh.transcript!, ".jsonl");
  const settings = JSON.parse(fs.readFileSync(path.join(account.home, ".llv", "spawn-settings", `${sid}.json`), "utf8")) as {
    hooks: { PreToolUse: unknown[] };
  };

  expect(settings.hooks.PreToolUse).toEqual([]);
  fs.mkdirSync(path.dirname(fresh.transcript!), { recursive: true });
  fs.writeFileSync(fresh.transcript!, JSON.stringify({ cwd: "/repo" }) + "\n");
  resumeSpecFor("claude-projects", fresh.transcript!, { allowSubagents: true });
  const resumedSettings = JSON.parse(fs.readFileSync(
    path.join(account.home, ".llv", "spawn-settings", `resume-${sid}.json`),
    "utf8",
  )) as { hooks: { PreToolUse: unknown[] } };
  expect(resumedSettings.hooks.PreToolUse).toEqual([]);
});

test("deferred Claude policy planning leaves disk unchanged before route admission", () => {
  const account = createManagedClaudeAccount("Claude Deferred");

  const fresh = freshSpecFor("claude", "/repo", {
    claudeConfigDir: account.home,
    claudeProjectsDir: account.projectsDir,
    deferClaudeSpawnPolicy: true,
  });
  const sid = path.basename(fresh.transcript!, ".jsonl");

  expect(fresh.command).toContain(path.join(account.home, ".llv", "spawn-settings", `${sid}.json`));
  expect(fs.existsSync(path.join(account.home, ".llv"))).toBe(false);
});
