import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configFilePath, statePath } from "@/lib/configDir";

/**
 * Packaging of the pinned Telegram MCP connector (issue #1059).
 *
 * The upstream source ships vendored under `vendor/telegram-mcp` (see its
 * PROVENANCE.md): the `telegram-mcp` PyPI name belongs to another project, so
 * nothing here ever resolves that name through an index. Provisioning builds a
 * Viewer-owned Python environment from the vendored tree with its own lock
 * (`uv sync --frozen`), and both the connector and the enrollment bridge run
 * from that environment — a clean installation needs no manually cloned
 * checkout.
 */

export const TELEGRAM_CONNECTOR_UPSTREAM = Object.freeze({
  repo: "https://github.com/chigwell/telegram-mcp",
  release: "v3.2.22",
  commit: "a61294362226bd93052f5a40b4a1b1269a99ce69",
  license: "Apache-2.0",
});

/** Loopback-only: the connector is never reachable off-host. */
export const TELEGRAM_MCP_HOST = "127.0.0.1";
const DEFAULT_TELEGRAM_MCP_PORT = 8809;

export function telegramMcpPort(): number {
  const raw = Number(process.env.LLV_TELEGRAM_MCP_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_TELEGRAM_MCP_PORT;
}

/** The shared streamable-HTTP endpoint both engines register as `telegram`. */
export function telegramMcpUrl(): string {
  return `http://${TELEGRAM_MCP_HOST}:${telegramMcpPort()}/mcp`;
}

/** Resolves a package asset (the vendored tree, the login bridge) from where
    the server actually runs. A repo checkout serves with cwd at the repo
    root; a PUBLISHED install serves `dist/standalone/server.js` (and a repo
    production run `.next/standalone/server.js`) with cwd inside that
    standalone directory — two levels below the package root, where the asset
    really lives. The CLI launcher also pins the explicit env override, which
    always wins. */
function packageAssetPath(envOverride: string | undefined, ...segments: string[]): string {
  if (envOverride) return envOverride;
  const direct = path.join(process.cwd(), ...segments);
  if (fs.existsSync(direct)) return direct;
  const fromStandalone = path.join(process.cwd(), "..", "..", ...segments);
  if (fs.existsSync(fromStandalone)) return fromStandalone;
  return direct;
}

/** The vendored upstream tree. */
export function vendoredConnectorDir(): string {
  return packageAssetPath(process.env.LLV_TELEGRAM_VENDOR_DIR, "vendor", "telegram-mcp");
}

export function telegramVenvDir(): string {
  return statePath("telegram", "venv");
}

export function telegramVenvPython(): string {
  return process.env.LLV_TELEGRAM_PYTHON || path.join(telegramVenvDir(), "bin", "python");
}

export function loginBridgePath(): string {
  return packageAssetPath(process.env.LLV_TELEGRAM_BRIDGE, "bin", "telegram-login-bridge.py");
}

export type TelegramApiCredentials = { apiId: string; apiHash: string };

/**
 * Host configuration supplies the Telegram API credentials: either environment
 * variables or `telegram.json` in the app config dir. They are handed to the
 * connector/bridge processes as environment and never serialized into any API
 * payload — the browser has no reason to see them.
 */
export function telegramApiCredentials(): TelegramApiCredentials | null {
  const envId = process.env.LLV_TELEGRAM_API_ID;
  const envHash = process.env.LLV_TELEGRAM_API_HASH;
  if (envId && envHash) return { apiId: envId, apiHash: envHash };
  try {
    const parsed = JSON.parse(fs.readFileSync(configFilePath("telegram.json"), "utf8")) as { apiId?: unknown; apiHash?: unknown };
    if (typeof parsed.apiId === "string" && parsed.apiId && typeof parsed.apiHash === "string" && parsed.apiHash) {
      return { apiId: parsed.apiId, apiHash: parsed.apiHash };
    }
  } catch { /* absent or unreadable config means unconfigured */ }
  return null;
}

export type ProcessSpec = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };

/** Provisions the connector venv from the vendored tree and its exact lock.
    `--frozen` refuses to re-resolve, so the environment is the one upstream
    shipped at the pinned tag. */
export function provisionSpec(): ProcessSpec {
  const vendor = vendoredConnectorDir();
  return {
    command: "uv",
    args: ["sync", "--frozen", "--no-dev", "--project", vendor],
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: telegramVenvDir() },
    cwd: vendor,
  };
}

export function connectorProvisioned(): boolean {
  return fs.existsSync(telegramVenvPython());
}

/** Launch spec for the one shared read-only connector process.
    The session string travels ONLY as child environment (the upstream
    contract) — never as an argument, so it cannot surface in process listings,
    transcripts, or the activity journal. */
export function connectorLaunchSpec(input: { sessionString: string; credentials: TelegramApiCredentials }): ProcessSpec {
  const vendor = vendoredConnectorDir();
  return {
    command: telegramVenvPython(),
    args: [path.join(vendor, "main.py")],
    cwd: vendor,
    env: {
      ...minimalChildEnv(),
      TELEGRAM_API_ID: input.credentials.apiId,
      TELEGRAM_API_HASH: input.credentials.apiHash,
      TELEGRAM_SESSION_STRING: input.sessionString,
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      MCP_TRANSPORT: "http",
      MCP_HOST: TELEGRAM_MCP_HOST,
      MCP_PORT: String(telegramMcpPort()),
    },
  };
}

/** Launch spec for one enrollment-bridge invocation (`enroll`/`health`/`logout`).
    The session, when one is needed, is written to the child's stdin by the
    adapter — not put in env or argv here. */
export function bridgeLaunchSpec(command: "enroll" | "health" | "logout", credentials: TelegramApiCredentials): ProcessSpec {
  return {
    command: telegramVenvPython(),
    args: [loginBridgePath(), command],
    cwd: os.homedir(),
    env: {
      ...minimalChildEnv(),
      TELEGRAM_API_ID: credentials.apiId,
      TELEGRAM_API_HASH: credentials.apiHash,
    },
  };
}

/** Child processes get a minimal environment: enough to run Python, none of
    the Viewer's own configuration or any inherited provider credentials. */
function minimalChildEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env as NodeJS.ProcessEnv;
}
