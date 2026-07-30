import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectFileScanInWorker, fileScanWorkerEnabled } from "./fileScanWorker";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureWorker(source: string): { directory: string; workerPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-worker-"));
  directories.push(directory);
  const workerPath = path.join(directory, "worker.mjs");
  fs.writeFileSync(workerPath, source);
  return { directory, workerPath };
}

test("production file scans use the worker boundary and test scans stay direct", () => {
  expect(fileScanWorkerEnabled({ NODE_ENV: "production" })).toBe(true);
  expect(fileScanWorkerEnabled({ NODE_ENV: "test" })).toBe(false);
  expect(fileScanWorkerEnabled({ NODE_ENV: "production", LLV_FILE_SCANNER_WORKER: "1" })).toBe(false);
  expect(fileScanWorkerEnabled({ NODE_ENV: "production", LLV_FILE_SCANNER_WORKER_DISABLED: "1" })).toBe(false);
});

test("worker scan streams the resource scope, keeps the caller event loop live, and returns completion", async () => {
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      const resource = { files: [], projectCatalog: [], complete: true };
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "resource", snapshot: resource }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "complete",
            snapshot: { files: [], projectCatalog: [{ id: "project-one", name: "one", path: "/one" }], complete: true },
          }) + "\\n");
        }, 20);
      }, 20);
    });
  `);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const resources: unknown[] = [];
  try {
    const snapshot = await collectFileScanInWorker(
      { persist: false, persistIndex: false },
      (resource) => resources.push(resource),
      {
        launch: { executable: process.execPath, workerPath },
        cwd: directory,
        timeoutMs: 2_000,
      },
    );
    expect(resources).toEqual([{ files: [], projectCatalog: [], complete: true }]);
    expect(snapshot.projectCatalog).toHaveLength(1);
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(timer);
  }
});
