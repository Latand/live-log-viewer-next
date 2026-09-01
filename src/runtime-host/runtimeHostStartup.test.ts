import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import type { RuntimeHostGenerationIdentity, ViewerRuntimeHostStartupPhase } from "@/lib/runtime/contracts";

import {
  probeRuntimeHostSuccessor,
  RuntimeHostStartupStore,
} from "./runtimeHostStartup";
import { RuntimeHost } from "./host";
import { RuntimeJournal } from "./journal";
import { serveRuntimeHost } from "./socket";

const generation: RuntimeHostGenerationIdentity = {
  image: `agent-log-viewer:deploy-${"b".repeat(40)}`,
  revision: "b".repeat(40),
  container: "llv-runtime-host-bbbbbbbbbbbb-candidate",
};

const phases: ViewerRuntimeHostStartupPhase[] = [
  "fence-waiting",
  "fence-acquired",
  "journal-open",
  "handoff-cleanup-complete",
  "consumers-recovered",
  "socket-listening",
  "ready",
];

test("issue 1268: startup phases survive the predecessor exit and bind to the successor identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-startup-"));
  const filename = path.join(directory, "runtime-host-startup.json");
  let tick = 0;
  try {
    const store = new RuntimeHostStartupStore(filename, {
      generation,
      pid: 4242,
      startIdentity: "4242:successor",
      now: () => `2026-08-31T14:00:0${tick++}.000Z`,
    });
    store.begin();
    store.record("fence-acquired");
    store.bindHostEpoch(7);
    for (const phase of phases.slice(2)) store.record(phase);

    const recovered = new RuntimeHostStartupStore(filename);
    expect(recovered.readyEvidence()).toMatchObject({
      generation,
      pid: 4242,
      startIdentity: "4242:successor",
      hostEpoch: 7,
      phases: phases.map((phase) => ({ phase, generation, pid: 4242, startIdentity: "4242:successor", hostEpoch: 7 })),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 1268: terminal hand-over proof requires a matching valid framed response", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-probe-"));
  const socketPath = path.join(directory, "runtime-host.sock");
  const store = new RuntimeHostStartupStore(path.join(directory, "runtime-host-startup.json"), {
    generation,
    pid: 4242,
    startIdentity: "4242:successor",
    now: () => "2026-08-31T14:00:00.000Z",
  });
  store.begin();
  store.bindHostEpoch(7);
  for (const phase of phases.slice(1)) store.record(phase);
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"));
  const host = new RuntimeHost(
    journal,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    () => store.readyEvidence(),
  );
  const server = serveRuntimeHost(socketPath, host);
  await once(server, "listening");
  try {
    const evidence = await probeRuntimeHostSuccessor(socketPath, generation, {
      requestId: "runtime-host-health-probe",
      now: () => 12,
      wallClock: () => "2026-08-31T14:00:08.000Z",
    });

    expect(evidence).toMatchObject({
      generation,
      phases: phases.map((phase) => ({ phase })),
      probe: {
        requestId: "runtime-host-health-probe",
        responseId: "runtime-host-health-probe",
        elapsedMs: 0,
      },
    });
  } finally {
    server.close();
    await once(server, "close");
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 1268: a raw protocol answer from another generation is refused", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-probe-wrong-"));
  const socketPath = path.join(directory, "runtime-host.sock");
  const server = net.createServer((socket) => {
    socket.once("error", () => socket.destroy());
    socket.once("data", () => socket.end('{"id":"someone-else","ok":true,"result":{}}\n'));
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    await expect(probeRuntimeHostSuccessor(socketPath, generation, { requestId: "expected" }))
      .rejects.toThrow("runtime-host health response id mismatch");
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 1268: a staged real runtime host proves hand-over readiness from isolated state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-staged-release-"));
  const repositoryRoot = path.resolve(import.meta.dir, "../..");
  const releaseRoot = path.join(directory, "release");
  const stateDir = path.join(directory, "state");
  const socketPath = path.join(stateDir, "runtime-host.sock");
  const releaseFile = path.join(stateDir, "runtime-host-release.json");
  const startupFile = path.join(stateDir, "runtime-host-startup.json");
  const stagedGeneration = {
    image: `agent-log-viewer:deploy-${"d".repeat(40)}`,
    revision: "d".repeat(40),
    container: "llv-runtime-host-dddddddddddd-staged",
  };
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(directory, "home"), { recursive: true });
  fs.mkdirSync(path.join(directory, "config"), { recursive: true });
  fs.mkdirSync(path.join(directory, "tmp"), { recursive: true });
  fs.cpSync(path.join(repositoryRoot, "src"), path.join(releaseRoot, "src"), { recursive: true });
  fs.cpSync(path.join(repositoryRoot, "bin"), path.join(releaseRoot, "bin"), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "tsconfig.json"), path.join(releaseRoot, "tsconfig.json"));
  fs.symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(releaseRoot, "node_modules"), "dir");
  fs.writeFileSync(releaseFile, JSON.stringify({
    ...stagedGeneration,
    endpoint: "http://127.0.0.1:19481",
    stagedAt: "2026-08-31T14:00:00.000Z",
  }));
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(directory, "home"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    TMPDIR: path.join(directory, "tmp"),
    LLV_STATE_DIR: stateDir,
    LLV_RUNTIME_HOST_SOCKET: socketPath,
    LLV_RUNTIME_HOST_FENCE: path.join(stateDir, "runtime-host.lock"),
    LLV_RUNTIME_JOURNAL: path.join(stateDir, "runtime-events.sqlite"),
    LLV_RUNTIME_HOST_RELEASE_TARGET: releaseFile,
    LLV_RUNTIME_HOST_STARTUP_TARGET: startupFile,
    LLV_RUNTIME_HOST_IMAGE: stagedGeneration.image,
    LLV_RUNTIME_HOST_REVISION: stagedGeneration.revision,
    LLV_RUNTIME_HOST_CONTAINER: stagedGeneration.container,
    LLV_VIEWER_DEPLOYMENTS: "0",
  };
  const child = spawn(process.execPath, ["run", "src/runtime-host/main.ts"], {
    cwd: releaseRoot,
    env: environment as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const childExited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    let evidence = null;
    for (let attempt = 0; attempt < 100 && evidence === null; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`staged runtime host exited early: ${output}`);
      if (fs.existsSync(socketPath)) {
        try {
          evidence = await probeRuntimeHostSuccessor(socketPath, stagedGeneration, { timeoutMs: 250 });
        } catch {
          // Startup has bounded, durable phases; retry until `ready` is visible.
        }
      }
      if (evidence === null) await Bun.sleep(25);
    }
    expect(evidence).toMatchObject({
      generation: stagedGeneration,
      phases: phases.map((phase) => ({ phase })),
      probe: { requestId: expect.any(String), responseId: expect.any(String) },
    });
    expect(Object.hasOwn(environment, "NODE_ENV")).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    const exited = await Promise.race([
      childExited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) {
      child.kill("SIGKILL");
      await childExited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
