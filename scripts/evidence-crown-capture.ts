/**
 * One-off evidence capture for the sidebar crown+pin / create-project work.
 * Reuses the Stage A demo runtime (isolated fixture home, dockerized
 * puppeteer) and drives the real UI: crown two projects, reload to prove
 * server durability, create a project, provoke the duplicate refusal, and
 * repeat the form in Ukrainian. Outputs land in
 * docs/acceptance/sidebar-crown-pin/.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  bootstrapDemoRuntime,
  buildDockerClientEnvironment,
  demoPort,
  PUPPETEER_IMAGE,
} from "./demo-capture";

function runProcess(command: string, args: string[], options: Parameters<typeof spawn>[2]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

const repoRoot = path.resolve(import.meta.dir, "..");
const port = demoPort(process.env.EVIDENCE_PORT, 3033, "EVIDENCE_PORT");
/* Neutral, non-identifying root for the created project: it appears verbatim
   in the published screenshots. */
const manualRoot = "/tmp/projects/nova-docs";
fs.mkdirSync(manualRoot, { recursive: true });

const outDir = path.join(repoRoot, "docs/acceptance/sidebar-crown-pin");
fs.mkdirSync(outDir, { recursive: true });

const runtime = await bootstrapDemoRuntime(repoRoot, port);
/* The docker-bridge gateway the capture container reaches the host on — the
   demo runtime already carries it as its allowed dev origin. */
const gateway = runtime.env.LLV_DEV_ORIGINS;
try {
  await runtime.waitUntilReady();
  await runProcess("docker", [
    "run", "--rm", "--network", "bridge",
    "-v", `${repoRoot}:/workspace:ro`,
    "-v", `${outDir}:/output`,
    "-e", "NODE_PATH=/project/node_modules",
    "--entrypoint", "node",
    PUPPETEER_IMAGE,
    "/workspace/scripts/evidence-crown-browser.cjs",
    "--base", `http://${gateway}:${port}`,
    "--output", "/output",
    "--manual-root", manualRoot,
  ], { cwd: repoRoot, env: buildDockerClientEnvironment(), stdio: "inherit" });
} catch (error) {
  console.error(runtime.serverLogs());
  throw error;
} finally {
  await runtime.shutdown();
}
console.log(`evidence written to ${outDir}`);
