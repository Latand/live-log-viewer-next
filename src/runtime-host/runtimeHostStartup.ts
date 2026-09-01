import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type {
  RuntimeHostGenerationIdentity,
  RuntimeSocketResponse,
  ViewerRuntimeHostHandoffEvidence,
  ViewerRuntimeHostStartupPhase,
  ViewerRuntimeHostStartupPhaseEvidence,
} from "@/lib/runtime/contracts";

export const RUNTIME_HOST_STARTUP_PHASES: readonly ViewerRuntimeHostStartupPhase[] = [
  "fence-waiting",
  "fence-acquired",
  "journal-open",
  "handoff-cleanup-complete",
  "consumers-recovered",
  "socket-listening",
  "ready",
];

interface PendingRuntimeHostStartupPhaseEvidence extends Omit<ViewerRuntimeHostStartupPhaseEvidence, "hostEpoch"> {
  hostEpoch: number | null;
}

interface RuntimeHostStartupRecord {
  version: 1;
  generation: RuntimeHostGenerationIdentity;
  pid: number;
  startIdentity: string;
  hostEpoch: number | null;
  phases: PendingRuntimeHostStartupPhaseEvidence[];
}

export type RuntimeHostReadyEvidence = Omit<ViewerRuntimeHostHandoffEvidence, "probe">;

function durableWrite(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function recordFromDisk(filename: string): RuntimeHostStartupRecord {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  } catch (error) {
    throw new Error("runtime-host startup evidence is unreadable", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime-host startup evidence is invalid");
  }
  const record = value as Partial<RuntimeHostStartupRecord>;
  if (record.version !== 1
    || !record.generation
    || typeof record.generation.image !== "string"
    || typeof record.generation.revision !== "string"
    || typeof record.generation.container !== "string"
    || !Number.isSafeInteger(record.pid)
    || (record.pid ?? 0) <= 0
    || typeof record.startIdentity !== "string"
    || !record.startIdentity
    || (record.hostEpoch !== null && (!Number.isSafeInteger(record.hostEpoch) || (record.hostEpoch ?? 0) < 0))
    || !Array.isArray(record.phases)) {
    throw new Error("runtime-host startup evidence is invalid");
  }
  return record as RuntimeHostStartupRecord;
}

export class RuntimeHostStartupStore {
  private readonly identity?: {
    generation: RuntimeHostGenerationIdentity;
    pid: number;
    startIdentity: string;
    now(): string;
  };

  constructor(
    private readonly filename: string,
    identity?: {
      generation: RuntimeHostGenerationIdentity;
      pid: number;
      startIdentity: string;
      now?(): string;
    },
  ) {
    this.identity = identity
      ? { ...identity, now: identity.now ?? (() => new Date().toISOString()) }
      : undefined;
  }

  begin(): void {
    if (!this.identity) throw new Error("runtime-host startup identity is unavailable");
    const record: RuntimeHostStartupRecord = {
      version: 1,
      generation: this.identity.generation,
      pid: this.identity.pid,
      startIdentity: this.identity.startIdentity,
      hostEpoch: null,
      phases: [{
        phase: "fence-waiting",
        recordedAt: this.identity.now(),
        generation: this.identity.generation,
        pid: this.identity.pid,
        startIdentity: this.identity.startIdentity,
        hostEpoch: null,
      }],
    };
    durableWrite(this.filename, record);
  }

  bindHostEpoch(hostEpoch: number): void {
    if (!Number.isSafeInteger(hostEpoch) || hostEpoch < 0) throw new Error("runtime-host epoch is invalid");
    const record = recordFromDisk(this.filename);
    record.hostEpoch = hostEpoch;
    record.phases = record.phases.map((phase) => ({ ...phase, hostEpoch }));
    durableWrite(this.filename, record);
  }

  record(phase: ViewerRuntimeHostStartupPhase): void {
    if (!this.identity) throw new Error("runtime-host startup identity is unavailable");
    const record = recordFromDisk(this.filename);
    const currentIndex = record.phases.length - 1;
    const expected = RUNTIME_HOST_STARTUP_PHASES[currentIndex + 1];
    if (record.phases[currentIndex]?.phase === phase) return;
    if (phase !== expected) {
      throw new Error(`runtime-host startup phase ${phase} cannot follow ${record.phases[currentIndex]?.phase ?? "none"}`);
    }
    record.phases.push({
      phase,
      recordedAt: this.identity.now(),
      generation: record.generation,
      pid: record.pid,
      startIdentity: record.startIdentity,
      hostEpoch: record.hostEpoch,
    });
    durableWrite(this.filename, record);
  }

  readyEvidence(): RuntimeHostReadyEvidence {
    const record = recordFromDisk(this.filename);
    if (record.hostEpoch === null
      || record.phases.length !== RUNTIME_HOST_STARTUP_PHASES.length
      || record.phases.some((phase, index) => phase.phase !== RUNTIME_HOST_STARTUP_PHASES[index]
        || phase.hostEpoch !== record.hostEpoch
        || phase.pid !== record.pid
        || phase.startIdentity !== record.startIdentity
        || phase.generation.image !== record.generation.image
        || phase.generation.revision !== record.generation.revision
        || phase.generation.container !== record.generation.container)) {
      throw new Error("runtime-host startup is not ready");
    }
    return {
      generation: record.generation,
      pid: record.pid,
      startIdentity: record.startIdentity,
      hostEpoch: record.hostEpoch,
      phases: record.phases as ViewerRuntimeHostStartupPhaseEvidence[],
    };
  }
}

function sameGeneration(left: RuntimeHostGenerationIdentity, right: RuntimeHostGenerationIdentity): boolean {
  return left.image === right.image && left.revision === right.revision && left.container === right.container;
}

export function runtimeHostGenerationFromEnvironment(
  environment: Record<string, string | undefined>,
): RuntimeHostGenerationIdentity {
  const image = environment.LLV_RUNTIME_HOST_IMAGE;
  const revision = environment.LLV_RUNTIME_HOST_REVISION;
  const container = environment.LLV_RUNTIME_HOST_CONTAINER;
  if (!image || !revision || !container || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) {
    throw new Error("runtime-host generation identity is unavailable");
  }
  return { image, revision, container };
}

function validatedEvidence(value: unknown, expected: RuntimeHostGenerationIdentity): RuntimeHostReadyEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime-host health response is invalid");
  }
  const evidence = value as Partial<RuntimeHostReadyEvidence>;
  if (!evidence.generation || !sameGeneration(evidence.generation, expected)
    || !Number.isSafeInteger(evidence.pid) || (evidence.pid ?? 0) <= 0
    || typeof evidence.startIdentity !== "string" || !evidence.startIdentity
    || !Number.isSafeInteger(evidence.hostEpoch) || (evidence.hostEpoch ?? -1) < 0
    || !Array.isArray(evidence.phases)
    || evidence.phases.length !== RUNTIME_HOST_STARTUP_PHASES.length) {
    throw new Error("runtime-host health response does not match the candidate generation");
  }
  for (const [index, phase] of evidence.phases.entries()) {
    if (!phase || phase.phase !== RUNTIME_HOST_STARTUP_PHASES[index]
      || typeof phase.recordedAt !== "string"
      || phase.pid !== evidence.pid
      || phase.startIdentity !== evidence.startIdentity
      || phase.hostEpoch !== evidence.hostEpoch
      || !sameGeneration(phase.generation, expected)) {
      throw new Error("runtime-host health response carries incomplete startup evidence");
    }
  }
  return evidence as RuntimeHostReadyEvidence;
}

