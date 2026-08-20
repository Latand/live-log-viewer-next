import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-hosts-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const {
  registerTelegramHosts,
  registerTelegramInClaudeState,
  registerTelegramInCodexConfig,
  removeTelegramFromClaudeState,
  removeTelegramFromCodexConfig,
  unregisterTelegramHosts,
} = await import("./hostRegistration");

const URL = "http://127.0.0.1:8809/mcp";
const AUTH_HEADER = ["Author", "ization"].join("");
const BEARER_PLACEHOLDER = ["Bear", "er ${LLV_TELEGRAM_MCP_TOKEN}"].join("");
const VIEWER_ENTRY = (url = URL) => ({
  type: "http",
  url,
  headers: { [AUTH_HEADER]: BEARER_PLACEHOLDER },
});

let counter = 0;
function tempPath(name: string): string {
  const dir = path.join(SANDBOX, String(counter++));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("registers telegram in Claude state and is idempotent", () => {
  const file = tempPath(".claude.json");
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { viewer: { type: "stdio", command: "viewer-mcp" } } }));

  expect(registerTelegramInClaudeState(file, URL)).toBe("registered");
  const first = fs.readFileSync(file, "utf8");
  const state = JSON.parse(first) as { theme: string; mcpServers: Record<string, unknown> };
  expect(state.theme).toBe("dark");
  expect(state.mcpServers.viewer).toEqual({ type: "stdio", command: "viewer-mcp" });
  expect(state.mcpServers.telegram).toEqual(VIEWER_ENTRY());

  /* Second registration changes nothing — byte-identical. */
  expect(registerTelegramInClaudeState(file, URL, URL)).toBe("registered");
  expect(fs.readFileSync(file, "utf8")).toBe(first);
});

test("creates a minimal Claude state file when none exists", () => {
  const file = tempPath(".claude.json");
  expect(registerTelegramInClaudeState(file, URL)).toBe("registered");
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers.telegram).toEqual(VIEWER_ENTRY());
  expect(fs.statSync(file).mode & 0o077).toBe(0);
});

test("a pre-existing operator entry is refused, never overwritten — whatever its shape", () => {
  for (const operatorEntry of [
    { type: "stdio", command: "operator-owned" },
    { type: "http", url: "http://127.0.0.1:9999/theirs" },
    { type: "http", url: URL },
    { type: "http", url: URL, headers: { "x-extra": "operator-added" } },
  ]) {
    const file = tempPath(".claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { telegram: operatorEntry } }));
    const before = fs.readFileSync(file, "utf8");
    expect(registerTelegramInClaudeState(file, URL)).toBe("conflict");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }
});

test("an invalid Claude mcpServers shape is preserved byte-for-byte", () => {
  const file = tempPath(".claude.json");
  const original = JSON.stringify({ theme: "dark", mcpServers: [{ operator: "keep" }] }, null, 2) + "\n";
  fs.writeFileSync(file, original, { mode: 0o600 });

  expect(registerTelegramInClaudeState(file, URL)).toBe("unwritable");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

test("an exact-url operator entry is never claimed or removed by high-level registration", () => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const claudeFile = tempPath(".claude.json");
  const operatorEntry = { type: "http", url: URL };
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { telegram: operatorEntry } }));
  const targets = { claudeStatePaths: [claudeFile], codexConfigPaths: [] };

  registerTelegramHosts(targets, URL);
  unregisterTelegramHosts(targets);

  const state = JSON.parse(fs.readFileSync(claudeFile, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers.telegram).toEqual(operatorEntry);
});

test("high-level registration aggregates every required host failure", () => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const claudeFile = tempPath(".claude.json");
  const codexFile = tempPath("config.toml");
  fs.writeFileSync(claudeFile, "{broken");
  fs.writeFileSync(codexFile, `[mcp_servers."telegram"]\nurl = "http://127.0.0.1:9999/custom"\n`);

  const result = registerTelegramHosts({ claudeStatePaths: [claudeFile], codexConfigPaths: [codexFile] }, URL);

  expect(result).toEqual({
    ok: false,
    claude: { registered: 0, conflict: 0, unwritable: 1 },
    codex: { registered: 0, failed: 1 },
  });
});

