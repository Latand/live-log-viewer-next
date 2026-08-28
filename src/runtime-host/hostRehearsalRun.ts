/* #1254: the concrete ports for the runtime-host rehearsal, and its entry
   point. Run directly, this file is the rehearsal:

     bun run src/runtime-host/hostRehearsalRun.ts

   It starts two real runtime-host generations under a chosen Bun, drives one
   singleton-fence succession between them, and holds the stable listener the
   succession handed over. Everything it touches is created here and removed
   here: a private state directory, a private socket, an ephemeral loopback
   port. It never reads the operator's state directory and never binds 8898. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { ViewerRuntimeHostHealthEvidence } from "@/lib/runtime/contracts";

import {
  RUNTIME_HOST_REHEARSAL_LOG_LINES,
  RUNTIME_HOST_REHEARSAL_REPORT_PREFIX,
  rehearseRuntimeHost,
  type RuntimeHostRehearsalGeneration,
  type RuntimeHostRehearsalPorts,
} from "./hostRehearsal";
import { RUNTIME_HOST_FENCE_WAIT_ENV } from "./fenceWait";
import { RUNTIME_HOST_CONTAINER_ENV } from "./hostRelease";

/** The successor's own fence wait has to outlast the succession budget, or it
    fails its container before the predecessor has finished releasing. */
const REHEARSAL_FENCE_WAIT_MS = 120_000;
/** A probe that waits longer than this against a local endpoint is a failure,
    not a slow answer. */
const PROBE_TIMEOUT_MS = 5_000;
/* The seed. `replay` returns at most 128 events and the journal caps a payload
   at 16 KiB, so this asks the host for the largest answer a rehearsal can make
   it produce — roughly a quarter of a megabyte, several socket writes wide.
   A production snapshot is larger still; this is the biggest stand-in a fresh
   journal can offer, and it is what the abandoning peers below leave behind. */
const SEED_EVENTS = 128;
const SEED_EVENT_BYTES = 15_000;
/** A frame beyond this is a runaway answer, not a large one. */
const MAX_PROBE_FRAME_BYTES = 64 * 1024 * 1024;

export interface RuntimeHostRehearsalRunOptions {
  /** The interpreter under test; `bun-container` inside the image. */
  runtimeBin: string;
  /** Repository (or `/app`) root that owns `src/runtime-host/main.ts`. */
  root: string;
  stateDir: string;
  port: number;
  holdWindowMs?: number;
}

function rehearsalEnvironment(options: RuntimeHostRehearsalRunOptions, role: "predecessor" | "successor"): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    // The environment is built rather than inherited, so the rehearsal cannot
    // pick up a live socket, journal or state dir from whoever started it.
    // The image pins production, and the host under test must see the same.
    NODE_ENV: process.env.NODE_ENV ?? "production",
    HOME: options.stateDir,
    XDG_CONFIG_HOME: path.join(options.stateDir, "config"),
    TMPDIR: path.join(options.stateDir, "tmp"),
    LLV_STATE_DIR: options.stateDir,
    LLV_RUNTIME_HOST_SOCKET: path.join(options.stateDir, "runtime-host.sock"),
    LLV_RUNTIME_JOURNAL: path.join(options.stateDir, "runtime-events.sqlite"),
    /* The stable listener exists only when deployments are enabled, and the
       listener is the point. The adapter is never invoked: no deployment is
       requested, and the release target file is deliberately absent, so the
       proxy answers its own 503 — which is the raw-write path that took the
       host down, exercised on every probe. */
    LLV_VIEWER_DEPLOYMENTS: "1",
    LLV_VIEWER_DEPLOY_ADAPTER: path.join(options.root, "scripts", "runtime-host-viewer-adapter.ts"),
    LLV_VIEWER_DEPLOY_TARGET: path.join(options.stateDir, "viewer-release.json"),
    LLV_VIEWER_PORT: String(options.port),
    [RUNTIME_HOST_CONTAINER_ENV]: `rehearsal-${role}`,
    ...(role === "successor" ? { [RUNTIME_HOST_FENCE_WAIT_ENV]: String(REHEARSAL_FENCE_WAIT_MS) } : {}),
  };
}