export function parseRuntimeHostHandoffEvidence(
  value: unknown,
  expected: RuntimeHostGenerationIdentity,
): ViewerRuntimeHostHandoffEvidence {
  const ready = validatedEvidence(value, expected);
  const probe = (value as Partial<ViewerRuntimeHostHandoffEvidence>).probe;
  if (!probe
    || typeof probe.checkedAt !== "string"
    || typeof probe.requestId !== "string"
    || !probe.requestId
    || probe.responseId !== probe.requestId
    || !Number.isFinite(probe.elapsedMs)
    || probe.elapsedMs < 0
    || probe.elapsedMs > 3_000) {
    throw new Error("runtime-host handoff probe receipt is invalid");
  }
  return { ...ready, probe };
}

export function probeRuntimeHostSuccessor(
  socketPath: string,
  expected: RuntimeHostGenerationIdentity,
  options: {
    timeoutMs?: number;
    requestId?: string;
    now?(): number;
    wallClock?(): string;
  } = {},
): Promise<ViewerRuntimeHostHandoffEvidence> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 3_000, 1), 3_000);
  const requestId = options.requestId ?? randomUUID();
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => new Date().toISOString());
  const startedAt = now();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let frame = "";
    let settled = false;
    const finish = (error?: Error, evidence?: RuntimeHostReadyEvidence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (evidence) {
        resolve({
          ...evidence,
          probe: {
            checkedAt: wallClock(),
            requestId,
            responseId: requestId,
            elapsedMs: Math.max(0, Math.round(now() - startedAt)),
          },
        });
      }
    };
    const timer = setTimeout(() => finish(new Error("runtime-host health probe timed out after 3000 ms")), timeoutMs);
    socket.once("error", () => finish(new Error("runtime-host health probe could not connect")));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method: "runtime-host-health", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      frame += String(chunk);
      if (Buffer.byteLength(frame) > 1024 * 1024) {
        finish(new Error("runtime-host health response exceeds limit"));
        return;
      }
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      let response: RuntimeSocketResponse;
      try {
        response = JSON.parse(frame.slice(0, newline)) as RuntimeSocketResponse;
      } catch {
        finish(new Error("runtime-host health response is invalid JSON"));
        return;
      }
      if (response.id !== requestId) {
        finish(new Error("runtime-host health response id mismatch"));
        return;
      }
      if (!response.ok) {
        finish(new Error(response.error || "runtime-host health probe was refused"));
        return;
      }
      try {
        finish(undefined, validatedEvidence(response.result, expected));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("runtime-host health response is invalid"));
      }
    });
  });
}