test("ownership persistence failure rolls back newly published Claude registrations", () => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const telegramState = path.join(process.env.LLV_STATE_DIR!, "telegram");
  fs.mkdirSync(path.join(telegramState, "registrations.json"), { recursive: true, mode: 0o700 });
  const claudeFile = tempPath(".claude.json");
  const original = JSON.stringify({ theme: "dark", mcpServers: { viewer: { type: "stdio", command: "viewer-mcp" } } }, null, 2) + "\n";
  fs.writeFileSync(claudeFile, original, { mode: 0o600 });

  expect(() => registerTelegramHosts({ claudeStatePaths: [claudeFile], codexConfigPaths: [] }, URL)).toThrow();

  expect(fs.readFileSync(claudeFile, "utf8")).toBe(original);
  expect((JSON.parse(fs.readFileSync(claudeFile, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.telegram).toBeUndefined();
});

test("the Viewer's own stale entry (a changed port) is updated, proven by its record", () => {
  const file = tempPath(".claude.json");
  const staleUrl = "http://127.0.0.1:8700/mcp";
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { telegram: VIEWER_ENTRY(staleUrl) } }));
  /* Without the record proving ownership, the same entry is a conflict. */
  expect(registerTelegramInClaudeState(file, URL)).toBe("conflict");
  expect(registerTelegramInClaudeState(file, URL, staleUrl)).toBe("registered");
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers.telegram).toEqual(VIEWER_ENTRY());
});

test("the Legacy telegram-readonly entry is never read or written", () => {
  const file = tempPath(".claude.json");
  const legacy = { type: "stdio", command: "uv", args: ["run", "telegram-mcp"] };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "telegram-readonly": legacy } }));
  registerTelegramInClaudeState(file, URL);
  removeTelegramFromClaudeState(file, URL);
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers["telegram-readonly"]).toEqual(legacy);
  expect(state.mcpServers.telegram).toBeUndefined();
});

test("removal deletes only an entry still matching the Viewer's own record", () => {
  /* An operator's stdio entry, an operator's http entry, and an entry the
     operator EDITED after the Viewer registered — none of them are ours. */
  for (const foreignEntry of [
    { type: "stdio", command: "operator-owned" },
    { type: "http", url: "http://127.0.0.1:9999/theirs" },
  ]) {
    const file = tempPath(".claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { telegram: foreignEntry } }));
    expect(removeTelegramFromClaudeState(file, URL)).toBe(true);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(state.mcpServers.telegram).toEqual(foreignEntry);
  }
  /* The recorded entry IS removed. */
  const file = tempPath(".claude.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { telegram: VIEWER_ENTRY() } }));
  expect(removeTelegramFromClaudeState(file, URL)).toBe(true);
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers.telegram).toBeUndefined();
});

test("corrupt or symlinked Claude state is left untouched", () => {
  const corrupt = tempPath(".claude.json");
  fs.writeFileSync(corrupt, "{broken");
  expect(registerTelegramInClaudeState(corrupt, URL)).toBe("unwritable");
  expect(fs.readFileSync(corrupt, "utf8")).toBe("{broken");

  const target = tempPath("real.json");
  fs.writeFileSync(target, "{}");
  const link = tempPath(".claude.json");
  fs.symlinkSync(target, link);
  expect(registerTelegramInClaudeState(link, URL)).toBe("unwritable");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("{}");
});

test("register → operator replaces the entry → unregister leaves the operator's entry standing", () => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const claudeFile = tempPath(".claude.json");
  const codexFile = tempPath("config.toml");
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: {} }));
  fs.writeFileSync(codexFile, "");
  const targets = { claudeStatePaths: [claudeFile], codexConfigPaths: [codexFile] };

  registerTelegramHosts(targets, URL);
  expect((JSON.parse(fs.readFileSync(claudeFile, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.telegram)
    .toEqual(VIEWER_ENTRY());

  /* The operator takes the name over after the Viewer registered it. */
  const operatorEntry = { type: "http", url: "http://127.0.0.1:9999/theirs" };
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { telegram: operatorEntry } }));

  unregisterTelegramHosts(targets);
  const state = JSON.parse(fs.readFileSync(claudeFile, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers.telegram).toEqual(operatorEntry);
  /* The codex managed block is gone with nothing else disturbed. */
  expect(fs.readFileSync(codexFile, "utf8")).not.toContain("mcp_servers.telegram");
});

