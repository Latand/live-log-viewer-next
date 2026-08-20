/**
 * Provisions the packaged Telegram connector environment (issue #1059).
 *
 * Builds the Viewer-owned Python venv from the vendored pinned source
 * (`vendor/telegram-mcp`, see its PROVENANCE.md) with `uv sync --frozen`, so a
 * clean installation can start the connector without a manual clone and
 * without ever resolving the poisoned `telegram-mcp` PyPI name.
 *
 *   bun scripts/provision-telegram-connector.ts
 */
import { spawnSync } from "node:child_process";

import { connectorProvisioned, provisionSpec, telegramVenvPython, vendoredConnectorDir } from "@/lib/telegram/packaging";

const spec = provisionSpec();
console.log(`provisioning telegram connector from ${vendoredConnectorDir()}`);
const result = spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "inherit" });
if (result.error || result.status !== 0) {
  console.error("provisioning failed", result.error?.message ?? `exit ${result.status}`);
  process.exit(1);
}
if (!connectorProvisioned()) {
  console.error(`provisioning finished but ${telegramVenvPython()} is missing`);
  process.exit(1);
}
console.log(`telegram connector provisioned at ${telegramVenvPython()}`);
