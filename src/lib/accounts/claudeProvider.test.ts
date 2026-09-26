import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-provider-test-"));
const oldState = process.env.LLV_STATE_DIR;
const oldHome = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "main");

const accounts = await import("./claude");
const { accountManager } = await import("./manager");
const { freshSpecFor, resumeSpecForSession, resolveBinary } = await import("@/lib/agent/cli");
const { claudeStructuredHostOptions } = await import("@/lib/runtime/structuredSpawn");
const { selectHealthyClaudeAccount } = await import("./spawnHealth");
const { readClaudeAccountLimits } = await import("@/lib/limits");

const token = "local-provider-fixture-token";
const provider = { baseUrl: "http://127.0.0.1:9876", model: "model-large", smallFastModel: "model-small" };

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "accounts"), { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "shared"), { recursive: true, force: true });
});
afterAll(() => {
  if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
  if (oldHome === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = oldHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("provider account token is private and scoped through manager and production launch builders", async () => {
  const added = accounts.createManagedClaudeAccount("Provider", { config: provider, token });
  const oauth = accounts.createManagedClaudeAccount("OAuth");
  expect(fs.statSync(path.join(added.home, ".provider-token")).mode & 0o777).toBe(0o600);
  expect(accounts.listClaudeAccounts().find((account) => account.id === added.id)).toMatchObject({ authPresent: true, provider });
  expect(JSON.stringify(accounts.listClaudeAccounts())).not.toContain(token);
  expect(JSON.stringify(await accountManager.list())).not.toContain(token);

  const context = accountManager.resolveSpawn("claude", added.id);
  const other = accountManager.resolveSpawn("claude", oauth.id);
  expect(context.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
  expect(context.env.ANTHROPIC_BASE_URL).toBe(provider.baseUrl);
  expect(other.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(other.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(other.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(accounts.claudeManagedEnvironment(oauth.home, { NODE_ENV: "test", ANTHROPIC_MODEL: "operator-choice", ANTHROPIC_AUTH_TOKEN: "inherited" }).ANTHROPIC_MODEL).toBe("operator-choice");

  const fresh = freshSpecFor("claude", sandbox, { claudeConfigDir: added.home, model: "opus" });
  if (!fresh.launchProfile) throw new Error("fresh launch profile missing");
  const resumed = resumeSpecForSession("claude", "12345678-1234-1234-1234-123456789abc", sandbox, added.home, { model: "haiku" });
  expect(fresh.command).toContain("model-large");
  expect(resumed?.command).toContain("model-small");
  expect(fresh.command).not.toContain(token);
  expect(resumed?.command).not.toContain(token);
  expect(fresh.command).toContain(".provider-token");
  expect(freshSpecFor("claude", sandbox, { claudeConfigDir: oauth.home }).command).not.toContain("-u ANTHROPIC_MODEL");
  const mcpConfigPath = fresh.command.match(/'--mcp-config' '([^']+)'/)?.[1];
  expect(mcpConfigPath).toBeTruthy();
  expect(fs.readFileSync(mcpConfigPath!, "utf8")).not.toContain(token);

  const launch = claudeStructuredHostOptions({ spec: fresh, account: context }, { env: context.env, host: {} });
  const resumeLaunch = claudeStructuredHostOptions({ spec: { ...fresh, launchProfile: { ...fresh.launchProfile, model: "haiku" } }, account: context }, { env: context.env, host: {} });
  const oauthLaunch = claudeStructuredHostOptions({ spec: fresh, account: other }, { env: other.env, host: {} });
  expect(launch).toMatchObject({ providerAccount: true, model: "model-large", claudeConfigDir: added.home });
  expect(launch.mcpServers).toContain("viewer");
  expect(resumeLaunch).toMatchObject({ providerAccount: true, model: "model-small" });
  expect(oauthLaunch).toMatchObject({ providerAccount: false, model: "opus" });
  expect(JSON.stringify({ ...launch, env: undefined })).not.toContain(token);
});

test("provider edits rotate the private token while keeping public configuration secret-free", () => {
  const added = accounts.createManagedClaudeAccount("Provider", { config: provider, token });
  const edited = accounts.updateProviderClaudeAccount(added.id, { ...provider, model: "next-model", smallFastModel: null }, "rotated-fixture-token", "Renamed");
  expect(edited).toMatchObject({ label: "Renamed", authPresent: true, provider: { model: "next-model", smallFastModel: null } });
  expect(accounts.readClaudeProviderToken(added.home)).toBe("rotated-fixture-token");
  expect(fs.statSync(path.join(added.home, ".provider-token")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(accounts.listClaudeAccounts())).not.toContain("rotated-fixture-token");
});

test("tmux command reads the token into the Claude environment without placing it in the command", () => {
  const account = accounts.createManagedClaudeAccount("Provider", { config: provider, token });
  const fakeHome = path.join(sandbox, "fake-home");
  const binary = path.join(fakeHome, ".bun", "bin", "claude");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\n[ \"$ANTHROPIC_AUTH_TOKEN\" = \"$EXPECTED_TOKEN\" ] && [ \"$ANTHROPIC_MODEL\" = model-large ]\n", { mode: 0o700 });
  const command = freshSpecFor("claude", sandbox, { claudeConfigDir: account.home, model: "opus" }).command
    .replace(`'${resolveBinary("claude")}'`, `'${binary}'`);
  expect(command).not.toContain(token);
  expect(command).toContain("sh -c");
  expect(command).toContain(binary);
  const result = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: fakeHome, EXPECTED_TOKEN: token }, cwd: sandbox });
  expect({ status: result.status, stderr: result.stderr.toString() }).toEqual({ status: 0, stderr: "" });
});

test("provider health admits unknown limits and reports its own authentication failure", async () => {
  let status = 200;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return status === 200 ? Response.json({ data: [{ id: "model-large" }] }) : new Response(null, { status });
  } });
  try {
    const account = accounts.createManagedClaudeAccount("Provider", {
      config: { ...provider, baseUrl: `http://127.0.0.1:${server.port}` }, token,
    });
    const healthy = await selectHealthyClaudeAccount([account], account.id);
    expect(healthy.account.id).toBe(account.id);
    expect(healthy.admission).toMatchObject({ kind: "admissible" });
    expect(await readClaudeAccountLimits(account)).toMatchObject({ data: null, provenance: { reason: "provider limits unknown" } });
    status = 401;
    await expect(selectHealthyClaudeAccount([account], account.id)).rejects.toThrow("Check the provider token for Provider");
  } finally { server.stop(); }
});
