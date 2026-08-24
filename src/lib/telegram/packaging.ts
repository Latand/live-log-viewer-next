import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configFilePath, stateDir, statePath } from "@/lib/configDir";
import { withFileTransaction } from "@/lib/state/fileTransaction";

import { ensureTelegramStateDir, telegramIncomingFeedPath } from "./sessionStore";

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

/** The provisioner's writable staging copy of the vendored tree (#1084): the
    packaged tree can sit on a read-only filesystem, while the runtime's
    supply-chain guard requires a source checkout and the server writes its
    log beside its cwd. Provisioning keeps this copy; the connector runs from
    it. */
export function stagedConnectorSourceDir(): string {
  return statePath("telegram", "vendor-src");
}

export function telegramVenvPython(): string {
  return process.env.LLV_TELEGRAM_PYTHON || path.join(telegramVenvDir(), "bin", "python");
}

export function loginBridgePath(): string {
  return packageAssetPath(process.env.LLV_TELEGRAM_BRIDGE, "bin", "telegram-login-bridge.py");
}

export function telegramMcpServerPath(): string {
  return packageAssetPath(process.env.LLV_TELEGRAM_SERVER_BRIDGE, "bin", "telegram-mcp-server.py");
}

export function telegramSessionReaderPath(): string {
  return packageAssetPath(process.env.LLV_TELEGRAM_SESSION_READER, "bin", "telegram-session-reader.mjs");
}

export function telegramProvisionerPath(): string {
  return packageAssetPath(process.env.LLV_TELEGRAM_PROVISIONER, "bin", "provision-telegram-connector.mjs");
}

/**
 * Read tools that CONSUME a settled burst: they pop the chat out of the
 * connector's pending set, so whichever consumer scans first takes it
 * (`wait_for_settled_message` in `telegram_mcp/tools/events.py`). The incoming
 * event feed consumes exactly the same bursts, which is why a connector that
 * runs the feed withholds these instead of racing it — see
 * {@link connectorLaunchSpec}.
 *
 * `wait_for_new_message` is deliberately NOT here: it reports the pending set
 * without removing anything, so it costs the feed no burst and stays exposed.
 */
export const TELEGRAM_BURST_CONSUMING_TOOLS: readonly string[] = Object.freeze(["wait_for_settled_message"]);

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

/** Telegram api_id values are short decimal numbers; api_hash is 32 hex chars. */
const API_ID_SHAPE = /^\d{1,12}$/;
const API_HASH_SHAPE = /^[0-9a-f]{32}$/i;

export function validTelegramApiCredentials(apiId: unknown, apiHash: unknown): apiId is string {
  return typeof apiId === "string" && API_ID_SHAPE.test(apiId)
    && typeof apiHash === "string" && API_HASH_SHAPE.test(apiHash);
}

/**
 * Persist operator-entered API credentials to the same `telegram.json` the
 * reader above resolves (#1070). The write is atomic (temp sibling + rename)
 * and owner-only, so a concurrent status poll never sees a torn file and no
 * other user can read the hash. Environment variables keep precedence — this
 * only fills the file-backed fallback. Validation failures throw before any
 * byte is written.
 */
export function saveTelegramApiCredentials(apiId: string, apiHash: string): void {
  if (!validTelegramApiCredentials(apiId, apiHash)) {
    throw new Error("Telegram API credentials are invalid");
  }
  const target = configFilePath("telegram.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  /* Unpredictable sibling + exclusive creation ("wx"): a pre-planted file or
     symlink at the temp path fails the write instead of receiving the hash
     through the default truncating open (the session store's pattern). */
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ apiId, apiHash }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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

export function provisionLaunchSpec(): ProcessSpec {
  return {
    command: process.execPath,
    args: [telegramProvisionerPath()],
    cwd: vendoredConnectorDir(),
    env: {
      ...minimalChildEnv(),
      LLV_STATE_DIR: stateDir(),
      LLV_TELEGRAM_VENDOR_DIR: vendoredConnectorDir(),
      LLV_TELEGRAM_PYTHON: telegramVenvPython(),
    },
  };
}

export function connectorProvisioned(): boolean {
  /* #1084: bare venv existence lied once (a failed sync leaves scaffolding).
     Provisioned means: the provisioner's post-import-probe marker, the venv
     python, and the staged source the connector runs from all exist. */
  return fs.existsSync(path.join(telegramVenvDir(), ".llv-provisioned"))
    && fs.existsSync(telegramVenvPython())
    && fs.existsSync(path.join(stagedConnectorSourceDir(), "pyproject.toml"));
}

let provisioningInFlight: Promise<boolean> | null = null;

function runProvisioner(spec: ProcessSpec): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

/** Product-owned, idempotent provisioning. The first clean-install login
    starts the packaged provisioner; concurrent Viewer generations share the
    same process lock and re-check the venv after acquiring it. */
export function ensureConnectorProvisioned(): Promise<boolean> {
  if (connectorProvisioned()) return Promise.resolve(true);
  if (provisioningInFlight) return provisioningInFlight;
  provisioningInFlight = (async () => {
    ensureTelegramStateDir(true);
    return await withFileTransaction(
      statePath("telegram", "connector-provision"),
      "Telegram connector provisioning is busy",
      async () => {
        if (connectorProvisioned()) return true;
        const succeeded = await runProvisioner(provisionLaunchSpec());
        return succeeded && connectorProvisioned();
      },
    );
  })().catch(() => false).finally(() => { provisioningInFlight = null; });
  return provisioningInFlight;
}

/** Launch spec for the one shared read-only connector process.
    The session string travels ONLY as child environment (the upstream
    contract) — never as an argument, so it cannot surface in process listings,
    transcripts, or the activity journal. */
export function connectorLaunchSpec(input: { credentialRef: string; sessionString: string; connectorToken: string; credentials: TelegramApiCredentials }): ProcessSpec {
  const vendor = stagedConnectorSourceDir();
  return {
    command: telegramVenvPython(),
    args: [telegramMcpServerPath()],
    cwd: vendor,
    env: {
      ...minimalChildEnv(),
      TELEGRAM_API_ID: input.credentials.apiId,
      TELEGRAM_API_HASH: input.credentials.apiHash,
      TELEGRAM_SESSION_STRING: input.sessionString,
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      /* Run the incoming feed (#1091). Without it the connector records
         activity nowhere, and private-dialog discovery is back to guessing
         from a chat list that is not ordered by recency. */
      TELEGRAM_EVENT_FEED: "1",
      TELEGRAM_EVENT_FEED_FILE: telegramIncomingFeedPath(input.credentialRef),
      /* The feed CONSUMES settled bursts, and upstream documents a blocking
         `wait_for_settled_message` as the other consumer of the same bursts —
         whichever scans first takes one, so a concurrent waiter could eat the
         burst that was a report's only evidence of an active dialog. This
         connector does not run that race: the burst consumers are WITHHELD
         from the surface it exposes, leaving the feed the only one. The
         withholding happens in the Viewer's own entrypoint because upstream's
         `TELEGRAM_EXPOSED_TOOLS` can only widen a read-only surface with write
         tools, never narrow it; connector readiness then verifies that the
         advertised surface really is missing them. */
      LLV_TELEGRAM_EXCLUDED_TOOLS: TELEGRAM_BURST_CONSUMING_TOOLS.join(","),
      LLV_TELEGRAM_MCP_TOKEN: input.connectorToken,
      LLV_TELEGRAM_VENDOR_DIR: vendor,
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
