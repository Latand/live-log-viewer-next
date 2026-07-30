import "./fileScanner.workerMode";

import { listFilesWithProjectCatalog, type FileCatalogScan, type FileScanOptions } from "./scanner";

type FileScannerWorkerRequest = {
  type: "scan";
  options: Omit<FileScanOptions, "onResourceSnapshot">;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestFrom(value: unknown): FileScannerWorkerRequest | null {
  if (!record(value) || value.type !== "scan" || !record(value.options)) return null;
  return value as FileScannerWorkerRequest;
}

function send(type: "resource" | "complete", snapshot: FileCatalogScan): void {
  process.stdout.write(`${JSON.stringify({ type, snapshot })}\n`);
}

async function run(value: unknown): Promise<void> {
  const request = requestFrom(value);
  if (!request) throw new Error("file scanner worker received an invalid request");
  const snapshot = await listFilesWithProjectCatalog(undefined, {
    ...request.options,
    onResourceSnapshot: (resource) => send("resource", resource),
  });
  send("complete", snapshot);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) {
    process.stderr.write("file scanner worker input exceeded limit\n");
    process.exitCode = 1;
    process.stdin.destroy();
  }
});
process.stdin.on("end", () => {
  if (process.exitCode) return;
  try {
    void run(JSON.parse(input)).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
