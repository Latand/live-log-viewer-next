import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAttachCommand } from "./attachCommand";
import type { FileEntry } from "@/lib/types";

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
const { saveTelegramSession, telegramConnectorTokenPath, telegramSessionPath } = await import("@/lib/telegram/sessionStore");

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
  fs.mkdirSync(home, { recursive: true });
  const spec = freshSpecFor("codex", SANDBOX, { codexHome: home });

  expect(spec.command).toStartWith(`env -u LLV_TOKEN -u LLV_TELEGRAM_MCP_TOKEN CODEX_HOME='${home}' `);
  expect(spec.command).toContain("codex");
  expect(spec.command).toContain("'--disable' 'multi_agent'");
  expect(spec.launchProfile?.allowSubagents).toBe(false);
});

test("Telegram grants load the connector token only into granted CLI processes", () => {
  const codexHome = path.join(SANDBOX, "telegram-token-codex");
  const claudeHome = path.join(SANDBOX, "telegram-token-claude");
  const binary = path.join(SANDBOX, "codex-telegram-list");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    "[mcp_servers.viewer]",
    'command = "viewer-mcp"',
    "[mcp_servers.telegram]",
    'url = "http://127.0.0.1:8809/mcp"',
    'bearer_token_env_var = "LLV_TELEGRAM_MCP_TOKEN"',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(claudeHome, ".claude.json"), JSON.stringify({
    mcpServers: {
      viewer: { type: "stdio", command: "viewer-mcp" },
      telegram: {
        type: "http",
        url: "http://127.0.0.1:8809/mcp",
        headers: { [["Author", "ization"].join("")]: ["Bear", "er ${LLV_TELEGRAM_MCP_TOKEN}"].join("") },
      },
    },
  }));
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"},{\"name\":\"telegram\"}]'\n");
  fs.chmodSync(binary, 0o755);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    const codexGranted = freshSpecFor("codex", SANDBOX, { codexHome, mcpServers: ["telegram"] });
    const claudeGranted = freshSpecFor("claude", SANDBOX, { claudeConfigDir: claudeHome, mcpServers: ["telegram"] });
    const codexDelegated = freshSpecFor("codex", SANDBOX, { codexHome });
    const claudeDelegated = freshSpecFor("claude", SANDBOX, { claudeConfigDir: claudeHome });

    for (const spec of [codexGranted, claudeGranted]) {
      expect(spec.command).toContain('LLV_TELEGRAM_MCP_TOKEN="$(');
      expect(spec.command).toContain("telegram-session-reader.mjs");
      expect(spec.launchProfile?.mcpServers).toEqual(["viewer", "telegram"]);
    }
    for (const spec of [codexDelegated, claudeDelegated]) {
      expect(spec.command).toContain("-u LLV_TELEGRAM_MCP_TOKEN");
      expect(spec.command).not.toContain("telegram-session-reader.mjs");
      expect(spec.launchProfile?.mcpServers).toEqual(["viewer"]);
    }

    const tokenPrefix = codexGranted.command.replace(/env -u LLV_TOKEN[\s\S]*$/, "true");
    const beforeEnrollment = Bun.spawnSync(["sh", "-c", tokenPrefix], {
      cwd: SANDBOX,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(beforeEnrollment.stderr.toString()).toBe("");
    expect(beforeEnrollment.exitCode).toBe(0);

    const tokenIsExported = () => {
      const probe = `${JSON.stringify(process.execPath)} -e 'process.exit(process.env.LLV_TELEGRAM_MCP_TOKEN ? 42 : 0)'`;
      const command = codexGranted.command.replace(/env -u LLV_TOKEN[\s\S]*$/, probe);
      return Bun.spawnSync(["sh", "-c", command], { cwd: SANDBOX, env: process.env, stdout: "pipe", stderr: "pipe" }).exitCode === 42;
    };

    fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
    saveTelegramSession("1ApWapzMBu4placeholder-not-a-real-session");
    expect(tokenIsExported()).toBe(true);

    const validSession = fs.readFileSync(telegramSessionPath());
    fs.rmSync(telegramSessionPath());
    expect(tokenIsExported()).toBe(false);

    fs.writeFileSync(telegramSessionPath(), "{broken", { mode: 0o600 });
    expect(tokenIsExported()).toBe(false);

    const externalSession = path.join(SANDBOX, "external-session.json");
    fs.writeFileSync(externalSession, validSession, { mode: 0o600 });
    fs.rmSync(telegramSessionPath());
    fs.symlinkSync(externalSession, telegramSessionPath());
    expect(tokenIsExported()).toBe(false);

    fs.rmSync(telegramSessionPath());
    fs.writeFileSync(telegramSessionPath(), validSession, { mode: 0o644 });
    expect(tokenIsExported()).toBe(false);

    fs.chmodSync(telegramSessionPath(), 0o600);
    fs.writeFileSync(telegramConnectorTokenPath(), "C".repeat(43) + "\n", { mode: 0o600 });
    expect(tokenIsExported()).toBe(false);
  } finally {
    fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
});

