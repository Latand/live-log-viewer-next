import fs from "node:fs";

import { checkpointFlowRollbackMirrorForDemotion, loadFlows, withFlowMutation } from "@/lib/flows/store";
import { loadPipelines } from "@/lib/pipelines/store";
import { loadWorkflows } from "@/lib/workflows/store";

const [mode, readyFile, releaseFile] = process.argv.slice(2);
if (!mode || !readyFile) throw new Error("hot state mirror child arguments are required");

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) Bun.sleepSync(5);
}

if (mode === "writer") {
  if (!releaseFile) throw new Error("hot state mirror writer release file is required");
  await withFlowMutation((flows, persist) => {
    flows[0]!.stateDetail = "checkpoint-coherent";
    persist();
    fs.writeFileSync(readyFile, "ready");
    waitFor(releaseFile);
  });
} else if (mode === "opener") {
  loadFlows();
  fs.writeFileSync(readyFile, "ready");
} else if (mode === "checkpoint-flows") {
  checkpointFlowRollbackMirrorForDemotion();
  fs.writeFileSync(readyFile, "ready");
} else if (mode === "open-pipelines") {
  loadPipelines();
  fs.writeFileSync(readyFile, "ready");
} else if (mode === "open-workflows") {
  loadWorkflows();
  fs.writeFileSync(readyFile, "ready");
} else {
  throw new Error(`unknown hot state mirror mode: ${mode}`);
}
