import { parentPort } from "node:worker_threads";

import { buildResourceSnapshot, lastResourceBuildDiagnostic, lastResourceTargetRefs } from "./resources";

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
    const payload = await buildResourceSnapshot(true);
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