test("fresh tmux Codex commands enable only servers inside the grant bound", () => {
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

  const spec = freshSpecFor("codex", SANDBOX, {
    codexHome: home,
    mcpServers: ["agent-browser"],
  });

  /* A configured server outside the grant bound stays disabled however the
     allowlist names it (issue #739); Viewer is the only enabled surface. */
  expect(spec.command).toContain("'mcp_servers.viewer.enabled=true'");
  expect(spec.command).toContain("'mcp_servers.agent-browser.enabled=false'");
  expect(spec.command).toContain("'mcp_servers.unrelated.enabled=false'");
  expect(spec.launchProfile?.mcpServers).toEqual(["viewer"]);
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

  const spec = freshSpecFor("codex", SANDBOX, { codexHome: home });

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

test("fresh and resumed tmux Codex enumerate project and system MCP servers when user config is absent", () => {
  const home = process.env.LLV_CODEX_HOME!;
  const cwd = path.join(SANDBOX, "codex-project-only");
  const binary = path.join(SANDBOX, "codex-mcp-list-project-only");
  const marker = path.join(SANDBOX, "codex-mcp-list-project-only.called");
  fs.mkdirSync(home, { recursive: true });
  fs.rmSync(path.join(home, "config.toml"), { force: true });
  fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), [
    "[mcp_servers.project-sentinel]",
    'command = "project-mcp"',
    "",
  ].join("\n"));
  const transcript = path.join(home, "sessions", "2026", "07", "23", "rollout-019fa1b2-c3d4-0567-8899-aabbccddeeff.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n");
  fs.writeFileSync(binary, `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nprintf '[{"name":"project-sentinel"},{"name":"system-sentinel"}]'\n`);
  fs.chmodSync(binary, 0o755);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    const spec = freshSpecFor("codex", cwd, { codexHome: home });
    expect(fs.existsSync(marker)).toBeTrue();
    expect(spec.command).toContain("'mcp_servers.project-sentinel.enabled=false'");
    expect(spec.command).toContain("'mcp_servers.system-sentinel.enabled=false'");
    const resumed = resumeSpecFor("codex-sessions", transcript);
    expect(resumed?.command).toContain("'mcp_servers.project-sentinel.enabled=false'");
    expect(resumed?.command).toContain("'mcp_servers.system-sentinel.enabled=false'");
  } finally {
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
});

