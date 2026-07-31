import { buildFilesResponse } from "@/app/api/files/response";
import type { FilesResponseWorkerRequest } from "@/lib/scanner/filesResponseWorker";

const INPUT_MAX_BYTES = 8 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workerRequest(value: unknown): FilesResponseWorkerRequest | null {
  if (!record(value)
    || value.type !== "project"
    || typeof value.url !== "string"
    || !Array.isArray(value.headers)
    || !record(value.snapshot)
    || !Array.isArray(value.snapshot.files)
    || !Array.isArray(value.snapshot.projectCatalog)) return null;
  return value as unknown as FilesResponseWorkerRequest;
}

async function run(value: unknown): Promise<void> {
  const request = workerRequest(value);
  if (!request) throw new Error("files response worker received an invalid request");
  const response = await buildFilesResponse(new Request(request.url, {
    headers: new Headers(request.headers),
  }), {
    listFilesWithProjectCatalog: async () => request.snapshot,
  });
  process.stdout.write(JSON.stringify({
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? "application/json",
    etag: response.headers.get("etag") ?? "",
    timing: response.headers.get("server-timing") ?? "",
  }));
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > INPUT_MAX_BYTES) {
    process.stderr.write("files response worker input exceeded limit\n");
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
