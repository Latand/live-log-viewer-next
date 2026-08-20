import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-hosts-"));

const {
  registerTelegramInClaudeState,
  registerTelegramInCodexConfig,
  removeTelegramFromClaudeState,
  removeTelegramFromCodexConfig,
} = await import("./hostRegistration");

const URL = "http://127.0.0.1:8809/mcp";

let counter = 0;
function tempPath(name: string): string {
  const dir = path.join(SANDBOX, String(counter++));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

beforeEach(() => { /* per-test files come from tempPath */ });
afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("registers telegram in Claude state and is idempotent", () => {
  const file = tempPath(".claude.json");
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { viewer: { type: "stdio", command: "viewer-mcp" } } }));

  expect(registerTelegramInClaudeState(file, URL)).toBe(true);
  const first = fs.readFileSync(file, "utf8");
  const state = JSON.parse(first) as { theme: string; mcpServers: Record<string, unknown> };
  expect(state.theme).toBe("dark");
  expect(state.mcpServers.viewer).toEqual({ type: "stdio", command: "viewer-mcp" });
  expect(state.mcpServers.telegram).toEqual({ type: "http", url: URL });

  /* Second registration changes nothing — byte-identical. */
  expect(registerTelegramInClaudeState(file, URL)).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(first);
});

test("creates a minimal Claude state file when none exists", () => {
  const file = tempPath(".claude.json");
  expect(registerTelegramInClaudeState(file, URL)).toBe(true);
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers.telegram).toEqual({ type: "http", url: URL });
  expect(fs.statSync(file).mode & 0o077).toBe(0);
});

test("the Legacy telegram-readonly entry is never read or written", () => {
  const file = tempPath(".claude.json");
  const legacy = { type: "stdio", command: "uv", args: ["run", "telegram-mcp"] };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "telegram-readonly": legacy } }));
  registerTelegramInClaudeState(file, URL);
  removeTelegramFromClaudeState(file);
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers["telegram-readonly"]).toEqual(legacy);
  expect(state.mcpServers.telegram).toBeUndefined();
});

test("removal deletes only the Viewer-managed http entry", () => {
  const file = tempPath(".claude.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { telegram: { type: "stdio", command: "operator-owned" } } }));
  /* An operator's hand-written stdio server under the same name is not ours. */
  expect(removeTelegramFromClaudeState(file)).toBe(true);
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(state.mcpServers.telegram).toEqual({ type: "stdio", command: "operator-owned" });
});

test("corrupt or symlinked Claude state is left untouched", () => {
  const corrupt = tempPath(".claude.json");
  fs.writeFileSync(corrupt, "{broken");
  expect(registerTelegramInClaudeState(corrupt, URL)).toBe(false);
  expect(fs.readFileSync(corrupt, "utf8")).toBe("{broken");

  const target = tempPath("real.json");
  fs.writeFileSync(target, "{}");
  const link = tempPath(".claude.json");
  fs.symlinkSync(target, link);
  expect(registerTelegramInClaudeState(link, URL)).toBe(false);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("{}");
});

test("registers a marker-delimited block in codex config.toml and removes it byte-cleanly", () => {
  const file = tempPath("config.toml");
  const original = `model = "gpt-5.6-codex"\n\n[mcp_servers.viewer]\ncommand = "agent-log-viewer-mcp"\n`;
  fs.writeFileSync(file, original);

  expect(registerTelegramInCodexConfig(file, URL)).toBe(true);
  const registered = fs.readFileSync(file, "utf8");
  expect(registered).toContain(original.trimEnd());
  expect(registered).toContain(`[mcp_servers.telegram]\nurl = "${URL}"`);

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
  expect(registerTelegramInCodexConfig(file, URL)).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
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
