import { expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, normalizeRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import type { FileEntry } from "@/lib/types";
import type { PresencePayloadV1, ViewerSnapshotV1 } from "@/lib/view/types";

const standaloneServer = path.join(process.cwd(), ".next", "standalone", "server.js");
const required = process.env.LLV_REQUIRE_STANDALONE_SNAPSHOT_TEST === "1";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(origin: string, server: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`standalone server exited with ${server.exitCode}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // Startup is still in progress.
    }
    await Bun.sleep(100);
  }
  throw new Error("standalone server did not become ready");
}

function rssBytes(pid: number): number {
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const kib = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? Number.NaN);
  if (!Number.isFinite(kib)) throw new Error("standalone RSS is unavailable");
  return kib * 1024;
}

function seedCompletedFiles(sandbox: string, stateDir: string): FileEntry[] {
  const files = Array.from({ length: 373 }, (_value, index): FileEntry => {
    const project = `project-${index % 41}`;
    const uuid = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const pathname = path.join(sandbox, "home", ".claude", "projects", project, `${uuid}.jsonl`);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, `${JSON.stringify({
      type: "user",
      timestamp: "2026-07-31T00:00:00.000Z",
      message: { content: `fixture ${index}` },
    })}\n`);
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      root: "claude-projects",
      name: path.basename(pathname),
      project,
      title: `Session ${index}`,
      engine: "claude",
      kind: "session",
      fmt: "claude",
      parent: null,
      mtime: stat.mtimeMs / 1_000,
      size: stat.size,
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    };
  });
  const projectCatalog = Array.from({ length: 41 }, (_value, index) => ({
    project: `project-${index}`,
    smt: 1,
    conversations: files.filter((entry) => entry.project === `project-${index}`).length,
  }));
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "files-scan-snapshot.json"), `${JSON.stringify({
    version: 1,
    schemaVersion: 9,
    snapshot: { files, projectCatalog, complete: true },
  })}\n`);
  return files;
}

function seedLargeRegistry(stateDir: string): { store: SqliteAgentRegistryStore; churnLaunchId: string } {
  const filename = path.join(stateDir, "agent-registry.json");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  const template = seed.beginSpawn("codex", "/fixture/repository");
  const initial = seed.snapshot();
  const diagnostic = "synthetic-registry-payload-".padEnd(768, "x");
  for (let index = 0; index < 10_000; index += 1) {
    const launchId = `large-registry-${String(index).padStart(5, "0")}`;
    initial.receipts[launchId] = {
      ...structuredClone(template),
      launchId,
      state: "failed",
      error: `${diagnostic}${index}`,
    };
  }
  const store = new SqliteAgentRegistryStore(path.join(stateDir, "agent-registry.sqlite"), {
    initialSnapshot: initial,
    normalize: normalizeRegistry,
  });
  return { store, churnLaunchId: "large-registry-05000" };
}

function presence(focusedPath: string): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "standalone-route-view",
    deviceId: "standalone-route-device",
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: "project-0",
    mode: "scheme",
    viewport: { width: 1200, height: 800, dpr: 1 },
    camera: null,
    focusedPath,
    selectedPaths: [],
    visiblePaths: [focusedPath],
    board: { renderedRevision: null, durableRevision: null, sync: "unavailable" },
  };
}

async function stopServer(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  const stopped = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!stopped) {
    server.kill("SIGKILL");
    await server.exited;
  }
}

test.skipIf(!required && !fs.existsSync(standaloneServer))(
  "built standalone snapshot route stays bounded during large external registry churn",
  async () => {
    expect(fs.existsSync(standaloneServer)).toBe(true);
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-snapshot-standalone-"));
    const stateDir = path.join(sandbox, "state");
    const files = seedCompletedFiles(sandbox, stateDir);
    const { store, churnLaunchId } = seedLargeRegistry(stateDir);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = Bun.spawn([process.execPath, standaloneServer], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        HOME: path.join(sandbox, "home"),
        XDG_CONFIG_HOME: path.join(sandbox, "config"),
        XDG_CACHE_HOME: path.join(sandbox, "cache"),
        LLV_STATE_DIR: stateDir,
        LLV_AGENT_REGISTRY_SQLITE: "sqlite",
        LLV_STRUCTURED_HOSTS: "0",
        LLV_RUNTIME_EVENTS: "0",
        LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
        LLV_FILES_RESPONSE_WORKER_DISABLED: "1",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForServer(origin, server);
      const filesResponse = await fetch(`${origin}/api/files`, { signal: AbortSignal.timeout(10_000) });
      expect(filesResponse.status).toBe(200);
      const filesPayload = await filesResponse.json() as { files: FileEntry[] };
      expect(filesPayload.files).toHaveLength(373);

      const presenceResponse = await fetch(`${origin}/api/view/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(presence(files[0]!.path)),
        signal: AbortSignal.timeout(1_000),
      });
      expect(presenceResponse.status).toBe(200);

      const rssBefore = rssBytes(server.pid);
      let peakRss = rssBefore;
      const churn = (async () => {
        for (let revision = 0; revision < 100; revision += 1) {
          store.mutate((file) => {
            file.receipts[churnLaunchId]!.error = `external revision ${revision}`;
          }, false);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })();
      const measurements = await Promise.all(Array.from({ length: 20 }, async () => {
        const startedAt = performance.now();
        const response = await fetch(`${origin}/api/agent/snapshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } }),
          signal: AbortSignal.timeout(1_000),
        });
        const durationMs = performance.now() - startedAt;
        const payload = await response.json() as ViewerSnapshotV1;
        peakRss = Math.max(peakRss, rssBytes(server.pid));
        return { status: response.status, durationMs, payload };
      }));
      await churn;
      await Bun.sleep(100);
      const rssAfter = rssBytes(server.pid);
      peakRss = Math.max(peakRss, rssAfter);

      expect(measurements.every((measurement) => measurement.status === 200)).toBe(true);
      expect(Math.max(...measurements.map((measurement) => measurement.durationMs))).toBeLessThan(1_000);
      expect(measurements.every((measurement) => measurement.payload.scanner.entryCount === 373)).toBe(true);
      expect(peakRss - rssBefore).toBeLessThan(48 * 1024 * 1024);
      expect(rssAfter - rssBefore).toBeLessThan(32 * 1024 * 1024);
      console.log(JSON.stringify({
        files: filesPayload.files.length,
        registryRows: 10_001,
        churnRevisions: 100,
        snapshots: measurements.length,
        maxSnapshotMs: Math.round(Math.max(...measurements.map((measurement) => measurement.durationMs))),
        rssBeforeMiB: Math.round(rssBefore / (1024 * 1024)),
        peakRssMiB: Math.round(peakRss / (1024 * 1024)),
        rssAfterMiB: Math.round(rssAfter / (1024 * 1024)),
      }));
    } finally {
      await stopServer(server);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  },
  120_000,
);
