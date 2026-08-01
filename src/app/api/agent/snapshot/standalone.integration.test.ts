import { expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

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

const PRODUCTION_SHAPE = {
  files: 355,
  projects: 28,
  registryRows: 18_584,
  conversations: 4_683,
  generations: 5_502,
  continuityPaths: 1_233,
  receipts: 2_823,
  entries: 2_235,
  lineageEdges: 2_623,
  memberships: 953,
  aliases: 248,
  migrationIntents: 41,
  heldDeliveries: 3_870,
  deliveryOperationOwners: 1_108,
  titleRecords: 45,
  largestTranscriptBytes: 2_888_905_315,
} as const;

function syntheticConversationId(index: number): `conversation_${string}` {
  return `conversation_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function syntheticSessionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function seedCompletedFiles(sandbox: string, stateDir: string): FileEntry[] {
  const files = Array.from({ length: PRODUCTION_SHAPE.files }, (_value, index): FileEntry => {
    const project = `project-${index % PRODUCTION_SHAPE.projects}`;
    const uuid = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const pathname = path.join(sandbox, "home", ".claude", "projects", project, `${uuid}.jsonl`);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, `${JSON.stringify({
      type: "user",
      timestamp: "2026-07-31T00:00:00.000Z",
      message: { content: `fixture ${index}` },
    })}\n`);
    if (index === 0) fs.truncateSync(pathname, PRODUCTION_SHAPE.largestTranscriptBytes);
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
  const projectCatalog = Array.from({ length: PRODUCTION_SHAPE.projects }, (_value, index) => ({
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

function seedProductionRegistry(
  stateDir: string,
  titledPaths: readonly string[],
): { store: SqliteAgentRegistryStore; churnLaunchId: string } {
  const filename = path.join(stateDir, "agent-registry.json");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  const begun = seed.beginSpawn("codex", "/fixture/repository");
  const settlement = seed.settleSpawn(begun.launchId, {
    key: { engine: "codex", sessionId: syntheticSessionId(0) },
    artifactPath: "/fixture/transcripts/session-0.jsonl",
    cwd: "/fixture/repository",
    accountId: null,
    launchProfile: begun.launchProfile,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settlement.kind !== "settled") throw new Error("production-shaped registry seed did not settle");
  const initial = seed.snapshot();
  const receiptTemplate = structuredClone(settlement.receipt);
  const conversationTemplate = structuredClone(settlement.conversation);
  const generationTemplate = structuredClone(settlement.conversation.generations[0]!);
  const entryTemplate = structuredClone(settlement.entry);
  initial.entries = {};
  initial.receipts = {};
  initial.lineageEdges = {};
  initial.memberships = {};
  initial.conversations = {};
  initial.conversationAliases = {};
  initial.migrationIntents = {};
  initial.heldDeliveries = {};
  initial.deliveryOperationOwners = {};

  for (let index = 0; index < PRODUCTION_SHAPE.conversations; index += 1) {
    const id = syntheticConversationId(index);
    const generationCount = index < PRODUCTION_SHAPE.generations - PRODUCTION_SHAPE.conversations ? 2 : 1;
    const generations = Array.from({ length: generationCount }, (_generation, generationIndex) => ({
      ...structuredClone(generationTemplate),
      id: syntheticSessionId(index * 2 + generationIndex),
      path: generationIndex === 0 && titledPaths[index]
        ? titledPaths[index]
        : `/fixture/transcripts/session-${index}-${generationIndex}.jsonl`,
      launchProfile: {
        ...structuredClone(generationTemplate.launchProfile),
        cwd: `/fixture/repositories/project-${index % PRODUCTION_SHAPE.projects}`,
        project: `project-${index % PRODUCTION_SHAPE.projects}`,
        title: `Synthetic conversation ${index} ${"title".padEnd(256, "x")}`,
      },
    }));
    const continuityCount = index < 37 ? 33 : index === 37 ? 12 : 0;
    initial.conversations[id] = {
      ...structuredClone(conversationTemplate),
      id,
      generations,
      continuityPaths: Array.from({ length: continuityCount }, (_path, pathIndex) =>
        `/fixture/continuity/${index}-${pathIndex}.jsonl`),
    };
  }

  const receiptDiagnostic = "synthetic-registry-receipt-".padEnd(1_280, "x");
  for (let index = 0; index < PRODUCTION_SHAPE.receipts; index += 1) {
    const launchId = `production-receipt-${String(index).padStart(5, "0")}`;
    initial.receipts[launchId] = {
      ...structuredClone(receiptTemplate),
      launchId,
      conversationId: syntheticConversationId(index % PRODUCTION_SHAPE.conversations),
      state: "failed",
      error: `${receiptDiagnostic}${index}`,
    };
  }

  for (let index = 0; index < PRODUCTION_SHAPE.entries; index += 1) {
    const sessionId = syntheticSessionId(index);
    initial.entries[`codex:${sessionId}`] = {
      ...structuredClone(entryTemplate),
      key: { engine: "codex", sessionId },
      artifactPath: `/fixture/transcripts/entry-${index}.jsonl`,
      cwd: `/fixture/repositories/project-${index % PRODUCTION_SHAPE.projects}`,
      launchProfile: {
        ...structuredClone(begun.launchProfile),
        ...structuredClone(entryTemplate.launchProfile ?? {}),
        cwd: entryTemplate.launchProfile?.cwd ?? begun.cwd,
        title: `Synthetic entry ${index} ${"title".padEnd(256, "x")}`,
      },
    };
  }

  const lineageDiagnostic = "synthetic-lineage-".padEnd(384, "x");
  for (let index = 0; index < PRODUCTION_SHAPE.lineageEdges; index += 1) {
    const childConversationId = syntheticConversationId(index);
    initial.lineageEdges[childConversationId] = {
      childConversationId,
      parentConversationId: syntheticConversationId((index + 1) % PRODUCTION_SHAPE.conversations),
      childSessionKey: null,
      parentSessionKey: null,
      childArtifactPath: `/fixture/transcripts/child-${index}.jsonl`,
      parentArtifactPath: `/fixture/transcripts/parent-${index}.jsonl`,
      kind: "spawn",
      role: lineageDiagnostic,
      reviewsConversationId: null,
      source: "viewer-spawn",
      evidence: { launchId: null, clientAttemptId: null },
      createdAt: "2026-07-31T00:00:00.000Z",
    };
  }

  for (let index = 0; index < PRODUCTION_SHAPE.memberships; index += 1) {
    const conversationId = syntheticConversationId(index);
    initial.memberships[conversationId] = [{
      conversationId,
      kind: "pipeline",
      containerId: `pipeline-${String(index).padStart(4, "0")}-${"container".padEnd(96, "x")}`,
      role: "builder",
      slot: `stage-${index}`,
      stageId: `stage-${index}`,
      stageOrder: index,
      round: 1,
      parentConversationId: null,
      runtime: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      createdAt: "2026-07-31T00:00:00.000Z",
    }];
  }

  for (let index = 0; index < PRODUCTION_SHAPE.aliases; index += 1) {
    initial.conversationAliases[syntheticConversationId(PRODUCTION_SHAPE.conversations + index)] =
      syntheticConversationId(index);
  }

  for (let index = 0; index < PRODUCTION_SHAPE.migrationIntents; index += 1) {
    initial.migrationIntents[`migration-${index}`] = {
      id: `migration-${index}`,
      diagnostic: "synthetic-migration".padEnd(320, "x"),
    } as never;
  }

  const deliveryText = "synthetic held delivery ".padEnd(512, "x");
  for (let index = 0; index < PRODUCTION_SHAPE.heldDeliveries; index += 1) {
    const id = `delivery-${String(index).padStart(5, "0")}`;
    const operationId = index < PRODUCTION_SHAPE.deliveryOperationOwners ? `operation-${index}` : id;
    const conversationId = syntheticConversationId(index % PRODUCTION_SHAPE.conversations);
    initial.heldDeliveries[id] = {
      id,
      conversationId,
      runtimeConversationId: conversationId,
      text: deliveryText,
      createdAt: "2026-07-31T00:00:00.000Z",
      clientMessageId: `message-${index}`,
      payloadKind: "text",
      runtimeImages: [],
      contentDigest: "c".repeat(64),
      artifactPaths: [],
      command: { operationId, kind: "send", policy: "queue" },
      requestDigest: "d".repeat(64),
      state: "held",
      generationId: null,
      attempts: 0,
      assignedAt: null,
      deliveredAt: null,
      error: null,
    };
  }

  for (let index = 0; index < PRODUCTION_SHAPE.deliveryOperationOwners; index += 1) {
    const operationId = `operation-${index}`;
    const deliveryId = `delivery-${String(index).padStart(5, "0")}`;
    const conversationId = syntheticConversationId(index % PRODUCTION_SHAPE.conversations);
    initial.deliveryOperationOwners[operationId] = {
      conversationId,
      runtimeConversationId: conversationId,
      clientMessageId: `message-${index}`,
      deliveryId,
      command: { operationId, kind: "send", policy: "queue" },
      requestDigest: "d".repeat(64),
      contentDigest: "c".repeat(64),
      createdAt: "2026-07-31T00:00:00.000Z",
      terminalState: null,
    };
  }

  const store = new SqliteAgentRegistryStore(path.join(stateDir, "agent-registry.sqlite"), {
    initialSnapshot: initial,
    normalize: normalizeRegistry,
  });
  fs.writeFileSync(path.join(stateDir, "session-titles.json"), `${JSON.stringify({
    version: 1,
    titles: Array.from({ length: PRODUCTION_SHAPE.titleRecords }, (_value, index) => ({
      key: `conversation:${syntheticConversationId(index)}`,
      title: `Production-matched title ${index}`,
      revision: 1,
      updatedAt: "2026-07-31T00:00:00.000Z",
    })),
  })}\n`);
  return { store, churnLaunchId: "production-receipt-01411" };
}

function registryShape(stateDir: string): { rows: number; payloadBytes: number } {
  const database = new Database(path.join(stateDir, "agent-registry.sqlite"), { readonly: true, strict: true });
  try {
    return database.query<{ rows: number; payloadBytes: number }, []>(
      "SELECT COUNT(*) AS rows, SUM(LENGTH(value_json)) AS payloadBytes FROM registry_rows",
    ).get()!;
  } finally {
    database.close();
  }
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
    const { store, churnLaunchId } = seedProductionRegistry(
      stateDir,
      files.slice(0, PRODUCTION_SHAPE.titleRecords).map((entry) => entry.path),
    );
    const registry = registryShape(stateDir);
    expect(registry.rows).toBe(PRODUCTION_SHAPE.registryRows);
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
      expect(filesPayload.files).toHaveLength(PRODUCTION_SHAPE.files);

      const presenceResponse = await fetch(`${origin}/api/view/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(presence(files[0]!.path)),
        signal: AbortSignal.timeout(1_000),
      });
      expect(presenceResponse.status).toBe(200);

      // `/api/files` warmed revision 1. Advancing the store before the first
      // snapshot reproduces production: an unrelated writer invalidates the
      // process cache, so any hidden whole-registry dependency must pay for all
      // 18,584 rows inside the request.
      store.mutate((file) => {
        file.receipts[churnLaunchId]!.error = "external revision before snapshot";
      }, false);

      const rssBefore = rssBytes(server.pid);
      let peakRss = rssBefore;
      const singleStartedAt = performance.now();
      let singleResponse: Response | null = null;
      let singleTimedOut = false;
      try {
        singleResponse = await fetch(`${origin}/api/agent/snapshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } }),
          signal: AbortSignal.timeout(250),
        });
      } catch (error) {
        if ((error as Error).name !== "TimeoutError") throw error;
        singleTimedOut = true;
      }
      const singleDurationMs = performance.now() - singleStartedAt;
      const singlePayload = singleResponse ? await singleResponse.json() as ViewerSnapshotV1 : null;
      await Bun.sleep(500);
      peakRss = Math.max(peakRss, rssBytes(server.pid));

      store.mutate((file) => {
        file.receipts[churnLaunchId]!.error = "external revision before phase diagnostic";
      }, false);
      const diagnosticResponse = await fetch(`${origin}/api/agent/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } }),
        signal: AbortSignal.timeout(30_000),
      });
      expect(diagnosticResponse.status).toBe(200);
      await diagnosticResponse.body?.cancel();
      const diagnosticServerTiming = diagnosticResponse.headers.get("server-timing");
      peakRss = Math.max(peakRss, rssBytes(server.pid));

      store.mutate((file) => {
        file.receipts[churnLaunchId]!.error = "external revision before concurrent snapshots";
      }, false);
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
        return { status: response.status, durationMs, payload, serverTiming: response.headers.get("server-timing") };
      }));
      await churn;
      await Bun.sleep(100);
      const rssAfter = rssBytes(server.pid);
      peakRss = Math.max(peakRss, rssAfter);

      console.log(JSON.stringify({
        phase: "standalone-evidence",
        registryPayloadBytes: registry.payloadBytes,
        titleRecords: PRODUCTION_SHAPE.titleRecords,
        singleTimedOut,
        singleSnapshotMs: Math.round(singleDurationMs),
        diagnosticServerTiming,
        maxSnapshotMs: Math.round(Math.max(...measurements.map((measurement) => measurement.durationMs))),
        slowestServerTiming: measurements
          .sort((left, right) => right.durationMs - left.durationMs)[0]?.serverTiming ?? null,
        rssBeforeMiB: Math.round(rssBefore / (1024 * 1024)),
        peakRssMiB: Math.round(peakRss / (1024 * 1024)),
        rssAfterMiB: Math.round(rssAfter / (1024 * 1024)),
      }));
      expect(singleTimedOut).toBe(false);
      expect(singleResponse?.status).toBe(200);
      expect(singlePayload?.scope).toMatchObject({ totalPaths: 1, returnedPaths: [files[0]!.path] });
      expect(singlePayload?.conversations[0]?.title).toBe("Production-matched title 0");
      expect(measurements.every((measurement) => measurement.status === 200)).toBe(true);
      expect(measurements.every((measurement) => measurement.serverTiming?.includes("snapshot-session-titles"))).toBe(true);
      expect(Math.max(...measurements.map((measurement) => measurement.durationMs))).toBeLessThan(1_000);
      expect(singleDurationMs).toBeLessThan(1_000);
      expect(measurements.every((measurement) => measurement.payload.scanner.entryCount === PRODUCTION_SHAPE.files)).toBe(true);
      expect(peakRss - rssBefore).toBeLessThan(48 * 1024 * 1024);
      expect(rssAfter - rssBefore).toBeLessThan(32 * 1024 * 1024);
      console.log(JSON.stringify({
        files: filesPayload.files.length,
        projects: PRODUCTION_SHAPE.projects,
        registryRows: PRODUCTION_SHAPE.registryRows,
        conversations: PRODUCTION_SHAPE.conversations,
        generations: PRODUCTION_SHAPE.generations,
        continuityPaths: PRODUCTION_SHAPE.continuityPaths,
        titleRecords: PRODUCTION_SHAPE.titleRecords,
        visiblePaths: 1,
        spawnPlaceholders: 0,
        largestTranscriptBytes: PRODUCTION_SHAPE.largestTranscriptBytes,
        churnRevisions: 102,
        singleSnapshotMs: Math.round(singleDurationMs),
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
