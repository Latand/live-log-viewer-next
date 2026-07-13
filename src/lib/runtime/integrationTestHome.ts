import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHILD_ENV_ALLOWLIST = [
  "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

interface IntegrationTestHome {
  directory: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export interface CodexIntegrationTestHome extends IntegrationTestHome {
  codexHome: string;
}

export interface ClaudeIntegrationTestHome extends IntegrationTestHome {
  claudeConfigDir: string;
  claudeProjectsDir: string;
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, NODE_ENV: process.env.NODE_ENV };
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function copyCredential(source: string, destination: string): boolean {
  try {
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
    return true;
  } catch {
    return false;
  }
}

function isChatGptCredential(filename: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
    return value.auth_mode === "chatgpt";
  } catch {
    return false;
  }
}

function cleanup(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

export function prepareCodexIntegrationTestHome(binary: string): CodexIntegrationTestHome | null {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-integration-"));
  fs.chmodSync(directory, 0o700);
  const codexHome = path.join(directory, ".codex");
  const sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sourceCredential = path.join(sourceHome, "auth.json");
  if (!isChatGptCredential(sourceCredential)
    || !copyCredential(sourceCredential, path.join(codexHome, "auth.json"))) {
    cleanup(directory);
    return null;
  }
  const env = { ...isolatedEnv(directory), CODEX_HOME: codexHome };
  const auth = spawnSync(binary, ["-c", "cli_auth_credentials_store=file", "login", "status"], {
    env,
    stdio: "ignore",
    timeout: 10_000,
  });
  if (auth.status !== 0) {
    cleanup(directory);
    return null;
  }
  return { directory, codexHome, env, cleanup: () => cleanup(directory) };
}

export function prepareClaudeIntegrationTestHome(binary: string): ClaudeIntegrationTestHome | null {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-integration-"));
  fs.chmodSync(directory, 0o700);
  const claudeConfigDir = path.join(directory, ".claude");
  const claudeProjectsDir = path.join(claudeConfigDir, "projects");
  const sourceConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  if (!copyCredential(path.join(sourceConfigDir, ".credentials.json"), path.join(claudeConfigDir, ".credentials.json"))) {
    cleanup(directory);
    return null;
  }
  fs.writeFileSync(
    path.join(directory, ".claude.json"),
    `${JSON.stringify({ hasCompletedOnboarding: true })}\n`,
    { mode: 0o600 },
  );
  const env = { ...isolatedEnv(directory), CLAUDE_CONFIG_DIR: claudeConfigDir };
  const version = spawnSync(binary, ["--version"], { env, stdio: "ignore", timeout: 10_000 });
  const auth = spawnSync(binary, ["auth", "status"], { env, encoding: "utf8", timeout: 10_000 });
  let status: Record<string, unknown> | null = null;
  try {
    status = JSON.parse(auth.stdout) as Record<string, unknown>;
  } catch {
    status = null;
  }
  if (version.status !== 0
    || auth.status !== 0
    || status?.loggedIn !== true
    || status.authMethod !== "claude.ai"
    || typeof status.subscriptionType !== "string") {
    cleanup(directory);
    return null;
  }
  return {
    directory,
    claudeConfigDir,
    claudeProjectsDir,
    env,
    cleanup: () => cleanup(directory),
  };
}

export function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
