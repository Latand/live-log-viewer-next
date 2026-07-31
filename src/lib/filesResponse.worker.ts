import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildFilesResponse } from "@/app/api/files/response";
import { statePath } from "@/lib/configDir";
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
    || (value.snapshotFile !== undefined && typeof value.snapshotFile !== "string")
    || (value.snapshot === undefined && value.snapshotFile === undefined)
    || (value.snapshot !== undefined && (
      !record(value.snapshot)
      || !Array.isArray(value.snapshot.files)
      || !Array.isArray(value.snapshot.projectCatalog)
    ))) return null;
  return value as unknown as FilesResponseWorkerRequest;
}

function snapshotFor(request: FilesResponseWorkerRequest): NonNullable<FilesResponseWorkerRequest["snapshot"]> {
  if (request.snapshot) return request.snapshot;
  const persisted = JSON.parse(fs.readFileSync(request.snapshotFile!, "utf8")) as unknown;
  if (!record(persisted)
    || !record(persisted.snapshot)
    || !Array.isArray(persisted.snapshot.files)
    || !Array.isArray(persisted.snapshot.projectCatalog)) {
    throw new Error("files response worker snapshot file is invalid");
  }
  return persisted.snapshot as unknown as NonNullable<FilesResponseWorkerRequest["snapshot"]>;
}

async function run(value: unknown): Promise<void> {
  const request = workerRequest(value);
  if (!request) throw new Error("files response worker received an invalid request");
  const snapshot = snapshotFor(request);
  const response = await buildFilesResponse(new Request(request.url, {
    headers: new Headers(request.headers),
  }), {
    listFilesWithProjectCatalog: async () => snapshot,
  });
  const resultDirectory = statePath("files-response-results");
  fs.mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });
  const bodyFile = path.join(resultDirectory, `${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(bodyFile, await response.text(), { encoding: "utf8", mode: 0o600 });
  process.stdout.write(JSON.stringify({
    bodyFile,
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
