import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTranscriptHostObserver, type TranscriptHost } from "@/lib/agent/transcriptHost";
import { procBackend } from "@/lib/proc";
import { RESOURCE_FAILURE_STDERR_MAX_BYTES } from "@/lib/resourceCollector";
import type { FileEntry, ResourcesPayload } from "@/lib/types";

import { allowedKillTarget, applyResourceTargets, buildResourceSnapshot, canonicalResourceEntry, conflictingResourceHost, consumeKillTarget, createResourcesReader, lastResourceBuildDiagnostic, lastResourceTargetRefs, noteSessionTargets, parsePersistedResourceObservation, parseResourcesFixture, resetResourcesForTests, resolveResourceWorkerLaunch, resourceDiagnosticHeader, resourceWorkerFileSnapshot, RESOURCE_OBSERVATION_MAX_BYTES, RESOURCE_WORKER_OUTPUT_MAX_BYTES } from "./resources";

const PATHNAME = "/home/user/.codex/sessions/2026/07/10/rollout-2026-07-10-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
const EMPTY_WORKER_MESSAGE = JSON.stringify({
  type: "observation",
  payload: { system: null, sessions: [] },
  diagnostic: {
    fresh: false,
    status: "complete",
    durationMs: 0,
    phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
  },
  targets: [],
});
const EMPTY_FRESH_WORKER_MESSAGE = EMPTY_WORKER_MESSAGE.replace('"fresh":false', '"fresh":true');
const FAILED_FRESH_WORKER_MESSAGE = EMPTY_FRESH_WORKER_MESSAGE.replace('"status":"complete"', '"status":"failed"');
const UNBOUND_TARGET_WORKER_MESSAGE = JSON.stringify({
  ...JSON.parse(EMPTY_FRESH_WORKER_MESSAGE),
  targets: [{ target: "agents:9.0", ref: ref(900, 999, "%9") }],
});
const OVERSIZED_WORKER_MESSAGE = JSON.stringify({
  type: "observation",
  payload: { system: null, sessions: [{
    target: "agents:1.0",
    panePid: 100,
    path: null,
    engine: "codex",
    hostConflict: false,
    title: "x".repeat(2_048),
    project: null,
    activity: null,
    lastActiveAt: null,
    cwd: "/repo",
    rssBytes: 1,
    swapBytes: 0,
    procCount: 1,
  }] },
  diagnostic: {
    fresh: true,
    status: "complete",
    durationMs: 0,
    phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
  },
  targets: [],
});

const entry: FileEntry = {
  path: PATHNAME,
  root: "codex-sessions",
  name: PATHNAME,
  project: "live-log-viewer-next",
  title: "Issue 31",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 200,
  model: "gpt-5.6-terra",
  pendingQuestion: null,
  waitingInput: null,
};

const duplicate: TranscriptHost = {
  tmuxServerPid: 900,
  paneId: "%2",
  panePid: 101,
  agentPid: 201,
  display: "agents:5.0",
  engine: "codex",
  cwd: "/repo",
  agentArgv: ["codex", "resume", "019f4906-3f67-7b72-9fbc-9ec3b5ad1326"],
  agentIdentity: "200:one",
  launchId: null,
  claimedPaths: [PATHNAME],
  primaryPath: PATHNAME,
};

const canonical: TranscriptHost = {
  ...duplicate,
  paneId: "%1",
  panePid: 100,
  agentPid: 200,
  display: "agents:4.0",
};