function startGeneration(options: RuntimeHostRehearsalRunOptions, role: "predecessor" | "successor"): RuntimeHostRehearsalGeneration {
  const child: ChildProcess = spawn(options.runtimeBin, ["run", "src/runtime-host/main.ts"], {
    cwd: options.root,
    env: rehearsalEnvironment(options, role),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const collect = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      lines.push(`${role}: ${line}`);
      if (lines.length > RUNTIME_HOST_REHEARSAL_LOG_LINES) lines.shift();
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => collect(`failed to start: ${error.message}`));
  let exited = false;
  const gone = new Promise<void>((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  return {
    exited: () => exited,
    log: () => [...lines],
    stop: async () => {
      if (exited) return;
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { await gone; } finally { clearTimeout(forced); }
    },
  };
}

/**
 * One request against the stable listener. `abandon` drops the caller as soon
 * as the connection exists, leaving the host to write its answer into a socket
 * whose peer is gone — the production failure, produced on purpose rather than
 * waited for. Any HTTP status counts: the rehearsal asks whether the listener
 * is held, not what is behind it.
 */
export function probeStableListener(port: number, options: { abandon: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    const socket = net.createConnection(port, "127.0.0.1");
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("data", (chunk) => finish(String(chunk).startsWith("HTTP/1.")));
    socket.once("connect", () => {
      /* An abandoning caller vanishes the moment the connection exists — the
         listener is already composing its answer into a peer that is gone.
         Reaching `connect` is itself the evidence that the listener is held. */
      if (options.abandon) return finish(true);
      socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
  });
}

/**
 * One request on the runtime socket. `abandon` reads the first bytes of the
 * answer and then vanishes, leaving the host writing the rest of a multi-
 * megabyte frame into a socket whose peer is gone. That is the production
 * write: Bun 1.3.3 dropped its failure, 1.4.0 reports it, and a host without a
 * handler on that connection dies of it.
 */
export function probeRuntimeSocket(socketPath: string, request: unknown, options: { abandon: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    const socket = net.createConnection(socketPath);
    let frame = "";
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("data", (chunk) => {
      if (options.abandon) return finish(true);
      // Reading to the frame delimiter is what a complete answer means here.
      frame += String(chunk);
      const newline = frame.indexOf("\n");
      if (newline >= 0) finish(frame.slice(0, newline).includes('"ok":true'));
      else if (frame.length > MAX_PROBE_FRAME_BYTES) finish(false);
    });
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
  });
}

/** Fill the journal so one `events` replay is a multi-megabyte answer. */
async function seedJournal(socketPath: string): Promise<void> {
  const filler = "x".repeat(SEED_EVENT_BYTES);
  for (let index = 0; index < SEED_EVENTS; index += 1) {
    const appended = await probeRuntimeSocket(socketPath, {
      id: `rehearsal-seed-${index}`,
      method: "append",
      params: {
        event: {
          scope: `session:rehearsal-${index}`,
          kind: "session-status",
          payload: { hostAxis: "hosted", filler },
        },
      },
    }, { abandon: false });
    if (!appended) throw new Error("the runtime host refused the rehearsal seed");
  }
}

export function runtimeHostRehearsalPorts(options: RuntimeHostRehearsalRunOptions): RuntimeHostRehearsalPorts {
  const socketPath = path.join(options.stateDir, "runtime-host.sock");
  return {
    start: async (role) => startGeneration(options, role),
    seed: () => seedJournal(socketPath),
    probeListener: (probe) => probeStableListener(options.port, probe),
    probeSocket: (probe) => probeRuntimeSocket(socketPath, { id: "rehearsal-events", method: "events", params: { after: 0 } }, probe),
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

/** An unused loopback port, claimed and released so the host can bind it. */
export function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no ephemeral port was assigned"));
      server.close(() => resolve(address.port));
    });
  });
}

async function runtimeVersion(runtimeBin: string): Promise<string> {
  const child = spawn(runtimeBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  const version = output.trim();
  return code === 0 && version ? `bun ${version}` : `${path.basename(runtimeBin)} (version unavailable)`;
}

/**
 * Rehearse the runtime host once, under `runtimeBin`, in a state directory
 * created for this run and removed after it.
 */
export async function runRuntimeHostRehearsal(options: {
  runtimeBin?: string;
  root?: string;
  stateDir?: string;
  holdWindowMs?: number;
}): Promise<ViewerRuntimeHostHealthEvidence> {
  const runtimeBin = options.runtimeBin ?? process.env.LLV_RUNTIME_HOST_REHEARSAL_BIN ?? "bun";
  const root = options.root ?? process.cwd();
  const stateDir = options.stateDir
    ?? process.env.LLV_RUNTIME_HOST_REHEARSAL_STATE_DIR
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-rehearsal-"));
  fs.mkdirSync(path.join(stateDir, "tmp"), { recursive: true, mode: 0o700 });
  const owned = options.stateDir === undefined && process.env.LLV_RUNTIME_HOST_REHEARSAL_STATE_DIR === undefined;
  try {
    return await rehearseRuntimeHost(
      runtimeHostRehearsalPorts({ runtimeBin, root, stateDir, port: await ephemeralPort() }),
      {
        runtime: await runtimeVersion(runtimeBin),
        ...(options.holdWindowMs === undefined ? {} : { holdWindowMs: options.holdWindowMs }),
      },
    );
  } finally {
    if (owned) fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const report = await runRuntimeHostRehearsal({
    ...(process.env.LLV_RUNTIME_HOST_REHEARSAL_ROOT ? { root: process.env.LLV_RUNTIME_HOST_REHEARSAL_ROOT } : {}),
  });
  console.log(RUNTIME_HOST_REHEARSAL_REPORT_PREFIX + JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
