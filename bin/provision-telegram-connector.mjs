#!/usr/bin/env node
/**
 * Provisions the packaged Telegram connector environment (issue #1059).
 *
 * Builds the Viewer-owned Python venv from the vendored pinned source
 * (`vendor/telegram-mcp`, see its PROVENANCE.md) with `uv sync --frozen`, so a
 * clean installation can start the connector without a manual clone and
 * without ever resolving the poisoned `telegram-mcp` PyPI name.
 *
 * Ships in `bin/` with the published package (npm `files`), dependency-free,
 * so an installed `agent-log-viewer` can run it directly:
 *
 *   node bin/provision-telegram-connector.mjs      # or: bun run telegram:provision
 *
 * Environment (same contract as src/lib/telegram/packaging.ts):
 *   LLV_TELEGRAM_VENDOR_DIR  vendored tree (default: <package>/vendor/telegram-mcp)
 *   LLV_STATE_DIR            viewer state root (default: $XDG_CONFIG_HOME/agent-log-viewer/state)
 *   LLV_TELEGRAM_PYTHON      expected venv python (default: <state>/telegram/venv/bin/python)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = process.env.LLV_TELEGRAM_VENDOR_DIR || join(packageRoot, "vendor", "telegram-mcp");
const stateDir = process.env.LLV_STATE_DIR
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-log-viewer", "state");
const venvDir = join(stateDir, "telegram", "venv");
const venvPython = process.env.LLV_TELEGRAM_PYTHON || join(venvDir, "bin", "python");

if (!existsSync(join(vendorDir, "pyproject.toml"))) {
  console.error(`vendored connector not found at ${vendorDir}`);
  process.exit(1);
}
console.log(`provisioning telegram connector from ${vendorDir}`);
const result = spawnSync("uv", ["sync", "--frozen", "--no-dev", "--project", vendorDir], {
  cwd: vendorDir,
  env: { ...process.env, UV_PROJECT_ENVIRONMENT: venvDir },
  stdio: "inherit",
});
if (result.error || result.status !== 0) {
  console.error("provisioning failed:", result.error?.message ?? `exit ${result.status}`);
  process.exit(1);
}
if (!existsSync(venvPython)) {
  console.error(`provisioning finished but ${venvPython} is missing`);
  process.exit(1);
}
console.log(`telegram connector provisioned at ${venvPython}`);
