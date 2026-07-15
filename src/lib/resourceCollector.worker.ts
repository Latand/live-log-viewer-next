import { parentPort } from "node:worker_threads";

import { readTranscriptHostsObservation } from "./agent/transcriptHost";
import { procBackend } from "./proc";
import { buildResourceSnapshot, lastResourceBuildDiagnostic, lastResourceTargetRefs, readResourceFileSnapshot } from "./resources";
import { captureTmuxAttachReferences } from "./tmux";

process.env.LLV_RESOURCE_OBSERVATION_WORKER = "1";

function send(message: unknown): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function collect(message: unknown): Promise<void> {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "collect") return;
  try {
    const payload = await buildResourceSnapshot(true, {
      readFiles: readResourceFileSnapshot,
      readHosts: readTranscriptHostsObservation,
      proc: procBackend,
      captureAttachReferences: captureTmuxAttachReferences,
    });
    const diagnostic = lastResourceBuildDiagnostic();
    if (!diagnostic) throw new Error("resource worker completed without diagnostics");
    send({ type: "observation", payload, diagnostic, targets: lastResourceTargetRefs() });
  } catch (error) {
    send({ type: "failure", error: error instanceof Error ? error.message : String(error) });
  }
}

if (parentPort) {
  parentPort.on("message", (message: unknown) => { void collect(message); });
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => { input += chunk; });
  process.stdin.on("end", () => {
    try {
      void collect(JSON.parse(input));
    } catch (error) {
      send({ type: "failure", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
