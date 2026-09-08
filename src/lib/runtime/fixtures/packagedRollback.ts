import fs from "node:fs";
import path from "node:path";

// Admission and terminal observation use the real isolated Viewer API. The
// runtime host owns its frozen coordinator, executable adapter and deadlines.
const directory = process.env.LLV_STATE_DIR!;
const port = process.env.LLV_PACKAGED_DEPLOYMENT_PORT;
if (!port) throw new Error("isolated deployment front port is required");
const url = `http://127.0.0.1:${port}/api/runtime/deployments`;
const started = Date.now();
let deploymentId: string | null = null;
while (Date.now() - started < 30_000) {
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "a".repeat(40), idempotencyKey: "packaged-incumbent-timeout" }),
      signal: AbortSignal.timeout(3_000),
    });
    const receipt = await response.json() as { deploymentId?: string };
    if (response.ok && receipt.deploymentId) { deploymentId = receipt.deploymentId; break; }
  } catch { /* Retry the same admission key while the isolated Viewer boots. */ }
  await Bun.sleep(250);
}
if (!deploymentId) throw new Error("isolated Viewer API admission unavailable");
while (Date.now() - started < 240_000) {
  try {
    const response = await fetch(`${url}/${deploymentId}`, { signal: AbortSignal.timeout(3_000) });
    const status = await response.json() as Record<string, unknown>;
    const deployment = (status.deployment ?? status) as { terminal?: boolean; phase?: string };
    if (response.ok && deployment.terminal) {
      fs.writeFileSync(path.join(directory, "rollback-terminal.json"), JSON.stringify(deployment));
      console.log(JSON.stringify(deployment));
      process.exit(deployment.phase === "rolled-back" ? 0 : 1);
    }
  } catch { /* Keep observing the original request through transient reads. */ }
  await Bun.sleep(250);
}
throw new Error("isolated deployment did not terminate");