function ref(tmuxServerPid: number, panePid: number, paneId: string) {
  return {
    tmuxServerPid,
    tmuxServerStartIdentity: `${tmuxServerPid}:one`,
    panePid,
    paneStartIdentity: `${panePid}:one`,
    paneId,
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function directorySnapshot(root: string): Array<readonly [string, "directory" | "file", number, string?]> {
  const snapshot: Array<readonly [string, "directory" | "file", number, string?]> = [];
  const visit = (directory: string, relative: string) => {
    const stat = lstatSync(directory);
    snapshot.push([relative || ".", "directory", stat.mode & 0o777]);
    for (const name of readdirSync(directory).sort()) {
      const pathname = path.join(directory, name);
      const childRelative = relative ? path.join(relative, name) : name;
      const child = lstatSync(pathname);
      if (child.isDirectory()) visit(pathname, childRelative);
      else snapshot.push([childRelative, "file", child.mode & 0o777, readFileSync(pathname).toString("base64")]);
    }
  };
  visit(root, "");
  return snapshot;
}

async function expectProcessAbsentAfterQuietInterval(pid: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20 && processExists(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const leaked = processExists(pid);
  if (leaked) process.kill(pid, "SIGKILL");
  expect(leaked, label).toBeFalse();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(processExists(pid), label).toBeFalse();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CLEANUP_DEADLINE = Symbol("cleanup-deadline");

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof CLEANUP_DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof CLEANUP_DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(CLEANUP_DEADLINE), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function referencedHandles(): Set<unknown> {
  const active = (process as NodeJS.Process & { _getActiveHandles(): unknown[] })._getActiveHandles();
  return new Set(active.filter((handle) => {
    const ref = (handle as { hasRef?: () => boolean }).hasRef;
    return typeof ref !== "function" || ref.call(handle);
  }));
}

function newReferencedHandleCount(baseline: Set<unknown>): number {
  return [...referencedHandles()].filter((handle) => !baseline.has(handle)).length;
}

async function withResourceWorkerScript<T>(
  lines: string[] | ((directory: string) => string[]),
  task: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "llv-resource-worker-"));
  const executable = path.join(directory, "fixture-worker");
  const body = typeof lines === "function" ? lines(directory) : lines;
  writeFileSync(executable, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(executable, 0o700);
  const previousExecutable = process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
  process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = executable;
  try {
    return await task(directory);
  } finally {
    if (previousExecutable === undefined) delete process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
    else process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = previousExecutable;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withResourceWorkerChunks<T>(
  chunks: Buffer[],
  task: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "llv-resource-worker-chunks-"));
  const executable = path.join(directory, "fixture-worker");
  const pidFile = path.join(directory, "pid");
  const encodedChunks = JSON.stringify(chunks.map((chunk) => chunk.toString("base64")));
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `const chunks = ${encodedChunks}.map((chunk) => Buffer.from(chunk, "base64"));`,
    "let index = 0;",
    "const writeNext = () => {",
    "  if (index === chunks.length) { process.exitCode = 7; return; }",
    "  process.stderr.write(chunks[index], () => { index += 1; setTimeout(writeNext, 20); });",
    "};",
    "writeNext();",
    "",
  ].join("\n"));
  chmodSync(executable, 0o700);
  const previousExecutable = process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
  process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = executable;
  try {
    return await task(directory);
  } finally {
    if (previousExecutable === undefined) delete process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
    else process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = previousExecutable;
    rmSync(directory, { recursive: true, force: true });
  }
}

function workerTestReader(options: Parameters<typeof createResourcesReader>[4] = {}) {
  const payload: ResourcesPayload = { system: null, sessions: [] };
  const diagnostic = { fresh: true, status: "complete" as const, durationMs: 0, phases: {
    systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
  } };
  return createResourcesReader(async () => payload, () => null, Date.now, () => diagnostic, {
    readFiles: async () => [],
    initial: {
      generation: 1,
      startedAt: 1,
      completedAt: 2,
      collectorId: "durable",
      value: { payload, diagnostic, hostCount: 0, treeCount: 0, targets: [] },
    },
    ...options,
  });
}

describe("resource observation", () => {
  test("the packaged worker leaves writable and read-only homes and state trees byte-identical", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "llv-resource-package-purity-"));
    const bundleName = "packaged-resource-worker.mjs";
    try {
      const built = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "resourceCollector.worker.ts")],
        outdir: directory,
        target: "node",
        format: "esm",
        naming: bundleName,
      });
      expect(built.success).toBeTrue();

      for (const writable of [true, false]) {
        const caseDirectory = path.join(directory, writable ? "writable" : "read-only");
        const home = path.join(caseDirectory, "home");
        const state = path.join(caseDirectory, "state");
        mkdirSync(home, { recursive: true });
        mkdirSync(state, { recursive: true });
        writeFileSync(path.join(state, "sentinel"), "state-bytes\n");
        if (!writable) chmodSync(home, 0o500);
        const homeBefore = directorySnapshot(home);
        const stateBefore = directorySnapshot(state);
        const env: Record<string, string | undefined> = {
          ...process.env,
          HOME: home,
          LLV_STATE_DIR: state,
          LLV_AGENT_REGISTRY_SQLITE: "off",
          PATH: "/usr/bin:/bin",
        };
        delete env.XDG_CONFIG_HOME;
        delete env.XDG_CACHE_HOME;
        delete env.LLV_RESOURCE_COLLECTOR_IN_PROCESS;
        delete env.LLV_RESOURCE_OBSERVATION_WORKER;
        const child = Bun.spawn(["/usr/bin/node", path.join(directory, bundleName)], {
          cwd: process.cwd(),
          env,
          stdin: new Blob(["{\"type\":\"collect\",\"fresh\":false,\"files\":[]}\n"]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        expect(exit, writable ? "writable home" : "read-only home").toBe(0);
        expect(stderr, writable ? "writable home" : "read-only home").toBe("");
        expect(JSON.parse(stdout), writable ? "writable home" : "read-only home").toMatchObject({
          type: "observation",
          diagnostic: { status: "complete", fresh: false },
        });
        expect(directorySnapshot(home), writable ? "writable home" : "read-only home").toEqual(homeBefore);
        expect(directorySnapshot(state), writable ? "writable state" : "read-only state").toEqual(stateBefore);
        if (!writable) chmodSync(home, 0o700);
      }
    } finally {
      const readOnlyHome = path.join(directory, "read-only", "home");
      if (existsSync(readOnlyHome)) chmodSync(readOnlyHome, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the collector child leaves shared state byte-identical", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "llv-resource-purity-"));
    const home = path.join(directory, "home");
    const state = path.join(directory, "state");
    mkdirSync(home, { recursive: true });
    mkdirSync(state, { recursive: true });
    const staleRegistryTemp = path.join(state, "agent-registry.json.99999999.00000000-0000-4000-8000-000000000000.tmp");
    const scanSentinel = path.join(state, "files-scan-snapshot.json");
    writeFileSync(staleRegistryTemp, "stale-temp-sentinel\n");
    writeFileSync(scanSentinel, "scan-byte-sentinel\n");
    const before = readFileSync(scanSentinel);
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, LLV_STATE_DIR: state, LLV_AGENT_REGISTRY_SQLITE: "off" };
    delete env.LLV_RESOURCE_COLLECTOR_IN_PROCESS;
    const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/resourceCollector.worker.ts")], {
      cwd: process.cwd(),
      env,
      stdin: new Blob(["{\"type\":\"collect\",\"fresh\":false,\"files\":[]}\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 5_000);
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      clearTimeout(timer);
      expect(timedOut).toBeFalse();
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        type: "observation",
        diagnostic: { status: "complete", fresh: false },
      });
      expect(existsSync(staleRegistryTemp)).toBeTrue();
      expect(readFileSync(scanSentinel)).toEqual(before);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("builds host ownership and metadata from one shared transcript generation", async () => {
    let scans = 0;
    let processTableReads = 0;
    let attachBatches = 0;
    let hostFresh: boolean | null = null;
    const files = [entry];
    const payload = await buildResourceSnapshot(true, {
      readFiles: async () => {
        scans += 1;
        return files;
      },
      readHosts: async (fresh, entries, ppids) => {
        hostFresh = fresh;
        expect(entries).toBe(files);
        expect(ppids).toEqual(new Map([[200, 100], [300, 200]]));
        return {
          hosts: [canonical],
          observation: "available",
          conflicts: [],
          canonicalFor: (pathname: string) => pathname === PATHNAME ? canonical : null,
        };
      },
      proc: {
        systemMemory: () => ({ ramTotal: 1_000, ramAvailable: 750, swapTotal: 100, swapUsed: 25 }),
        ppidMap: () => {
          processTableReads += 1;
          return new Map([[200, 100], [300, 200]]);
        },
        processMemory: () => new Map([
          [100, { rssBytes: 10, swapBytes: 1 }],
          [200, { rssBytes: 20, swapBytes: 2 }],
          [300, { rssBytes: 30, swapBytes: 3 }],
        ]),
      },
      captureAttachReferences: (refs) => {
        attachBatches += 1;
        expect(refs).toEqual([{ tmuxServerPid: 900, panePid: 100, paneId: "%1" }]);
        return new Map([["%1", ref(900, 100, "%1")]]);
      },
    });

    expect(scans).toBe(1);
    expect(processTableReads).toBe(1);
    expect(attachBatches).toBe(1);
    expect(hostFresh).toBeTrue();
    expect(payload.sessions).toEqual([{
      target: "agents:4.0",
      panePid: 100,
      path: PATHNAME,
      engine: "codex",
      hostConflict: false,
      title: "Issue 31",
      project: "live-log-viewer-next",
      activity: "live",
      lastActiveAt: "1970-01-01T00:00:01.000Z",
      cwd: "/repo",
      rssBytes: 60,
      swapBytes: 6,
      procCount: 3,
    }]);
    expect(allowedKillTarget("agents:4.0")).toBeNull();
    expect(lastResourceTargetRefs()).toEqual([{ target: "agents:4.0", ref: ref(900, 100, "%1") }]);
    expect(lastResourceBuildDiagnostic()).toEqual(expect.objectContaining({
      fresh: true,
      status: "complete",
      phases: expect.objectContaining({
        readFiles: expect.any(Number),
        readHosts: expect.any(Number),
        ppidMap: expect.any(Number),
        processMemory: expect.any(Number),
        attach: expect.any(Number),
        serialization: expect.any(Number),
      }),
    }));
  });

  test("accepts a deterministic resource fixture", () => {
    const fixture = {
      system: {
        ramTotal: 34_359_738_368,
        ramAvailable: 21_474_836_480,
        swapTotal: 8_589_934_592,
        swapUsed: 1_073_741_824,
        capturedAt: "2100-01-02T12:00:00.000Z",
      },
      sessions: [],
    };

    expect(parseResourcesFixture(JSON.stringify(fixture))).toEqual(fixture);
    expect(() => parseResourcesFixture('{"system":{"ramTotal":-1},"sessions":[]}')).toThrow("invalid resources fixture");
  });

  test("durable and worker framing bounds align at the exact declared limit", () => {
    const session = {
      target: "agents:1.0",
      panePid: 100,
      path: null,
      engine: "codex" as const,
      hostConflict: false,
      title: "",
      project: null,
      activity: null,
      lastActiveAt: null,
      cwd: "/repo",
      rssBytes: 1,
      swapBytes: 0,
      procCount: 1,
    };
    const diagnostic = {
      fresh: false,
      status: "complete" as const,
      durationMs: 0,
      phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
    };
    const observation = {
      generation: 1,
      startedAt: 1,
      completedAt: 2,
      collectorId: "worker:1",
      value: { payload: { system: null, sessions: [session] }, diagnostic, hostCount: 1, treeCount: 1, targets: [] },
    };
    const base = JSON.stringify({ version: 1, observation }) + "\n";
    session.title = "x".repeat(RESOURCE_OBSERVATION_MAX_BYTES - Buffer.byteLength(base));
    const boundary = JSON.stringify({ version: 1, observation }) + "\n";
    const workerFrame = JSON.stringify({ type: "observation", payload: observation.value.payload, diagnostic, targets: [] }) + "\n";

    expect(Buffer.byteLength(boundary)).toBe(RESOURCE_OBSERVATION_MAX_BYTES);
    expect(parsePersistedResourceObservation(boundary)).toMatchObject({ generation: 1 });
    expect(Buffer.byteLength(workerFrame) <= RESOURCE_WORKER_OUTPUT_MAX_BYTES).toBeTrue();

    session.title += "x";
    const overLimit = JSON.stringify({ version: 1, observation }) + "\n";
    expect(Buffer.byteLength(overLimit)).toBe(RESOURCE_OBSERVATION_MAX_BYTES + 1);
    expect(parsePersistedResourceObservation(overLimit)).toBeNull();
  });

  test("the exact durable boundary publishes once and one extra byte fails before publication", async () => {
    const collectorId = "worker:boundary";
    const diagnostic = {
      fresh: true,
      status: "complete" as const,
      durationMs: 0,
      phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
    };
    const session = {
      target: "agents:1.0", panePid: 100, path: null, engine: "codex" as const, hostConflict: false,
      title: "", project: null, activity: null, lastActiveAt: null, cwd: "/repo", rssBytes: 1, swapBytes: 0, procCount: 1,
    };
    const value = {
      payload: { system: null, sessions: [session] },
      diagnostic,
      hostCount: 1,
      treeCount: 1,
      targets: [],
      targetEpoch: 0,
    };
    const observation = { generation: 1, startedAt: 1, completedAt: 1, collectorId, value };
    const emptyEnvelope = JSON.stringify({ version: 1, observation }) + "\n";
    session.title = "x".repeat(RESOURCE_OBSERVATION_MAX_BYTES - Buffer.byteLength(emptyEnvelope));
    const workerMessage = () => JSON.stringify({
      type: "observation",
      payload: value.payload,
      diagnostic,
      targets: [],
    });

    const persisted: string[] = [];
    await withResourceWorkerScript((directory) => {
      writeFileSync(path.join(directory, "message"), workerMessage() + "\n");
      return [`cat "${path.join(directory, "message")}"`];
    }, async () => {
      const reader = createResourcesReader(async () => value.payload, () => null, () => 1, () => diagnostic, {
        collectorId,
        readFiles: async () => [],
        persist: (candidate) => {
          persisted.push(JSON.stringify({ version: 1, observation: candidate }) + "\n");
          return true;
        },
      });
      expect((await reader.read(true)).payload.sessions).toHaveLength(1);
      await reader.read();
    });
    expect(persisted).toHaveLength(1);
    expect(Buffer.byteLength(persisted[0]!)).toBe(RESOURCE_OBSERVATION_MAX_BYTES);

    session.title += "x";
    let overLimitPersistAttempts = 0;
    await withResourceWorkerScript((directory) => {
      writeFileSync(path.join(directory, "message"), workerMessage() + "\n");
      return [
        `printf x >> "${path.join(directory, "workers")}"`,
        `cat "${path.join(directory, "message")}"`,
      ];
    }, async (directory) => {
      const reader = createResourcesReader(async () => value.payload, () => null, () => 1, () => diagnostic, {
        collectorId,
        readFiles: async () => [],
        persist: () => {
          overLimitPersistAttempts += 1;
          return false;
        },
      });
      expect((await reader.read(true)).payload.sessions).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
    });
    expect(overLimitPersistAttempts).toBe(0);
  });

  test("attributes a duplicated transcript only to the shared canonical host", () => {
    const snapshot = { hosts: [duplicate, canonical], observation: "available" as const, canonicalFor: (pathname: string) => (pathname === PATHNAME ? canonical : null) };

    expect(canonicalResourceEntry(snapshot, [duplicate], new Map([[PATHNAME, entry]]))).toBeNull();
    expect(canonicalResourceEntry(snapshot, [canonical], new Map([[PATHNAME, entry]]))).toEqual(entry);
  });

  test("marks every pane in a stable-conversation host conflict", () => {
    const snapshot = {
      hosts: [duplicate, canonical],
      observation: "available" as const,
      conflicts: [{ conversationId: "conversation_test", paths: [PATHNAME], paneIds: ["%1", "%2"] }],
      canonicalFor: () => null,
    };

    expect(conflictingResourceHost(snapshot, duplicate)).toBeTrue();
    expect(conflictingResourceHost(snapshot, canonical)).toBeTrue();
  });

  test("two handoff paths for one stable conversation form one conflict", async () => {
    const secondPath = "/home/user/.codex/sessions/2026/07/10/rollout-2026-07-10-029f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const files = resourceWorkerFileSnapshot([
      entry,
      { ...entry, path: secondPath, name: secondPath, pid: 201 },
    ], () => "conversation_test");
    const conversationByPath = new Map(files.map((file) => [file.path, file.conversationId]));
    const observe = createTranscriptHostObserver({
      listFiles: async () => files as FileEntry[],
      panes: async () => ({
        kind: "available",
        panes: new Map([
          [100, { paneId: "%1", target: "agents:4.0" }],
          [101, { paneId: "%2", target: "agents:5.0" }],
        ]),
      }),
      ppidMap: () => new Map([[200, 100], [201, 101]]),
      agents: () => [
        { pid: 200, engine: "codex", argv: ["codex", "resume", "019f4906-3f67-7b72-9fbc-9ec3b5ad1326"], cwd: "/repo", tty: 1 },
        { pid: 201, engine: "codex", argv: ["codex", "resume", "029f4906-3f67-7b72-9fbc-9ec3b5ad1326"], cwd: "/repo", tty: 1 },
      ],
      serverPid: async () => 900,
      resumeRecords: async () => null,
      identity: (pid) => `${pid}:one`,
      conversationIdForPath: (pathname) => conversationByPath.get(pathname) ?? null,
    });

    const snapshot = await observe(true, files as FileEntry[]);

    expect(snapshot.conflicts).toEqual([{
      conversationId: "conversation_test",
      paths: [PATHNAME, secondPath],
      paneIds: ["%1", "%2"],
    }]);
    expect(snapshot.canonicalFor(PATHNAME)).toBeNull();
    expect(snapshot.canonicalFor(secondPath)).toBeNull();
  });

  test("worker launch selection preserves Docker Bun and supports a Node-only bundle", () => {
    const cwd = "/package";
    const sourceWorker = "/package/src/lib/resourceCollector.worker.ts";
    const bundledWorker = "/package/.next/server/resource-collector-worker.js";
    const bunContainer = "/usr/local/bin/bun-container";

    expect(resolveResourceWorkerLaunch({
      cwd,
      env: { NODE_ENV: "test", LLV_RESOURCE_COLLECTOR_EXECUTABLE: "/fixture/worker" },
      execPath: "/usr/bin/node",
      exists: () => false,
    })).toEqual({ executable: "/fixture/worker", workerPath: sourceWorker });
    expect(resolveResourceWorkerLaunch({
      cwd,
      env: { NODE_ENV: "test" },
      execPath: "/usr/bin/node",
      exists: (pathname) => pathname === bunContainer || pathname === bundledWorker,
    })).toEqual({ executable: bunContainer, workerPath: sourceWorker });
    expect(resolveResourceWorkerLaunch({
      cwd,
      env: { NODE_ENV: "test" },
      execPath: "/usr/bin/node",
      exists: (pathname) => pathname === bundledWorker,
    })).toEqual({ executable: "/usr/bin/node", workerPath: bundledWorker });
  });
});

