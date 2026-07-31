import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildFilesResponseInWorker } from "./filesResponseWorker";

test("files response projection runs in an isolated worker process", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-response-worker-"));
  try {
    const result = await buildFilesResponseInWorker({
      type: "project",
      url: "http://127.0.0.1/api/files",
      headers: [],
      snapshot: { files: [], projectCatalog: [], complete: true },
    }, {
      launch: {
        executable: process.execPath,
        workerPath: path.resolve(import.meta.dir, "../filesResponse.worker.ts"),
      },
      env: {
        ...process.env,
        NODE_ENV: "production",
        LLV_STATE_DIR: stateDir,
        LLV_AGENT_REGISTRY_SQLITE: "off",
        LLV_FILES_RESPONSE_WORKER: "1",
      },
      timeoutMs: 10_000,
    });
    expect(result.etag).toMatch(/^"[a-f0-9]{40}"$/);
    expect(result.contentType).toContain("application/json");
    expect(JSON.parse(result.body)).toMatchObject({
      files: [],
      projectCatalog: [],
      flows: [],
      pipelines: [],
      workflows: [],
      tasks: [],
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
