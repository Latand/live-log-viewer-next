import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-upgrade-"));
const environment = {
  LLV_STATE_DIR: path.join(sandbox, "state"),
  LLV_CODEX_HOME: path.join(sandbox, "codex"),
  LLV_CLAUDE_HOME: path.join(sandbox, "claude"),
  OPENCLAW_STATE_DIR: path.join(sandbox, "openclaw"),
  TMPDIR: path.join(sandbox, "tmp"),
  LLV_FILES_PROJECTION_PERSIST_FOR_TEST: "1",
};
const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
fs.mkdirSync(path.join(environment.TMPDIR, `claude-${process.getuid?.() ?? 1000}`), { recursive: true });

const { GET } = await import("./route");
const { cachedFileScan, fileScanCacheStatus, resetFilesRouteCacheForTests, setFileScanRunnerForTests } = await import("@/lib/scanner/scanCache");
const { runFileCatalogScan } = await import("@/lib/scanner/scanCoordinator");

const store = globalThis as typeof globalThis & {
  __llvCaches?: Record<string, Map<string, unknown>>;
  __llvFilesProjectionCache?: Map<string, unknown>;
  __llvFilesProjectionInflight?: Map<string, Promise<unknown>>;
  __llvFilesProjectionWorkerTail?: Promise<void>;
  __llvFilesProjectionPersistenceTail?: Promise<void>;
  __llvFilesPersistedProjectionChecked?: boolean;
};
const scanPath = path.join(environment.LLV_STATE_DIR, "files-scan-snapshot.json");
const metaPath = path.join(environment.LLV_STATE_DIR, "files-response-cache.json");
const codexAt = "2026-09-01T10:00:00.000Z";
const claudeAt = "2026-09-01T11:00:00.000Z";

function writeTranscript(root: string, filename: string, records: unknown[]): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, filename), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

const sessions = path.join(environment.LLV_CODEX_HOME, "sessions");
const header = { type: "session_meta", payload: { cwd: "/repo/cache-upgrade" } };
writeTranscript(sessions, "codex-work.jsonl", [header, {
  type: "response_item", timestamp: codexAt,
  payload: { type: "function_call", name: "read_file", arguments: "{}" },
}]);
writeTranscript(path.join(environment.LLV_CLAUDE_HOME, "projects", "cache-upgrade"), "claude-work.jsonl", [{
  type: "assistant", cwd: "/repo/cache-upgrade", timestamp: claudeAt,
  message: { role: "assistant", content: [{ type: "text", text: "Synthetic result." }] },
}]);
writeTranscript(sessions, "no-work.jsonl", [header, {
  type: "event_msg", timestamp: "2026-09-01T12:00:00.000Z",
  payload: { type: "user_message", message: "Synthetic request." },
}]);
// A bounded tail with no visible execution cannot establish prior activity.
writeTranscript(sessions, "unknown-work.jsonl", [header, {
  type: "event_msg", timestamp: "2026-09-01T13:00:00.000Z",
  payload: { type: "user_message", message: "x".repeat(800_000) },
}]);

function restartCaches(): void {
  resetFilesRouteCacheForTests();
  for (const cache of Object.values(store.__llvCaches ?? {})) cache.clear();
  store.__llvFilesProjectionCache = new Map();
  store.__llvFilesProjectionInflight = new Map();
  store.__llvFilesProjectionWorkerTail = undefined;
  store.__llvFilesPersistedProjectionChecked = undefined;
}

function expectActivity(files: FileEntry[]): void {
  const activity = Object.fromEntries(files.map((entry) => [path.basename(entry.path), entry.lastAgentWorkAt]));
  expect(activity).toEqual({
    "codex-work.jsonl": Date.parse(codexAt),
    "claude-work.jsonl": Date.parse(claudeAt),
    "no-work.jsonl": null,
    "unknown-work.jsonl": undefined,
  });
}

async function readFiles(view: "full" | "summary"): Promise<Response> {
  return GET(new Request(`http://127.0.0.1/api/files${view === "summary" ? "?view=summary" : ""}`));
}