describe("kill-target allowlist", () => {
  test("durable display hydration grants no kill capability until a current observation", async () => {
    const targetRef = ref(900, 111, "%11");
    const session = {
      target: "agents:1.0",
      panePid: 111,
      path: null,
      engine: "codex" as const,
      hostConflict: false,
      title: null,
      project: null,
      activity: null,
      lastActiveAt: null,
      cwd: "/repo",
      rssBytes: 1,
      swapBytes: 0,
      procCount: 1,
    };
    const diagnostic = {
      fresh: true,
      status: "complete" as const,
      durationMs: 0,
      phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
    };
    const message = JSON.stringify({
      type: "observation",
      payload: { system: null, sessions: [session] },
      diagnostic,
      targets: [{ target: session.target, ref: targetRef }],
    });

    await withResourceWorkerScript([`printf '%s\\n' '${message}'`], async () => {
      resetResourcesForTests();
      const reader = workerTestReader({
        initial: {
          generation: 7,
          startedAt: 1,
          completedAt: 2,
          collectorId: "prior-runtime",
          value: {
            payload: { system: null, sessions: [session] },
            diagnostic,
            hostCount: 1,
            treeCount: 1,
            targets: [{ target: session.target, ref: targetRef }],
          },
        },
      });

      expect((await reader.read()).payload.sessions).toHaveLength(1);
      expect(allowedKillTarget(session.target)).toBeNull();
      await reader.read(true);
      expect(allowedKillTarget(session.target)).toEqual(targetRef);
    });
  });

  test("a worker collection started before target consumption cannot restore it", async () => {
    const targetRef = ref(900, 111, "%11");
    const session = {
      target: "agents:1.0", panePid: 111, path: null, engine: "codex" as const, hostConflict: false,
      title: null, project: null, activity: null, lastActiveAt: null, cwd: "/repo", rssBytes: 1, swapBytes: 0, procCount: 1,
    };
    const message = JSON.stringify({
      type: "observation",
      payload: { system: null, sessions: [session] },
      diagnostic: {
        fresh: true, status: "complete", durationMs: 0,
        phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
      },
      targets: [{ target: session.target, ref: targetRef }],
    });

    await withResourceWorkerScript([`printf '%s\\n' '${message}'`], async () => {
      resetResourcesForTests();
      noteSessionTargets([{ target: session.target, ref: targetRef }]);
      const started = deferred<void>();
      const release = deferred<never[]>();
      let handoffs = 0;
      const reader = workerTestReader({
        readFiles: async () => {
          handoffs += 1;
          if (handoffs === 1) {
            started.resolve();
            return release.promise;
          }
          return [];
        },
      });

      const stale = reader.read(true);
      await started.promise;
      consumeKillTarget(session.target);
      release.resolve([]);
      await stale;
      expect(allowedKillTarget(session.target)).toBeNull();

      await reader.read(true);
      expect(allowedKillTarget(session.target)).toEqual(targetRef);
    });
  });

  test("an in-process collection started before target consumption cannot restore it", async () => {
    resetResourcesForTests();
    const targetRef = ref(900, 100, "%1");
    noteSessionTargets([{ target: canonical.display, ref: targetRef }]);
    const started = deferred<void>();
    const release = deferred<void>();
    let builds = 0;
    const reader = createResourcesReader((fresh) => buildResourceSnapshot(fresh, {
      readFiles: async () => {
        builds += 1;
        if (builds === 1) {
          started.resolve();
          await release.promise;
        }
        return [entry];
      },
      readHosts: async () => ({
        hosts: [canonical],
        observation: "available",
        conflicts: [],
        canonicalFor: (pathname) => pathname === PATHNAME ? canonical : null,
      }),
      proc: {
        systemMemory: () => null,
        ppidMap: () => new Map([[200, 100]]),
        processMemory: () => new Map([[100, { rssBytes: 1, swapBytes: 0 }], [200, { rssBytes: 1, swapBytes: 0 }]]),
      },
      captureAttachReferences: () => new Map([["%1", targetRef]]),
    }), () => null, Date.now, lastResourceBuildDiagnostic, { inProcess: true });

    const stale = reader.read(true);
    await started.promise;
    consumeKillTarget(canonical.display);
    release.resolve();
    await stale;
    expect(allowedKillTarget(canonical.display)).toBeNull();

    await reader.read(true);
    expect(allowedKillTarget(canonical.display)).toEqual(targetRef);
  });

  test("nothing is killable before a snapshot exists", () => {
    noteSessionTargets([]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("")).toBeNull();
  });

  test("only targets from the last snapshot pass, each with its pane id and pid", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: ref(900, 111, "%11") },
      { target: "agents:2.0", ref: ref(900, 222, "%22") },
    ]);
    expect(allowedKillTarget("agents:1.0")).toEqual(ref(900, 111, "%11"));
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
    expect(allowedKillTarget("agents:3.0")).toBeNull();
    expect(allowedKillTarget("main:0.0")).toBeNull();
  });

  test("a new snapshot fully replaces the allowlist", () => {
    noteSessionTargets([{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    noteSessionTargets([{ target: "agents:2.0", ref: ref(900, 222, "%22") }]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
  });

  test("a consumed target no longer passes — tmux may reuse its coordinates", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: ref(900, 111, "%11") },
      { target: "agents:2.0", ref: ref(900, 222, "%22") },
    ]);
    consumeKillTarget("agents:1.0");
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
  });

  test("an older observation cannot re-arm a concurrently consumed target", () => {
    applyResourceTargets(2, [{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    consumeKillTarget("agents:1.0");
    applyResourceTargets(1, [{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
  });

  test("a reset drops the global reader, diagnostics, and allowlist", () => {
    noteSessionTargets([{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    resetResourcesForTests();
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(lastResourceBuildDiagnostic()).toBeNull();
  });
});

describe("resource recurring reads", () => {
  test("the full scaled deadline settles after maximum handoff and TERM-resistant group cleanup", async () => {
    const scale = 0.04;
    const observeTimeoutMs = 30_000 * scale;
    const inputTimeoutMs = 500 * scale;
    const timeoutMs = 29_500 * scale;
    const closeTimeoutMs = 1_000 * scale;
    const headroomMs = 500 * scale;

    await withResourceWorkerScript((directory) => {
      const descendantPid = path.join(directory, "deadline-descendant-pid");
      const ready = path.join(directory, "deadline-descendant-ready");
      return [
        `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
        "trap 'exit 0' TERM INT",
        `sh -c 'trap "" TERM INT; printf "%s" "$$" > "$1"; : > "$2"; while :; do sleep 1; done' sh "${descendantPid}" "${ready}" &`,
        `while [ ! -e "${ready}" ]; do sleep 0.01; done`,
        "while :; do sleep 0.01; done",
      ];
    }, async (directory) => {
      const startedAt = performance.now();
      const read = workerTestReader({
        readFiles: async () => {
          await new Promise((resolve) => setTimeout(resolve, inputTimeoutMs));
          return [];
        },
        workerLimits: { observeTimeoutMs, inputTimeoutMs, timeoutMs, closeTimeoutMs, headroomMs },
      }).read(true);
      const outerDeadline = Symbol("outer-deadline");
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        read,
        new Promise<typeof outerDeadline>((resolve) => {
          deadlineTimer = setTimeout(() => resolve(outerDeadline), observeTimeoutMs);
        }),
      ]);
      const outcome = first === outerDeadline ? await read : first;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const elapsedMs = performance.now() - startedAt;
      const workerPid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
      const descendantPid = Number(readFileSync(path.join(directory, "deadline-descendant-pid"), "utf8"));

      expect(first === outerDeadline).toBeFalse();
      expect(elapsedMs).toBeLessThan(observeTimeoutMs);
      expect(outcome).toMatchObject({ diagnostic: {
        degradedReason: "timeout",
        failure: { cause: "worker-timeout" },
      } });
      expect(processExists(workerPid)).toBeFalse();
      expect(processExists(descendantPid)).toBeFalse();
      expect(() => process.kill(-workerPid, 0)).toThrow();
    });
  });

  test("an exited leader cleans up a TERM-resistant descendant that holds both output pipes", async () => {
    await withResourceWorkerScript((directory) => {
      const descendantPid = path.join(directory, "descendant-pid");
      const ready = path.join(directory, "descendant-ready");
      return [
        `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
        `sh -c 'trap "" TERM INT; printf "%s" "$$" > "$1"; : > "$2"; while :; do sleep 1; done' sh "${descendantPid}" "${ready}" &`,
        `while [ ! -e "${ready}" ]; do sleep 0.01; done`,
        "exit 0",
      ];
    }, async (directory) => {
      const startedAt = performance.now();
      const outcome = await workerTestReader({ workerLimits: { timeoutMs: 500, closeTimeoutMs: 25 } }).read(true);
      const elapsedMs = performance.now() - startedAt;
      const workerPid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
      const descendantPid = Number(readFileSync(path.join(directory, "descendant-pid"), "utf8"));

      expect(outcome).toMatchObject({ diagnostic: {
        degradedReason: "collector-crash",
        failure: { cause: "worker-exit" },
      } });
      expect(elapsedMs).toBeLessThan(250);
      expect(processGroupExists(workerPid)).toBeFalse();
      expect(processExists(descendantPid)).toBeFalse();
      await expectProcessAbsentAfterQuietInterval(workerPid, "exited leader");
      await expectProcessAbsentAfterQuietInterval(descendantPid, "pipe-holding descendant");
    });
  });

  test("a complete observation arriving from inherited stdout after leader exit still wins before close", async () => {
    await withResourceWorkerScript((directory) => {
      const writerPid = path.join(directory, "late-writer-pid");
      return [
        `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
        `sh -c 'trap "" TERM INT; printf "%s" "$$" > "$1"; sleep 0.02; printf "%s\\n" "$2"' sh "${writerPid}" '${EMPTY_FRESH_WORKER_MESSAGE}' &`,
        "exit 0",
      ];
    }, async (directory) => {
      const outcome = await settleWithin(workerTestReader({
        initial: null,
        workerLimits: { observeTimeoutMs: 400, inputTimeoutMs: 10, timeoutMs: 200, closeTimeoutMs: 100, headroomMs: 100 },
      }).read(true), 300);
      const writerPid = Number(readFileSync(path.join(directory, "late-writer-pid"), "utf8"));

      expect(outcome === CLEANUP_DEADLINE).toBeFalse();
      if (outcome === CLEANUP_DEADLINE) return;
      expect(outcome.diagnostic.degradedReason).toBeUndefined();
      expect(outcome.diagnostic.status).toBe("complete");
      expect(processExists(writerPid)).toBeFalse();
    });
  });

  test("a successful read settles after a TERM-resistant redirected process group is absent", async () => {
    await withResourceWorkerScript((directory) => {
      const descendantPid = path.join(directory, "redirected-descendant-pid");
      const ready = path.join(directory, "redirected-descendant-ready");
      return [
        `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
        "trap 'exit 0' TERM INT",
        `sh -c 'trap "" TERM INT; printf "%s" "$$" > "$1"; : > "$2"; while :; do sleep 1; done' sh "${descendantPid}" "${ready}" </dev/null >/dev/null 2>&1 &`,
        `while [ ! -e "${ready}" ]; do sleep 0.01; done`,
        `printf '%s\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
        "while :; do sleep 0.01; done",
      ];
    }, async (directory) => {
      const outcome = await workerTestReader({
        initial: null,
        workerLimits: { timeoutMs: 500, closeTimeoutMs: 150 },
      }).read(true);
      const workerPid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
      const descendantPid = Number(readFileSync(path.join(directory, "redirected-descendant-pid"), "utf8"));
      const groupPresentAtSettlement = processGroupExists(workerPid);

      if (groupPresentAtSettlement) process.kill(-workerPid, "SIGKILL");
      expect(outcome.diagnostic.degradedReason).toBeUndefined();
      expect(groupPresentAtSettlement).toBeFalse();
      await expectProcessAbsentAfterQuietInterval(descendantPid, "redirected descendant");
    });
  });

  test("success, failure, and timeout settle after redirected and inherited process groups are absent", async () => {
    const fixtures = [
      { name: "success", output: `printf '%s\\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`, expected: { fresh: true, status: "complete" } },
      { name: "failure", output: "printf '{invalid}\\n'", expected: { degradedReason: "collector-crash", failure: { cause: "worker-output-invalid" } } },
      { name: "timeout", output: "", expected: { degradedReason: "timeout", failure: { cause: "worker-timeout" } } },
    ] as const;

    for (const pipes of ["redirected", "inherited"] as const) {
      for (const fixture of fixtures) {
        await withResourceWorkerScript((directory) => {
          const descendantPid = path.join(directory, "matrix-descendant-pid");
          const ready = path.join(directory, "matrix-descendant-ready");
          const redirect = pipes === "redirected" ? " </dev/null >/dev/null 2>&1" : "";
          return [
            `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
            "trap 'exit 0' TERM INT",
            `sh -c 'trap "" TERM INT; printf "%s" "$$" > "$1"; : > "$2"; while :; do sleep 1; done' sh "${descendantPid}" "${ready}"${redirect} &`,
            `while [ ! -e "${ready}" ]; do sleep 0.01; done`,
            fixture.output,
            "while :; do sleep 0.01; done",
          ];
        }, async (directory) => {
          const outcome = await workerTestReader({
            initial: null,
            workerLimits: { timeoutMs: 50, closeTimeoutMs: 50 },
          }).read(true);
          const workerPid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
          const descendantPid = Number(readFileSync(path.join(directory, "matrix-descendant-pid"), "utf8"));
          const label = `${pipes} ${fixture.name}`;
          const groupPresentAtSettlement = processGroupExists(workerPid);

          if (groupPresentAtSettlement) process.kill(-workerPid, "SIGKILL");
          expect(outcome.diagnostic, label).toMatchObject(fixture.expected);
          expect(groupPresentAtSettlement, label).toBeFalse();
          expect(processExists(descendantPid), label).toBeFalse();
        });
      }
    }
  });

  test("cleanup has a terminal deadline and preserves every primary failure through persistent EPERM", async () => {
    const fixtures = [
      {
        name: "parse",
        lines: ["printf 'parse-trace\\n' >&2", "printf '{invalid}\\n'", "while :; do sleep 0.01; done"],
        expectedCause: "worker-output-invalid",
        expectedStderr: "parse-trace",
        limits: { timeoutMs: 80, outputMaxBytes: 256 },
      },
      {
        name: "crash",
        lines: ["printf 'crash-trace\\n' >&2", "exit 7"],
        expectedCause: "worker-exit",
        expectedStderr: "crash-trace",
        limits: { timeoutMs: 80, outputMaxBytes: 256 },
      },
      {
        name: "output",
        lines: ["printf 'output-trace\\n' >&2", "printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'", "while :; do sleep 0.01; done"],
        expectedCause: "worker-output-limit",
        expectedStderr: "output-trace",
        limits: { timeoutMs: 80, outputMaxBytes: 24 },
      },
      {
        name: "timeout",
        lines: ["printf 'timeout-trace\\n' >&2", "while :; do sleep 0.01; done"],
        expectedCause: "worker-timeout",
        expectedStderr: "timeout-trace",
        limits: { timeoutMs: 20, outputMaxBytes: 256 },
      },
    ] as const;

    for (const fixture of fixtures) {
      await withResourceWorkerScript((directory) => [
        `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
        "trap 'exit 0' TERM INT",
        ...fixture.lines,
      ], async (directory) => {
        const realKill = process.kill.bind(process);
        const kill = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
          if (pid < 0) throw errno("EPERM");
          return realKill(pid, signal as NodeJS.Signals | number | undefined);
        }) as typeof process.kill);
        const baseline = referencedHandles();
        const read = workerTestReader({
          initial: null,
          workerLimits: { observeTimeoutMs: 300, inputTimeoutMs: 10, closeTimeoutMs: 10, headroomMs: 40, ...fixture.limits },
        }).read(true);
        let initial: Awaited<typeof read> | typeof CLEANUP_DEADLINE;
        try {
          initial = await settleWithin(read, 120);
        } finally {
          kill.mockRestore();
        }
        const workerPid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
        try {
          realKill(-workerPid, "SIGKILL");
        } catch {}
        const final = await settleWithin(read, 300);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const handles = newReferencedHandleCount(baseline);

        expect(initial === CLEANUP_DEADLINE, fixture.name).toBeFalse();
        if (initial === CLEANUP_DEADLINE) return;
        expect(initial.diagnostic.failure, fixture.name).toMatchObject({
          cause: fixture.expectedCause,
          stderr: expect.stringContaining(fixture.expectedStderr),
          causes: expect.arrayContaining(["resource collector worker cleanup deadline expired"]),
        });
        expect(final === CLEANUP_DEADLINE, `${fixture.name} final settlement`).toBeFalse();
        expect(handles, `${fixture.name} referenced handles`).toBe(0);
      });
    }
  });

  test("ineffective TERM and SIGKILL settle once with cleanup failure and zero referenced handles", async () => {
    await withResourceWorkerScript((directory) => [
      `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
      "trap '' TERM INT",
      "printf 'ineffective-signal-trace\\n' >&2",
      `printf '%s\\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
      "while :; do sleep 0.01; done",
    ], async (directory) => {
      const realKill = process.kill.bind(process);
      const kill = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (pid !== process.pid) return true;
        return realKill(pid, signal as NodeJS.Signals | number | undefined);
      }) as typeof process.kill);
      const baseline = referencedHandles();
      const read = workerTestReader({
        initial: null,
        workerLimits: { observeTimeoutMs: 300, inputTimeoutMs: 10, timeoutMs: 80, closeTimeoutMs: 10, headroomMs: 40 },
      }).read(true);
      let initial: Awaited<typeof read> | typeof CLEANUP_DEADLINE;
      let handles = -1;
      try {
        initial = await settleWithin(read, 120);
        if (initial !== CLEANUP_DEADLINE) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          handles = newReferencedHandleCount(baseline);
        }
      } finally {
        kill.mockRestore();
      }
      const workerPid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
      try {
        realKill(-workerPid, "SIGKILL");
      } catch {}
      await settleWithin(read, 300);

      expect(initial === CLEANUP_DEADLINE).toBeFalse();
      if (initial === CLEANUP_DEADLINE) return;
      expect(initial.diagnostic).toMatchObject({
        degradedReason: "collector-crash",
        failure: {
          cause: "worker-cleanup",
          stderr: expect.stringContaining("ineffective-signal-trace"),
          causes: expect.arrayContaining(["resource collector worker cleanup deadline expired"]),
        },
      });
      expect(handles).toBe(0);
    });
  });

  test("ESRCH cleanup settles without a secondary failure or referenced handles", async () => {
    await withResourceWorkerScript((directory) => [
      `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
      `printf '%s\\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
      "exit 0",
    ], async () => {
      const realKill = process.kill.bind(process);
      const kill = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (pid < 0) throw errno("ESRCH");
        return realKill(pid, signal as NodeJS.Signals | number | undefined);
      }) as typeof process.kill);
      const baseline = referencedHandles();
      let outcome: Awaited<ReturnType<ReturnType<typeof workerTestReader>["read"]>> | typeof CLEANUP_DEADLINE;
      try {
        outcome = await settleWithin(workerTestReader({ initial: null }).read(true), 200);
      } finally {
        kill.mockRestore();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome === CLEANUP_DEADLINE).toBeFalse();
      if (outcome === CLEANUP_DEADLINE) return;
      expect(outcome.diagnostic.degradedReason).toBeUndefined();
      expect(newReferencedHandleCount(baseline)).toBe(0);
    });
  });

  test("an owned escaped descendant retaining inherited pipes is supervised to bounded completion", async () => {
    await withResourceWorkerScript((directory) => {
      const descendantPid = path.join(directory, "escaped-descendant-pid");
      const ready = path.join(directory, "escaped-descendant-ready");
      return [
        `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
        `setsid sh -c 'trap "" TERM INT; printf "%s" "$$" > "$1"; : > "$2"; while :; do sleep 1; done' sh "${descendantPid}" "${ready}" &`,
        `while [ ! -e "${ready}" ]; do sleep 0.01; done`,
        `printf '%s\\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
        "exit 0",
      ];
    }, async (directory) => {
      const baseline = referencedHandles();
      const read = workerTestReader({
        initial: null,
        workerLimits: { observeTimeoutMs: 400, inputTimeoutMs: 10, timeoutMs: 100, closeTimeoutMs: 30, headroomMs: 80 },
      }).read(true);
      const initial = await settleWithin(read, 250);
      const workerPid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
      const descendantPid = Number(readFileSync(path.join(directory, "escaped-descendant-pid"), "utf8"));
      if (initial === CLEANUP_DEADLINE) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
        try {
          process.kill(-workerPid, "SIGKILL");
        } catch {}
        await settleWithin(read, 300);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const handles = newReferencedHandleCount(baseline);

      expect(initial === CLEANUP_DEADLINE).toBeFalse();
      if (initial === CLEANUP_DEADLINE) return;
      expect(initial.diagnostic.degradedReason).toBeUndefined();
      expect(processExists(descendantPid)).toBeFalse();
      expect(handles).toBe(0);
    });
  });

  test("leader-first cleanup sends no signals to recycled or null-identity groups", async () => {
    for (const identity of ["recycled", "null"] as const) {
      await withResourceWorkerScript((directory) => [
        `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
        "exit 0",
      ], async () => {
        const realKill = process.kill.bind(process);
        let identityReads = 0;
        const processIdentity = spyOn(procBackend, "processIdentity").mockImplementation((pid) => {
          if (identity === "null") return null;
          identityReads += 1;
          return identityReads === 1 ? `${pid}:owned` : `${pid}:recycled`;
        });
        const signals: Array<string | number | undefined> = [];
        const kill = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
          if (pid < 0 && signal !== 0 && signal !== undefined) {
            signals.push(signal);
            return true;
          }
          if (pid < 0) throw errno("ESRCH");
          return realKill(pid, signal as NodeJS.Signals | number | undefined);
        }) as typeof process.kill);
        let outcome: Awaited<ReturnType<ReturnType<typeof workerTestReader>["read"]>> | typeof CLEANUP_DEADLINE;
        try {
          outcome = await settleWithin(workerTestReader({
            initial: null,
            workerLimits: { observeTimeoutMs: 300, inputTimeoutMs: 10, timeoutMs: 80, closeTimeoutMs: 10, headroomMs: 40 },
          }).read(true), 150);
        } finally {
          kill.mockRestore();
          processIdentity.mockRestore();
        }

        expect(outcome === CLEANUP_DEADLINE, identity).toBeFalse();
        expect(signals, identity).toEqual([]);
      });
    }
  });

  test("individual cleanup revalidates identity after a verified group signal", async () => {
    await withResourceWorkerScript([
      `printf '%s\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
      "exit 0",
    ], async () => {
      let recycled = false;
      const groupSignals: NodeJS.Signals[] = [];
      const individualSignals: NodeJS.Signals[] = [];
      const outcome = await workerTestReader({
        initial: null,
        workerLimits: { observeTimeoutMs: 300, inputTimeoutMs: 10, timeoutMs: 80, closeTimeoutMs: 10, headroomMs: 40 },
        workerProcessRuntime: {
          pidAlive: () => !recycled,
          processIdentity: (pid) => `${pid}:${recycled ? "recycled" : "owned"}`,
          descendants: (pid) => [pid],
          processGroupId: (pid) => pid,
          processGroupMembers: () => [],
          signal: (pid, signal) => {
            if (pid < 0 && signal === 0) {
              if (recycled) throw errno("ESRCH");
              return;
            }
            if (pid < 0) {
              groupSignals.push(signal as NodeJS.Signals);
              recycled = true;
              return;
            }
            individualSignals.push(signal as NodeJS.Signals);
          },
        },
      }).read(true);

      expect(outcome.diagnostic.degradedReason).toBeUndefined();
      expect(groupSignals).toEqual(["SIGTERM"]);
      expect(individualSignals).toEqual([]);
    });
  });

  test("a near-limit handoff to an immediately exiting worker keeps the parent alive and releases the worker", async () => {
    await withResourceWorkerScript((directory) => [
      `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
      "exit 0",
    ], async (directory) => {
      const entrypoint = path.join(directory, "node-parent.ts");
      const bundle = path.join(directory, "node-parent.mjs");
      writeFileSync(entrypoint, `
        import { createResourcesReader } from ${JSON.stringify(path.join(import.meta.dir, "resources.ts"))};
        const diagnostic = { fresh: true, status: "complete", durationMs: 0, phases: {
          systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
        } };
        const reader = createResourcesReader(async () => ({ system: null, sessions: [] }), () => null, Date.now, () => diagnostic, {
          readFiles: async () => [{
            path: "/sessions/large-handoff.jsonl", parent: null, title: "x".repeat(15 * 1024 * 1024), project: "project",
            activity: "live", mtime: 1, engine: "codex", pid: 200, proc: "running", conversationId: null,
          }],
          initial: {
            generation: 1, startedAt: 1, completedAt: 2, collectorId: "durable",
            value: { payload: { system: null, sessions: [] }, diagnostic, hostCount: 0, treeCount: 0, targets: [] },
          },
        });
        const result = await reader.read(true);
        process.stdout.write(JSON.stringify(result.diagnostic) + "\\n");
      `);
      const built = await Bun.build({ entrypoints: [entrypoint], outdir: directory, target: "node", format: "esm", naming: path.basename(bundle) });
      expect(built.success).toBeTrue();
      const child = Bun.spawn(["node", bundle], {
        cwd: process.cwd(),
        env: { ...process.env, LLV_RESOURCE_COLLECTOR_EXECUTABLE: path.join(directory, "fixture-worker"), PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

      expect(exit).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ degradedReason: "collector-crash" });
      const pid = Number(readFileSync(path.join(directory, "pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  test("an incomplete observation message settles promptly with a degraded response", async () => {
    await withResourceWorkerScript([
      "trap 'exit 0' TERM INT",
      "printf '{\"type\":\"observation\"}\\n'",
      "while :; do sleep 0.01; done",
    ], async () => {
      const reader = workerTestReader();
      const outcome = await Promise.race([
        reader.read(true),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250)),
      ]);

      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({
        payload: { system: null, sessions: [] },
        diagnostic: { degradedReason: "collector-crash" },
      });
    });
  });

  test("an observation with invalid nested types settles promptly with a degraded response", async () => {
    await withResourceWorkerScript([
      "trap 'exit 0' TERM INT",
      "printf '{\"type\":\"observation\",\"payload\":{\"system\":null,\"sessions\":\"invalid\"},\"diagnostic\":{},\"targets\":[]}\\n'",
      "while :; do sleep 0.01; done",
    ], async () => {
      const reader = workerTestReader();
      const outcome = await Promise.race([
        reader.read(true),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250)),
      ]);

      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
    });
  });

  test("semantically invalid observations cannot publish kill targets or failed builds", async () => {
    for (const message of [UNBOUND_TARGET_WORKER_MESSAGE, FAILED_FRESH_WORKER_MESSAGE]) {
      await withResourceWorkerScript([
        `printf '%s\\n' '${message}'`,
      ], async () => {
        const outcome = await workerTestReader().read(true);
        expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
      });
    }
  });

  test("a fresh request rejects an observation labeled as ordinary", async () => {
    await withResourceWorkerScript([
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async () => {
      const outcome = await workerTestReader().read(true);
      expect(outcome).toMatchObject({ diagnostic: { degradedReason: "collector-crash" } });
    });
  });

  test("an ordinary worker crash reports its typed cause, requested freshness, identity, and safe stderr", async () => {
    await withResourceWorkerScript([
      "printf 'API_TOKEN=super-secret\\n' >&2",
      "exit 7",
    ], async () => {
      const outcome = await workerTestReader({ initial: null, collectorId: "worker:test" }).read();
      expect(outcome.diagnostic).toMatchObject({
        fresh: false,
        status: "failed",
        collectorId: "worker:test",
        degradedReason: "collector-crash",
        cache: { status: "miss" },
        failure: {
          cause: "worker-exit",
          stderr: "API_TOKEN=<redacted>",
        },
      });
    });
  });

  test("a keyed Authorization Bearer credential is fully redacted from worker stderr", async () => {
    await withResourceWorkerScript([
      "printf 'Authorization: Bearer tracer-secret-sentinel\\nsafe diagnostic suffix\\n' >&2",
      "exit 7",
    ], async () => {
      const outcome = await workerTestReader({ initial: null }).read();
      const stderr = outcome.diagnostic.failure?.stderr ?? "";

      expect(stderr).toContain("Authorization=<redacted>");
      expect(stderr).toContain("safe diagnostic suffix");
      expect(stderr).not.toContain("tracer-secret-sentinel");
    });
  });

  test("a fresh worker crash attributes its durable cache and bounds redacted stderr", async () => {
    await withResourceWorkerScript([
      "yes 'safe stderr line' | head -c 4096 >&2",
      "printf '\\nPASSWORD=fresh-secret\\n' >&2",
      "exit 7",
    ], async () => {
      const outcome = await workerTestReader({ collectorId: "worker:fresh-test" }).read(true);
      expect(outcome.diagnostic).toMatchObject({
        fresh: true,
        status: "failed",
        collectorId: "worker:fresh-test",
        degradedReason: "collector-crash",
        cache: { status: "durable", collectorId: "durable", generation: 1 },
        failure: { cause: "worker-exit" },
      });
      const stderr = outcome.diagnostic.failure?.stderr ?? "";
      expect(Buffer.byteLength(stderr)).toBe(RESOURCE_FAILURE_STDERR_MAX_BYTES);
      expect(stderr).toContain("PASSWORD=<redacted>");
      expect(stderr).not.toContain("fresh-secret");
    });
  });

  test("stderr pipe decoding preserves UTF-8 split at every byte boundary", async () => {
    const chunks = [Buffer.from("discarded-prefix\n".repeat(300))];
    const expected: string[] = [];
    for (const character of ["é", "€", "😀"]) {
      const encoded = Buffer.from(character);
      for (let split = 1; split < encoded.length; split += 1) {
        const label = `${encoded.length}-byte-${split}+${encoded.length - split}:`;
        expected.push(`${label}${character}`);
        chunks.push(Buffer.concat([Buffer.from(label), encoded.subarray(0, split)]));
        chunks.push(Buffer.concat([encoded.subarray(split), Buffer.from("\n")]));
      }
    }
    chunks.push(Buffer.from("Authorization: Bearer split-secret\ncollector-tail-complete"));
    const rawOutputBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);

    await withResourceWorkerChunks(chunks, async (directory) => {
      const outcome = await Promise.race([
        workerTestReader({ initial: null, workerLimits: { outputMaxBytes: rawOutputBytes } }).read(),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);

      expect(outcome === "hung").toBeFalse();
      if (outcome === "hung") return;
      expect(outcome).toMatchObject({ diagnostic: {
        degradedReason: "collector-crash",
        failure: { cause: "worker-exit" },
      } });
      const stderr = outcome.diagnostic.failure?.stderr ?? "";
      expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
      expect(stderr).not.toContain("\uFFFD");
      for (const value of expected) expect(stderr).toContain(value);
      expect(stderr).toContain("Authorization=<redacted>");
      expect(stderr).not.toContain("split-secret");
      expect(stderr.endsWith("collector-tail-complete")).toBeTrue();
      await expectProcessAbsentAfterQuietInterval(Number(readFileSync(path.join(directory, "pid"), "utf8")), "split stderr worker");
    });
  });

  test("a credential longer than the retained stderr window leaks no punctuated value bytes", async () => {
    const secret = Array.from({ length: 1_000 }, (_, index) => `LEAK${index.toString().padStart(4, "0")}!`).join("");
    const chunks = [
      Buffer.from("API_TOKEN="),
      Buffer.from(secret),
      Buffer.from("\nsafe diagnostic suffix"),
    ];
    const rawOutputBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);

    await withResourceWorkerChunks(chunks, async () => {
      const outcome = await workerTestReader({
        initial: null,
        workerLimits: { outputMaxBytes: rawOutputBytes },
      }).read();
      const stderr = outcome.diagnostic.failure?.stderr ?? "";

      expect(stderr).toContain("API_TOKEN=<redacted>");
      expect(stderr).toContain("safe diagnostic suffix");
      expect(stderr).not.toMatch(/LEAK\d{4}/);
      expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
    });
  });

  test("split and evicted credential prefixes retain redaction state across stderr chunks", async () => {
    const splitSecret = "SPLITLEAK!".repeat(700);
    const evictedKey = `TOKEN${".A".repeat(300)}`;
    const evictedSecret = "EVICTEDLEAK?".repeat(700);
    const spacedSecret = "SPACEDLEAK;".repeat(700);
    const bearerSecret = "BEARERLEAK:".repeat(700);
    const quotedSecret = "QUOTEDLEAK; ".repeat(700);
    const chunks = [
      Buffer.from("AUTHORI"),
      Buffer.from("ZATION = "),
      Buffer.from(splitSecret),
      Buffer.from("\n"),
      Buffer.from(`${evictedKey}=`),
      Buffer.from(evictedSecret),
      Buffer.from("\nPASSWORD" + " ".repeat(600)),
      Buffer.from("="),
      Buffer.from(spacedSecret),
      Buffer.from("\nBearer" + " ".repeat(600)),
      Buffer.from(bearerSecret),
      Buffer.from("\nCOOKIE=\""),
      Buffer.from(quotedSecret),
      Buffer.from("\""),
      Buffer.from("\nsafe suffix after all credentials"),
    ];
    const rawOutputBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);

    await withResourceWorkerChunks(chunks, async () => {
      const outcome = await workerTestReader({
        initial: null,
        workerLimits: { outputMaxBytes: rawOutputBytes },
      }).read();
      const stderr = outcome.diagnostic.failure?.stderr ?? "";

      expect(stderr).toContain("AUTHORIZATION=<redacted>");
      expect(stderr).toContain("<redacted>");
      expect(stderr).toContain("safe suffix after all credentials");
      expect(stderr).not.toContain("SPLITLEAK");
      expect(stderr).not.toContain("EVICTEDLEAK");
      expect(stderr).not.toContain("SPACEDLEAK");
      expect(stderr).not.toContain("BEARERLEAK");
      expect(stderr).not.toContain("QUOTEDLEAK");
      expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
    });
  });

  test("the resources route preserves split UTF-8 diagnostics in a header-safe value", async () => {
    const diagnostic = {
      status: "failed",
      failure: { stderr: "2-byte:é\n3-byte:€\n4-byte:😀\ncollector-tail-complete" },
    };
    const header = resourceDiagnosticHeader(diagnostic);

    expect([...header].every((character) => character.charCodeAt(0) <= 0x7e)).toBeTrue();
    expect(JSON.parse(header)).toEqual(diagnostic);
  });

  test("malformed, oversized, crash, timeout, and immediate-exit paths release complete worker trees", async () => {
    const withGrandchild = (directory: string, lines: string[]) => [
      `printf '%s' "$$" > "${path.join(directory, "pid")}"`,
      "sleep 60 </dev/null >/dev/null 2>&1 &",
      `printf '%s' "$!" > "${path.join(directory, "grandchild-pid")}"`,
      ...lines,
    ];
    const cases: Array<{ name: string; reason: "collector-crash" | "timeout"; cause: string; lines: (directory: string) => string[]; limits?: { timeoutMs?: number; closeTimeoutMs?: number; outputMaxBytes?: number } }> = [
      {
        name: "malformed",
        reason: "collector-crash",
        cause: "worker-output-invalid",
        lines: (directory) => withGrandchild(directory, [
          "trap 'exit 0' TERM INT",
          "printf '{invalid}\\n'",
          "while :; do :; done",
        ]),
      },
      {
        name: "oversized",
        reason: "collector-crash",
        cause: "worker-output-limit",
        lines: (directory) => withGrandchild(directory, [
          "trap 'exit 0' TERM INT",
          `printf '%s\\n' '${OVERSIZED_WORKER_MESSAGE}'`,
          "while :; do :; done",
        ]),
        limits: { outputMaxBytes: 1_024 },
      },
      {
        name: "crash",
        reason: "collector-crash",
        cause: "worker-exit",
        lines: (directory) => withGrandchild(directory, ["exit 7"]),
      },
      {
        name: "timeout",
        reason: "timeout",
        cause: "worker-timeout",
        lines: (directory) => withGrandchild(directory, [
          "trap 'exit 0' TERM INT",
          "while :; do :; done",
        ]),
        limits: { timeoutMs: 20, closeTimeoutMs: 20 },
      },
      {
        name: "immediate-exit",
        reason: "collector-crash",
        cause: "worker-exit",
        lines: (directory) => withGrandchild(directory, ["exit 0"]),
      },
    ];

    for (const fixture of cases) {
      await withResourceWorkerScript(fixture.lines, async (directory) => {
        const outcome = await Promise.race([
          workerTestReader({ workerLimits: fixture.limits }).read(true),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
        ]);
        expect(outcome === "hung", fixture.name).toBeFalse();
        expect(outcome, fixture.name).toMatchObject({ diagnostic: {
          degradedReason: fixture.reason,
          failure: { cause: fixture.cause },
        } });
        await expectProcessAbsentAfterQuietInterval(Number(readFileSync(path.join(directory, "pid"), "utf8")), `${fixture.name} worker`);
        await expectProcessAbsentAfterQuietInterval(Number(readFileSync(path.join(directory, "grandchild-pid"), "utf8")), `${fixture.name} grandchild`);
      });
    }

    const previousExecutable = process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
    process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = path.join(os.tmpdir(), "missing-resource-worker-executable");
    try {
      const outcome = await Promise.race([
        workerTestReader().read(true),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);
      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({ diagnostic: {
        degradedReason: "collector-crash",
        failure: { cause: "worker-spawn" },
      } });
    } finally {
      if (previousExecutable === undefined) delete process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE;
      else process.env.LLV_RESOURCE_COLLECTOR_EXECUTABLE = previousExecutable;
    }
  });

  test("persists each completed generation once across ordinary reads", async () => {
    let now = 0;
    let builds = 0;
    const persisted: number[] = [];
    const reader = createResourcesReader(async () => {
      builds += 1;
      return { system: null, sessions: [] };
    }, () => null, () => now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true, persist: (observation) => {
      persisted.push(observation.generation);
      return true;
    } });

    await reader.read();
    await reader.read();
    await reader.read();
    await reader.read();
    expect(persisted).toEqual([1]);

    now = 10_000;
    await reader.read();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await reader.read(true);
    expect(persisted).toEqual([1, 3]);
    expect(builds).toBe(3);
  });

  test("a failed durable write retries on a later read of the same generation", async () => {
    let attempts = 0;
    const reader = createResourcesReader(async () => ({ system: null, sessions: [] }), () => null, Date.now, () => ({
      fresh: true,
      status: "complete",
      durationMs: 0,
      phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
    }), {
      inProcess: true,
      persist: () => {
        attempts += 1;
        return attempts > 1;
      },
    });

    await reader.read();
    expect(attempts).toBe(1);
    await reader.read();
    expect(attempts).toBe(2);
  });

  test("an initial durable observation seeds the persistence guard", async () => {
    let attempts = 0;
    const reader = workerTestReader({
      inProcess: true,
      persist: () => {
        attempts += 1;
        return true;
      },
    });

    await reader.read();
    expect(attempts).toBe(0);
  });

  test("twelve concurrent cold ordinary polls share one collection", async () => {
    const collection = deferred<ResourcesPayload>();
    let builds = 0;
    const reader = createResourcesReader(async () => {
      builds += 1;
      return collection.promise;
    }, () => null, Date.now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    const polls = Array.from({ length: 12 }, () => reader.read());
    await Promise.resolve();
    expect(builds).toBe(1);
    collection.resolve({ system: null, sessions: [] });
    await Promise.all(polls);
    expect(builds).toBe(1);
  });

  test("twelve concurrent off-process polls share one worker and one Viewer-main file handoff", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const fileFreshness: boolean[] = [];
      const reader = createResourcesReader(async () => ({ system: null, sessions: [] }), () => null, Date.now, () => null, {
        readFiles: async (fresh) => {
          fileFreshness.push(fresh);
          return [];
        },
      });

      const reads = await Promise.all(Array.from({ length: 12 }, () => reader.read()));
      expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
      expect(fileFreshness).toEqual([false]);
      expect(reads.every((read) => read.diagnostic.degradedReason === undefined)).toBeTrue();
    });
  });

  test("duplicate bundled resource modules share one versioned reader", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const previousHome = process.env.HOME;
      const previousState = process.env.LLV_STATE_DIR;
      const home = path.join(directory, "home");
      const state = path.join(directory, "state");
      mkdirSync(home, { recursive: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(path.join(state, "files-scan-snapshot.json"), JSON.stringify({
        version: 1,
        snapshot: { complete: true, files: [], projectCatalog: [] },
      }));
      process.env.HOME = home;
      process.env.LLV_STATE_DIR = state;
      const scanCache = await import("./scanner/scanCache");
      let first: typeof import("./resources") | undefined;
      try {
        scanCache.resetFilesRouteCacheForTests();
        const modulePath = path.join(import.meta.dir, "resources.ts");
        first = await import(`${modulePath}?reader-copy=first-${Date.now()}`) as typeof import("./resources");
        const second = await import(`${modulePath}?reader-copy=second-${Date.now()}`) as typeof import("./resources");
        first.resetResourcesForTests();
        const [left, right] = await Promise.all([
          first.readResourcesWithDiagnostic(),
          second.readResourcesWithDiagnostic(),
        ]);

        expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
        expect(left.diagnostic.collectorId).toBe(right.diagnostic.collectorId);
        expect(left.diagnostic.generation).toBe(right.diagnostic.generation);
      } finally {
        first?.resetResourcesForTests();
        scanCache.resetFilesRouteCacheForTests();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousState === undefined) delete process.env.LLV_STATE_DIR;
        else process.env.LLV_STATE_DIR = previousState;
      }
    });
  });

  test("a missing ordinary Viewer-main file handoff degrades within its bound without spawning a worker", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const missing = deferred<never>();
      const reader = createResourcesReader(async () => ({ system: null, sessions: [] }), () => null, Date.now, () => null, {
        readFiles: async () => missing.promise,
        workerLimits: { inputTimeoutMs: 20 },
      });
      const outcome = await Promise.race([
        reader.read(),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
      ]);

      expect(outcome === "hung").toBeFalse();
      expect(outcome).toMatchObject({ diagnostic: { degradedReason: "timeout", failure: { cause: "file-handoff-timeout" } } });
      expect(existsSync(path.join(directory, "workers"))).toBeFalse();
    });
  });

  test("an expired fresh handoff recovers on the next request without spawning late work", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}"`,
      `printf '%s\\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const first = deferred<never[]>();
      let handoffs = 0;
      const reader = workerTestReader({
        readFiles: async () => {
          handoffs += 1;
          return handoffs === 1 ? first.promise : [];
        },
        workerLimits: { inputTimeoutMs: 20 },
      });

      const expired = await Promise.race([
        reader.read(true),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
      ]);
      expect(expired === "hung").toBeFalse();
      expect(expired).toMatchObject({ diagnostic: { degradedReason: "timeout", failure: { cause: "file-handoff-timeout" } } });

      await reader.read(true);
      expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
      first.resolve([]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
    });
  });

  test("overlapping fresh polls share one post-fence collection", async () => {
    const collection = deferred<ResourcesPayload>();
    let builds = 0;
    const reader = createResourcesReader(async () => {
      builds += 1;
      return collection.promise;
    }, () => null, Date.now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    const polls = Array.from({ length: 12 }, () => reader.read(true));
    await Promise.resolve();
    expect(builds).toBe(1);
    collection.resolve({ system: null, sessions: [] });
    await Promise.all(polls);
    expect(builds).toBe(1);
  });

  test("overlapping fresh off-process polls share one worker and preserve the fresh handoff", async () => {
    await withResourceWorkerScript((directory) => [
      `printf x >> "${path.join(directory, "workers")}\"`,
      `printf '%s\\n' '${EMPTY_FRESH_WORKER_MESSAGE}'`,
    ], async (directory) => {
      const fileFreshness: boolean[] = [];
      const reader = workerTestReader({
        readFiles: async (fresh) => {
          fileFreshness.push(fresh);
          return [];
        },
      });

      await Promise.all(Array.from({ length: 12 }, () => reader.read(true)));
      expect(readFileSync(path.join(directory, "workers"), "utf8")).toBe("x");
      expect(fileFreshness).toEqual([true]);
    });
  });

  test("expired ordinary reads return the cached snapshot while one rebuild runs, and fresh waits for a newer build", async () => {
    let now = 0;
    let builds = 0;
    const fresh = deferred<ResourcesPayload>();
    const cached: ResourcesPayload = { system: null, sessions: [] };
    const freshResult: ResourcesPayload = { system: null, sessions: [{ target: "agents:3.0", panePid: 3, path: null, engine: "codex", hostConflict: false, title: null, project: null, activity: null, lastActiveAt: null, cwd: "/repo", rssBytes: 3, swapBytes: 0, procCount: 1 }] };
    const reader = createResourcesReader(async () => {
      builds += 1;
      if (builds === 1) return cached;
      return fresh.promise;
    }, () => null, () => now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    expect((await reader.read()).payload).toEqual(cached);
    now = 10_000;
    expect((await reader.read()).payload).toEqual(cached);
    await Promise.resolve();
    expect(builds).toBe(2);
    expect((await reader.read()).payload).toEqual(cached);
    expect(builds).toBe(2);

    const forced = reader.read(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    fresh.resolve(freshResult);
    expect((await forced).payload).toEqual(freshResult);
    expect(builds).toBe(3);
  });

  test("a failed ordinary rebuild leaves the cached snapshot available and later polls retry", async () => {
    let now = 0;
    let builds = 0;
    const recovered = deferred<ResourcesPayload>();
    const cached: ResourcesPayload = { system: null, sessions: [] };
    const reader = createResourcesReader(async () => {
      builds += 1;
      if (builds === 1) return cached;
      if (builds === 2) throw new Error("transient resource build failure");
      return recovered.promise;
    }, () => null, () => now, () => ({ fresh: true, status: "complete", durationMs: 0, phases: {
      systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0,
    } }), { inProcess: true });

    await reader.read();
    now = 10_000;
    expect((await reader.read()).payload).toEqual(cached);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
    expect(builds).toBe(2);
    expect((await reader.read()).payload).toEqual(cached);
    await Promise.resolve();
    expect(builds).toBe(3);
    recovered.resolve(cached);
    await Promise.resolve();
  });
});