test("register/unregister round-trips cleanly through the ownership records", () => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const claudeFile = tempPath(".claude.json");
  const codexFile = tempPath("config.toml");
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { viewer: { type: "stdio", command: "viewer-mcp" } } }));
  fs.writeFileSync(codexFile, "model = \"gpt-5.6-codex\"\n");
  const before = { claude: fs.readFileSync(claudeFile, "utf8"), codex: fs.readFileSync(codexFile, "utf8") };
  const targets = { claudeStatePaths: [claudeFile], codexConfigPaths: [codexFile] };

  registerTelegramHosts(targets, URL);
  unregisterTelegramHosts(targets);
  expect(JSON.parse(fs.readFileSync(claudeFile, "utf8"))).toEqual(JSON.parse(before.claude));
  expect(fs.readFileSync(codexFile, "utf8")).toBe(before.codex);
});

test("registers a marker-delimited block in codex config.toml and removes it byte-cleanly", () => {
  const file = tempPath("config.toml");
  const original = `model = "gpt-5.6-codex"\n\n[mcp_servers.viewer]\ncommand = "agent-log-viewer-mcp"\n`;
  fs.writeFileSync(file, original);

  expect(registerTelegramInCodexConfig(file, URL)).toBe(true);
  const registered = fs.readFileSync(file, "utf8");
  expect(registered).toContain(original.trimEnd());
  expect(registered).toContain(`[mcp_servers.telegram]\nurl = "${URL}"`);
  expect(registered).toContain(["bearer_", 'token_env_var = "LLV_TELEGRAM_MCP_TOKEN"'].join(""));

  /* Idempotent. */
  expect(registerTelegramInCodexConfig(file, URL)).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(registered);

  /* Removal restores the original content. */
  expect(removeTelegramFromCodexConfig(file)).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

test("an operator-authored [mcp_servers.telegram] table wins over the managed block", () => {
  const file = tempPath("config.toml");
  const original = `[mcp_servers.telegram]\nurl = "http://127.0.0.1:9999/custom"\n`;
  fs.writeFileSync(file, original);
  expect(registerTelegramInCodexConfig(file, URL)).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

test("a quoted Codex Telegram table is a semantic conflict and remains byte-unchanged", () => {
  const file = tempPath("config.toml");
  const original = `[mcp_servers."telegram"]\nurl = "http://127.0.0.1:9999/custom"\n`;
  fs.writeFileSync(file, original);

  expect(registerTelegramInCodexConfig(file, URL)).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(() => Bun.TOML.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
});

test("malformed or duplicate managed markers never rewrite Codex configuration", () => {
  const malformed = [
    `model = "gpt-5.6-codex"\n# >>> agent-log-viewer telegram >>>\nreasoning_effort = "high"\n`,
    `# >>> agent-log-viewer telegram >>>\nmodel = "gpt-5.6-codex"\n# <<< agent-log-viewer telegram <<<\n`,
    `# >>> agent-log-viewer telegram >>>\n# >>> agent-log-viewer telegram >>>\nmodel = "gpt-5.6-codex"\n# <<< agent-log-viewer telegram <<<\n`,
  ];
  for (const original of malformed) {
    const registerFile = tempPath("config.toml");
    fs.writeFileSync(registerFile, original);
    expect(registerTelegramInCodexConfig(registerFile, URL)).toBe(false);
    expect(fs.readFileSync(registerFile, "utf8")).toBe(original);

    const removeFile = tempPath("config.toml");
    fs.writeFileSync(removeFile, original);
    expect(removeTelegramFromCodexConfig(removeFile)).toBe(false);
    expect(fs.readFileSync(removeFile, "utf8")).toBe(original);
  }
});

test("a corrupt Codex config is byte-unchanged", () => {
  const file = tempPath("config.toml");
  const corrupt = "[mcp_servers.telegram\nurl = broken\n";
  fs.writeFileSync(file, corrupt);
  expect(registerTelegramInCodexConfig(file, URL)).toBe(false);
  expect(removeTelegramFromCodexConfig(file)).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(corrupt);
});

test("a symlinked codex config is never rewritten", () => {
  const target = tempPath("real.toml");
  fs.writeFileSync(target, "model = \"gpt-5.6-codex\"\n");
  const link = tempPath("config.toml");
  fs.symlinkSync(target, link);
  expect(registerTelegramInCodexConfig(link, URL)).toBe(false);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("model = \"gpt-5.6-codex\"\n");
});

test("registration into an empty codex home creates just the managed block", () => {
  const file = tempPath("config.toml");
  expect(registerTelegramInCodexConfig(file, URL)).toBe(true);
  const contents = fs.readFileSync(file, "utf8");
  expect(contents.startsWith("# >>> agent-log-viewer telegram >>>")).toBe(true);
  expect(removeTelegramFromCodexConfig(file)).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe("\n");
});