test("finding 1: attach enumerates MCP servers at the RECORDED project cwd even when the transcript head sniffs to $HOME", () => {
  const home = process.env.LLV_CODEX_HOME!;
  const project = path.join(SANDBOX, "finding1-recorded-project");
  const binary = path.join(SANDBOX, "codex-mcp-list-finding1");
  const marker = path.join(SANDBOX, "codex-mcp-list-finding1.pwd");
  fs.mkdirSync(home, { recursive: true });
  fs.rmSync(path.join(home, "config.toml"), { force: true });
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(home, "sessions", "2026", "07", "24", "rollout-019fa1b2-c3d4-0567-8899-aabbccddef01.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  /* EMPTY transcript head — no recorded cwd — so the resume spec's own sniff
     falls back to $HOME. The recorded project cwd must still drive enumeration. */
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: {} }) + "\n");
  /* The stub records the directory `codex mcp list` actually ran in, and reports
     one project-scoped server beyond viewer. */
  fs.writeFileSync(binary, `#!/bin/sh\npwd > ${JSON.stringify(marker)}\nprintf '[{"name":"viewer"},{"name":"project-sentinel"}]'\n`);
  fs.chmodSync(binary, 0o755);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    const file = {
      path: transcript, root: "codex-sessions", name: path.basename(transcript), project: "proj", title: "t",
      engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
      proc: null, pid: null, model: null, effort: null, fast: false, pendingQuestion: null, waitingInput: null,
      cwd: project,
    } as unknown as FileEntry;
    const res = resolveAttachCommand(transcript, {
      files: [file],
      resumeSpecFor,
      accountIdForPath: () => "terra",
      accountLabelFor: (engine, id) => `${id} · ${engine}`,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      /* Enumeration ran in the RECORDED project dir (finding 1). */
      expect(fs.realpathSync(fs.readFileSync(marker, "utf8").trim())).toBe(fs.realpathSync(project));
      expect(res.value.cwd).toBe(project);
      /* Every enumerated project server gets an explicit allowlist override: the
         default allowlist is viewer-only, so viewer is enabled and the project
         server is disabled — computed against the recorded-cwd enumeration. */
      expect(res.value.command).toContain("'mcp_servers.viewer.enabled=true'");
      expect(res.value.command).toContain("'mcp_servers.project-sentinel.enabled=false'");
    }
  } finally {
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
});

test("fresh and resumed tmux Codex fail closed when layered enumeration fails without user config", () => {
  const home = process.env.LLV_CODEX_HOME!;
  const cwd = path.join(SANDBOX, "codex-enumeration-failure");
  const binary = path.join(SANDBOX, "codex-mcp-list-no-user-failure");
  const transcript = path.join(home, "sessions", "2026", "07", "23", "rollout-019fa1b2-c3d4-0567-8899-aabbccddee00.jsonl");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.rmSync(path.join(home, "config.toml"), { force: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(binary, 0o755);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    expect(() => freshSpecFor("codex", cwd, { codexHome: home })).toThrow("could not be enumerated safely");
    expect(() => resumeSpecFor("codex-sessions", transcript)).toThrow("could not be enumerated safely");
  } finally {
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
});

test("tmux Codex rejects invalid native enumeration even when user config is locally parseable", () => {
  const home = path.join(SANDBOX, "codex-mcp-invalid-native-output");
  const binary = path.join(SANDBOX, "codex-mcp-list-invalid-output");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), [
    "[mcp_servers.viewer]",
    'command = "viewer-mcp"',
    "[mcp_servers.unrelated]",
    'command = "unrelated-mcp"',
    "",
  ].join("\n"));
  fs.writeFileSync(binary, "#!/bin/sh\nprintf invalid-json\n");
  fs.chmodSync(binary, 0o755);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    expect(() => freshSpecFor("codex", SANDBOX, { codexHome: home })).toThrow("could not be enumerated safely");
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

  /* The per-spawn file carries exactly the granted surface; a configured
     server the allowlist names but the bound excludes is not copied (#739). */
  expect(spec.command).toContain(`'--strict-mcp-config' '--mcp-config' '${mcpConfigPath}'`);
  expect(JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"))).toEqual({ mcpServers: {
    viewer: { type: "stdio", command: "viewer-mcp" },
  } });
  expect(spec.launchProfile?.mcpServers).toEqual(["viewer"]);
});