async function drainCaches(): Promise<void> {
  for (let attempt = 0; attempt < 200 && (fileScanCacheStatus().inFlight || store.__llvFilesProjectionInflight?.size); attempt += 1) {
    await Bun.sleep(5);
  }
  expect(fileScanCacheStatus().inFlight).toBe(false);
  expect(store.__llvFilesProjectionInflight?.size ?? 0).toBe(0);
  await store.__llvFilesProjectionPersistenceTail;
}

async function seedCurrentCaches(): Promise<void> {
  restartCaches();
  // Only this test's invented cache artifacts are removed to seed a cold run.
  fs.rmSync(scanPath, { force: true });
  fs.rmSync(metaPath, { force: true });
  const response = await readFiles("full");
  expectActivity((await response.json()).files);
  await drainCaches();
}

afterEach(async () => {
  await drainCaches();
  setFileScanRunnerForTests(null);
  restartCaches();
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

for (const scenario of [
  { view: "full", oldScan: true, oldBody: false },
  { view: "summary", oldScan: true, oldBody: false },
  { view: "full", oldScan: false, oldBody: true },
  { view: "full", oldScan: true, oldBody: true },
] as const) {
  test(`upgrade ${scenario.view}: ${scenario.oldScan ? "v10" : "current"} scan and ${scenario.oldBody ? "v1" : "absent"} body derive activity on first response`, async () => {
    await seedCurrentCaches();
    if (scenario.oldScan) {
      const persisted = JSON.parse(fs.readFileSync(scanPath, "utf8"));
      persisted.schemaVersion = 10;
      for (const entry of persisted.snapshot.files) delete entry.lastAgentWorkAt;
      fs.writeFileSync(scanPath, JSON.stringify(persisted));
    }
    if (scenario.oldBody) {
      const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const body = JSON.parse(fs.readFileSync(path.join(environment.LLV_STATE_DIR, metadata.bodyFile), "utf8"));
      for (const entry of body.files) delete entry.lastAgentWorkAt;
      const text = JSON.stringify(body);
      const digest = createHash("sha1").update(text).digest("hex");
      metadata.version = 1;
      metadata.bodyFile = `files-response-cache-${digest}.json`;
      metadata.etag = `"${digest}"`;
      fs.writeFileSync(path.join(environment.LLV_STATE_DIR, metadata.bodyFile), text);
      fs.writeFileSync(metaPath, JSON.stringify(metadata));
    } else {
      fs.rmSync(metaPath, { force: true });
    }
    restartCaches();

    const first = await readFiles(scenario.view);
    expect(first.status).toBe(200);
    expectActivity((await first.json()).files);
    if (scenario.oldScan) expect(first.headers.get("x-llv-files-cache")).toBe("miss");
    expect(first.headers.get("x-llv-files-projection-cache")).toBe("miss");
    await drainCaches();
    expect(JSON.parse(fs.readFileSync(scanPath, "utf8")).schemaVersion).toBe(11);

    // Both consumers and their subsequent cache hits retain the same values.
    for (const view of ["full", "summary"] as const) {
      const response = await readFiles(view);
      expectActivity((await response.json()).files);
      const cached = await readFiles(view);
      expect(cached.headers.get("x-llv-files-projection-cache")).toBe("hit");
      expectActivity((await cached.json()).files);
    }
    await drainCaches();
    expect(JSON.parse(fs.readFileSync(metaPath, "utf8")).version).toBe(2);
  });
}

test("compatible restart reuses persisted scan and full body with known, null and absent activity", async () => {
  await seedCurrentCaches();
  const persistedBody = fs.readFileSync(path.join(environment.LLV_STATE_DIR, JSON.parse(fs.readFileSync(metaPath, "utf8")).bodyFile), "utf8");
  restartCaches();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setFileScanRunnerForTests(async (...args) => {
    await gate;
    return runFileCatalogScan(...args);
  });
  try {
    const scan = await cachedFileScan(undefined, undefined, 0);
    expect(scan.generation).toBe(0);
    expect(scan.cacheStatus).toBe("hit");
    expectActivity(scan.snapshot.files);
    const full = await readFiles("full");
    expect(full.headers.get("x-llv-files-projection-cache")).toBe("stale");
    expect(await full.text()).toBe(persistedBody);
    const summary = await readFiles("summary");
    expectActivity((await summary.json()).files);
  } finally {
    release();
    await drainCaches();
  }
});
