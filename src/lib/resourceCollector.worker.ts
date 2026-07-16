import "./resourceCollector.workerMode";

import { parentPort } from "node:worker_threads";

import { createTranscriptHostObserver } from "./agent/transcriptHost";
import { procBackend } from "./proc";
import { agentProcesses } from "./scanner/process";
import { buildResourceSnapshot, lastResourceBuildDiagnostic, lastResourceTargetRefs, RESOURCE_WORKER_OUTPUT_MAX_BYTES, type ResourceWorkerFileObservation } from "./resources";
import { overlayResourceSessionTitles } from "./session/titleProjection";
import { captureTmuxAttachReferences, panePidMap, tmuxServerPid } from "./tmux";
import type { FileEntry } from "./types";

function send(message: unknown): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  process.stdout.write(JSON.stringify(message) + "\n");
}

type ResourceWorkerRequest = {
  type: "collect";
  fresh: boolean;
  files: ResourceWorkerFileObservation[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function resourceFileObservation(value: unknown): value is ResourceWorkerFileObservation {
  if (!record(value)) return false;
  const keys = ["path", "parent", "title", "project", "activity", "mtime", "engine", "pid", "proc", "conversationId"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return false;
  return typeof value.path === "string" && value.path.length > 0
    && nullableString(value.parent)
    && typeof value.title === "string"
    && typeof value.project === "string"
    && (value.activity === "live" || value.activity === "recent" || value.activity === "stalled" || value.activity === "idle")
    && typeof value.mtime === "number" && Number.isFinite(value.mtime) && value.mtime >= 0
    && (value.engine === "claude" || value.engine === "codex" || value.engine === "shell")
    && (value.pid === null || (Number.isSafeInteger(value.pid) && (value.pid as number) > 0))
    && (value.proc === "running" || value.proc === "done" || value.proc === "killed" || value.proc === null)
    && nullableString(value.conversationId);
}

function resourceWorkerRequest(value: unknown): ResourceWorkerRequest | null {
  if (!record(value)
    || Object.keys(value).length !== 3
    || value.type !== "collect"
    || typeof value.fresh !== "boolean"
    || !Array.isArray(value.files)
    || value.files.length > 10_000
    || !value.files.every(resourceFileObservation)) return null;
  return value as ResourceWorkerRequest;
}

async function collect(message: unknown): Promise<void> {
  const request = resourceWorkerRequest(message);
  if (!request) {
    send({ type: "failure", error: "resource collector received an invalid request" });
    return;
  }
  try {
    overlayResourceSessionTitles(request.files as FileEntry[]);
    const conversationByPath = new Map(request.files.flatMap((entry) => entry.conversationId ? [[entry.path, entry.conversationId] as const] : []));
    const readHosts = createTranscriptHostObserver({
      listFiles: async () => request.files as FileEntry[],
      panes: panePidMap,
      ppidMap: () => procBackend.ppidMap(),
      agents: agentProcesses,
      serverPid: tmuxServerPid,
      resumeRecords: async () => null,
      identity: procBackend.processIdentity,
      holdsPath: procBackend.pidHoldsPath,
      conversationIdForPath: (pathname) => conversationByPath.get(pathname) ?? null,
    });
    const payload = await buildResourceSnapshot(request.fresh, {
      readFiles: async () => request.files,
      readHosts: (fresh, entries, ppids) => readHosts(fresh, entries as FileEntry[], ppids),
      proc: procBackend,
      captureAttachReferences: captureTmuxAttachReferences,
    });
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
  let inputBytes = 0;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes <= RESOURCE_WORKER_OUTPUT_MAX_BYTES) input += chunk;
  });
  process.stdin.on("end", () => {
    if (inputBytes > RESOURCE_WORKER_OUTPUT_MAX_BYTES) {
      send({ type: "failure", error: "resource collector input exceeded transport limit" });
      return;
    }
    try {
      void collect(JSON.parse(input));
    } catch (error) {
      send({ type: "failure", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