test("a resume rebuilds its command from the re-bounded grant, not the stored list", () => {
  const home = process.env.LLV_CLAUDE_HOME!;
  const transcript = path.join(home, "projects", "-repo", "019fa1b2-c3d4-0567-8899-aabbccddef77.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ cwd: SANDBOX }) + "\n");
  /* A legacy home keeps its MCP state beside the home directory, which is where
     the resume path reads the registered definitions from. */
  fs.writeFileSync(path.join(path.dirname(home), ".claude.json"), JSON.stringify({
    mcpServers: {
      viewer: { type: "stdio", command: "viewer-mcp" },
      slack: { type: "stdio", command: "slack-mcp" },
    },
  }));

  /* Launch profiles are durable and editable by hand, so a resume renders from
     the re-validated grant instead of throwing or trusting storage (#739). */
  const resumed = resumeSpecFor("claude-projects", transcript, {
    mcpServers: ["viewer", "slack"],
  });
  const mcpConfigPath = resumed!.command.match(/'--mcp-config' '([^']+)'/)![1]!;

  expect(resumed?.launchProfile?.mcpServers).toEqual(["viewer"]);
  expect(JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"))).toEqual({ mcpServers: {
    viewer: { type: "stdio", command: "viewer-mcp" },
  } });
});

test("allowSubagents enables Codex multi-agent for fresh and resumed launches", () => {
  const transcript = path.join(SANDBOX, "legacy", "sessions", "2026", "07", "14", "rollout-019f5f2f-743a-7f23-7773-3cf2dd4b4168.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: SANDBOX } }) + "\n");

  const fresh = freshSpecFor("codex", SANDBOX, { allowSubagents: true });
  const resumed = resumeSpecFor("codex-sessions", transcript, { allowSubagents: true });

  expect(fresh.command).not.toContain("--disable");
  expect(fresh.launchProfile?.allowSubagents).toBe(true);
  expect(resumed?.command).not.toContain("--disable multi_agent");
  expect(resumed?.launchProfile?.allowSubagents).toBe(true);
});

test("Viewer spawn capability is scoped into the launched agent command", () => {
  const capability = "A".repeat(43);
  const spec = withSpawnCapability(freshSpecFor("codex", SANDBOX), capability);

  expect(spec.command).toStartWith(`env LLV_SPAWN_CAPABILITY='${capability}' `);
  expect(spec.launchProfile?.cwd).toBe(SANDBOX);
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
    `env -u LLV_TOKEN -u LLV_TELEGRAM_MCP_TOKEN CODEX_HOME='${path.join(SANDBOX, "legacy")}' `,
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
  const fresh = freshSpecFor("codex", SANDBOX, { codexHome: account.home, model: "gpt-5" });
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

test("resolveHostBinary never emits the container nsenter shim", async () => {
  const { resolveHostBinary } = await import("./cli");
  const previous = process.env.LLV_DOCKER_NSENTER_SHIMS;
  process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  try {
    const resolved = resolveHostBinary("claude");
    expect(resolved.startsWith("/usr/local/bin/")).toBe(false);
    expect(resolved.startsWith("/usr/bin/")).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_DOCKER_NSENTER_SHIMS;
    else process.env.LLV_DOCKER_NSENTER_SHIMS = previous;
  }
});

test("a host-terminal resume spec resolves the CLI as the host, not the container shim", async () => {
  const { resumeSpecForSession } = await import("./cli");
  const account = createManagedClaudeAccount("host-terminal-probe");
  const previous = process.env.LLV_DOCKER_NSENTER_SHIMS;
  process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  try {
    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const inContainer = resumeSpecForSession("claude", sessionId, SANDBOX, account.home, {});
    const forHost = resumeSpecForSession("claude", sessionId, SANDBOX, account.home, { hostTerminal: true });
    expect(forHost).not.toBeNull();
    expect(inContainer).not.toBeNull();
    expect(forHost!.command.includes("/usr/local/bin/claude")).toBe(false);
    /* Same session, same flags — only the binary resolution differs. */
    expect(forHost!.command.includes(`--resume' '${sessionId}`)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.LLV_DOCKER_NSENTER_SHIMS;
    else process.env.LLV_DOCKER_NSENTER_SHIMS = previous;
  }
});
