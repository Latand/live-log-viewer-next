import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import {
  readRuntimeHostHandoffIntent,
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  type RuntimeHostHandoffIntent,
  type RuntimeHostReleaseRecord,
  type RuntimeHostRollbackIntent,
  type RuntimeHostRollbackTarget,
  writeRuntimeHostHandoffIntent,
} from "./hostRelease";
import {
  completeRuntimeHostRollback,
  runtimeHostRollbackTargetFromHandoff,
  requestRuntimeHostRollback,
  resumeRuntimeHostRollback,
  runtimeHostRollbackDeploymentUpdate,
} from "./hostRollback";
import {
  RUNTIME_HOST_PREDECESSOR_LABEL,
  RUNTIME_HOST_SUCCESSOR_LABEL,
  runtimeHostSuccessorName,
  stageRuntimeHostSuccessorContainer,
} from "./hostSuccessor";
import { RuntimeJournal } from "./journal";
import { probeRuntimeHostSuccessor } from "./runtimeHostStartup";

const active: RuntimeHostReleaseRecord = {
  image: `agent-log-viewer:deploy-${"b".repeat(40)}`,
  revision: "b".repeat(40),
  container: "llv-runtime-host-bbbbbbbbbbbb-active",
  endpoint: "http://127.0.0.1:8898",
  stagedAt: "2026-08-31T14:00:00.000Z",
};

const previous: RuntimeHostReleaseRecord = {
  image: `agent-log-viewer:deploy-${"a".repeat(40)}`,
  revision: "a".repeat(40),
  container: "llv-runtime-host-aaaaaaaaaaaa-retained",
  endpoint: "http://127.0.0.1:8898",
  stagedAt: "2026-08-30T14:00:00.000Z",
};

const target: RuntimeHostRollbackTarget = {
  version: 1,
  active,
  previous,
  predecessorId: "retained-predecessor-id",
  recordedAt: "2026-08-31T14:00:10.000Z",
};

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function stopChild(
  child: ChildProcess | null,
  exited: Promise<unknown> | null,
): Promise<void> {
  if (!child || !exited || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}

async function waitForFile(filename: string, child: ChildProcess, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filename)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`process exited before ${path.basename(filename)} was written: ${output()}`);
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${path.basename(filename)}: ${output()}`);
}

test("issue 1270: a retained predecessor finishes rollback after the requesting executor dies", async () => {
  let intent: RuntimeHostRollbackIntent | null = null;
  let handoffIntent: RuntimeHostHandoffIntent | null = {
    revision: active.revision,
    image: active.image,
    successorContainer: active.container,
    predecessorId: target.predecessorId,
    previousRelease: previous,
    successorRelease: active,
    recordedAt: target.recordedAt,
  };
  let targetExists = true;
  let release = active;
  const calls: string[] = [];

  await expect(requestRuntimeHostRollback(target, {
    writeIntent: (value) => { intent = value; },
    writeRelease: (value) => { release = value; },
    enablePreviousRestart: async (container) => { calls.push(`restart:${container}`); },
    startPrevious: async (container) => {
      calls.push(`start:${container}`);
      throw new Error("rollback executor died after dockerd accepted the start");
    },
    now: () => "2026-08-31T14:00:20.000Z",
  })).rejects.toThrow("rollback executor died");

  expect(release).toEqual(previous);
  expect(intent).toMatchObject({
    version: 1,
    phase: "requested",
    active,
    previous,
    predecessorId: "retained-predecessor-id",
  });
  expect(calls).toEqual([
    `restart:${previous.container}`,
    "start:retained-predecessor-id",
  ]);

  const resumed = await resumeRuntimeHostRollback(
    { image: previous.image, revision: previous.revision, container: previous.container },
    {
      readIntent: () => intent,
      disableActiveRestart: async (container) => { calls.push(`disable:${container}`); },
      stopActive: async (container) => { calls.push(`stop:${container}`); },
    },
  );

  expect(resumed).toBe(true);
  expect(calls.slice(-2)).toEqual([
    `disable:${active.container}`,
    `stop:${active.container}`,
  ]);

  const cleanupPorts = {
    readIntent: () => intent,
    readHandoffIntent: () => handoffIntent,
    removeFailed: async (container: string) => { calls.push(`remove:${container}`); },
    clearTarget: () => { targetExists = false; calls.push("clear-target"); },
    clearHandoffIntent: () => { handoffIntent = null; calls.push("clear-handoff"); },
    clearIntent: () => { intent = null; calls.push("clear-rollback-intent"); },
  };
  const completed = await completeRuntimeHostRollback(
    { image: previous.image, revision: previous.revision, container: previous.container },
    cleanupPorts,
  );

  expect(completed).toBe(true);
  expect(calls.slice(-4)).toEqual([
    `remove:${active.container}`,
    "clear-target",
    "clear-handoff",
    "clear-rollback-intent",
  ]);
  expect(targetExists).toBe(false);
  expect(handoffIntent).toBeNull();
  expect(intent).toBeNull();
});

test("issue 1270: a killed rollback executor is recovered by the retained runtime-host process", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-rollback-process-"));
  const repositoryRoot = path.resolve(import.meta.dir, "../..");
  const releaseRoot = path.join(directory, "release");
  const stateDir = path.join(directory, "state");
  const binDir = path.join(directory, "bin");
  const socketPath = path.join(stateDir, "runtime-host.sock");
  const journalPath = path.join(stateDir, "runtime-events.sqlite");
  const releaseFile = path.join(stateDir, "runtime-host-release.json");
  const handoffFile = path.join(stateDir, "runtime-host-handoff-intent.json");
  const rollbackTargetFile = path.join(stateDir, "runtime-host-rollback-target.json");
  const rollbackIntentFile = path.join(stateDir, "runtime-host-rollback-intent.json");
  const startupFile = path.join(stateDir, "runtime-host-startup.json");
  const dockerLog = path.join(directory, "docker.log");
  const startAccepted = path.join(directory, "retained-start-accepted");
  let executor: ChildProcess | null = null;
  let executorExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let retained: ChildProcess | null = null;
  let retainedExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let executorOutput = "";
  let retainedOutput = "";
  try {
    for (const item of [releaseRoot, stateDir, binDir, path.join(directory, "home"), path.join(directory, "config"), path.join(directory, "tmp")]) {
      fs.mkdirSync(item, { recursive: true });
    }
    fs.cpSync(path.join(repositoryRoot, "src"), path.join(releaseRoot, "src"), { recursive: true });
    fs.cpSync(path.join(repositoryRoot, "bin"), path.join(releaseRoot, "bin"), { recursive: true });
    fs.mkdirSync(path.join(releaseRoot, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(repositoryRoot, "scripts", "rollback-runtime-host.ts"),
      path.join(releaseRoot, "scripts", "rollback-runtime-host.ts"),
    );
    fs.copyFileSync(path.join(repositoryRoot, "tsconfig.json"), path.join(releaseRoot, "tsconfig.json"));
    fs.symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(releaseRoot, "node_modules"), "dir");
    fs.writeFileSync(path.join(binDir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "container" ] && [ "$2" = "start" ]; then
  : > "$FAKE_DOCKER_START_ACCEPTED"
  requester="$PPID"
  while kill -0 "$requester" 2>/dev/null; do sleep 0.02; done
fi
exit 0
`, { mode: 0o755 });

    fs.writeFileSync(releaseFile, JSON.stringify(active));
    writeRuntimeHostHandoffIntent({
      revision: active.revision,
      image: active.image,
      successorContainer: active.container,
      predecessorId: target.predecessorId,
      previousRelease: previous,
      successorRelease: active,
      recordedAt: target.recordedAt,
    }, handoffFile);
    const beforeRollback = new RuntimeJournal(journalPath, { now: () => 1_000 });
    const receipt = beforeRollback.admitViewerDeployment({
      idempotencyKey: "rollback-process-recovery",
      requestedRevision: active.revision,
      revision: active.revision,
    }, { pid: 91, startIdentity: "91:requester" });
    if (receipt.state !== "accepted") throw new Error("deployment fixture was not admitted");
    beforeRollback.updateViewerDeployment(receipt.deploymentId, {
      phase: "host-handoff",
      candidate: active,
      previous,
    });
    beforeRollback.close();

    const environment: Record<string, string> = {
      PATH: `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      HOME: path.join(directory, "home"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      TMPDIR: path.join(directory, "tmp"),
      LLV_STATE_DIR: stateDir,
      LLV_RUNTIME_HOST_SOCKET: socketPath,
      LLV_RUNTIME_HOST_FENCE: path.join(stateDir, "runtime-host.lock"),
      LLV_RUNTIME_JOURNAL: journalPath,
      LLV_RUNTIME_HOST_RELEASE_TARGET: releaseFile,
      LLV_RUNTIME_HOST_HANDOFF_INTENT_TARGET: handoffFile,
      LLV_RUNTIME_HOST_ROLLBACK_TARGET: rollbackTargetFile,
      LLV_RUNTIME_HOST_ROLLBACK_INTENT_TARGET: rollbackIntentFile,
      LLV_RUNTIME_HOST_STARTUP_TARGET: startupFile,
      LLV_VIEWER_DEPLOYMENTS: "0",
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_START_ACCEPTED: startAccepted,
    };

    executor = spawn(process.execPath, ["run", "scripts/rollback-runtime-host.ts", "--execute"], {
      cwd: releaseRoot,
      env: environment as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const executorPid = executor.pid;
    if (!executorPid) throw new Error("rollback executor pid is unavailable");
    executor.stdout?.on("data", (chunk) => { executorOutput += String(chunk); });
    executor.stderr?.on("data", (chunk) => { executorOutput += String(chunk); });
    executorExited = childExit(executor);
    await waitForFile(startAccepted, executor, () => executorOutput);
    expect(executor.exitCode).toBeNull();
    expect(fs.readFileSync(dockerLog, "utf8")).toContain(`container start ${target.predecessorId}`);
    executor.kill("SIGKILL");
    const executorResult = await executorExited;
    expect(executorResult).toEqual({ code: null, signal: "SIGKILL" });
    expect(() => process.kill(executorPid, 0)).toThrow();
    expect(fs.existsSync(rollbackIntentFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(releaseFile, "utf8"))).toEqual(previous);

    const retainedEnvironment: Record<string, string> = {
      ...environment,
      [RUNTIME_HOST_IMAGE_ENV]: previous.image,
      [RUNTIME_HOST_REVISION_ENV]: previous.revision,
      [RUNTIME_HOST_CONTAINER_ENV]: previous.container,
    };
    retained = spawn(process.execPath, ["run", "src/runtime-host/main.ts"], {
      cwd: releaseRoot,
      env: retainedEnvironment as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(retained.pid).not.toBe(executorPid);
    retained.stdout?.on("data", (chunk) => { retainedOutput += String(chunk); });
    retained.stderr?.on("data", (chunk) => { retainedOutput += String(chunk); });
    retainedExited = childExit(retained);
    let evidence = null;
    for (let attempt = 0; attempt < 200 && evidence === null; attempt += 1) {
      if (retained.exitCode !== null || retained.signalCode !== null) {
        throw new Error(`retained runtime host exited before recovery: ${retainedOutput}`);
      }
      if (fs.existsSync(socketPath)) {
        try {
          evidence = await probeRuntimeHostSuccessor(socketPath, {
            image: previous.image,
            revision: previous.revision,
            container: previous.container,
          }, { timeoutMs: 250 });
        } catch {
          // The separate recovery process has bounded startup phases; retry until ready.
        }
      }
      if (evidence === null) await Bun.sleep(25);
    }
    expect(evidence).toMatchObject({
      generation: {
        image: previous.image,
        revision: previous.revision,
        container: previous.container,
      },
      phases: [
        { phase: "fence-waiting" },
        { phase: "fence-acquired" },
        { phase: "journal-open" },
        { phase: "handoff-cleanup-complete" },
        { phase: "consumers-recovered" },
        { phase: "socket-listening" },
        { phase: "ready" },
      ],
    });

    const recoveredJournal = new RuntimeJournal(journalPath);
    expect(recoveredJournal.viewerDeployment(receipt.deploymentId)).toMatchObject({
      phase: "failed",
      terminal: true,
      error: `runtime-host handoff rolled back to ${previous.revision} after the successor failed serving readiness`,
    });
    recoveredJournal.close();
    expect(fs.existsSync(rollbackTargetFile)).toBe(false);
    expect(fs.existsSync(rollbackIntentFile)).toBe(false);
    expect(fs.existsSync(handoffFile)).toBe(false);
    const dockerCalls = fs.readFileSync(dockerLog, "utf8").trim().split("\n");
    expect(dockerCalls).toContain(`container update --restart no ${active.container}`);
    expect(dockerCalls).toContain(`container stop --time 40 ${active.container}`);
    expect(dockerCalls).toContain(`container rm -f ${active.container}`);

    const nextCandidate = {
      image: `agent-log-viewer:deploy-${"c".repeat(40)}`,
      revision: "c".repeat(40),
      container: "viewer-next",
      endpoint: "http://127.0.0.1:19482",
    };
    const nextName = runtimeHostSuccessorName(nextCandidate.revision, nextCandidate.image);
    let durableRelease = previous;
    const staged = await stageRuntimeHostSuccessorContainer(nextCandidate, "agent-log-viewer:runtime", {
      docker: async (argv) => {
        if (argv[0] === "container" && argv[1] === "ls") return "retained-runtime-id\n";
        if (argv[0] === "container" && argv[1] === "inspect" && argv[2] === "retained-runtime-id") {
          return JSON.stringify([{
            Id: "retained-runtime-id",
            Name: `/${previous.container}`,
            State: { Pid: retained?.pid },
            Config: {
              Image: previous.image,
              Cmd: ["bun-container", "run", "src/runtime-host/main.ts"],
              Env: [],
            },
            HostConfig: { NetworkMode: "host", PidMode: "host" },
          }]);
        }
        if (argv[0] === "container" && argv[1] === "inspect" && argv[2] === nextName) {
          return JSON.stringify([{
            Id: "next-runtime-id",
            RestartCount: 0,
            State: { Status: "running", Running: true, Restarting: false, StartedAt: "2026-09-01T09:00:00.000Z" },
            Config: {
              Image: nextCandidate.image,
              Labels: {
                [RUNTIME_HOST_SUCCESSOR_LABEL]: "1",
                [RUNTIME_HOST_PREDECESSOR_LABEL]: "retained-runtime-id",
                "dev.live-log-viewer.revision": nextCandidate.revision,
              },
              Env: [
                `${RUNTIME_HOST_IMAGE_ENV}=${nextCandidate.image}`,
                `${RUNTIME_HOST_REVISION_ENV}=${nextCandidate.revision}`,
                `${RUNTIME_HOST_CONTAINER_ENV}=${nextName}`,
              ],
            },
          }]);
        }
        return "";
      },
      readRelease: () => durableRelease,
      writeRelease: (release) => { durableRelease = release; },
      readHandoffIntent: () => readRuntimeHostHandoffIntent(handoffFile),
      writeHandoffIntent: (intent) => writeRuntimeHostHandoffIntent(intent, handoffFile),
      clearHandoffIntent: () => {},
      fenceOwnerPid: () => retained?.pid ?? null,
      now: () => "2026-09-01T09:00:00.000Z",
      wait: async () => {},
    });
    expect(staged).toEqual({ successorContainer: nextName });
    expect(readRuntimeHostHandoffIntent(handoffFile)).toMatchObject({
      revision: nextCandidate.revision,
      successorContainer: nextName,
      predecessorId: "retained-runtime-id",
    });
  } finally {
    await stopChild(executor, executorExited);
    await stopChild(retained, retainedExited);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

test("issue 1270: a foreign generation cannot consume another rollback intent", async () => {
  let stopped = false;
  const intent: RuntimeHostRollbackIntent = {
    ...target,
    phase: "requested",
    requestedAt: "2026-08-31T14:00:20.000Z",
  };

  const resumed = await resumeRuntimeHostRollback(
    { image: active.image, revision: active.revision, container: active.container },
    {
      readIntent: () => intent,
      disableActiveRestart: async () => { stopped = true; },
      stopActive: async () => { stopped = true; },
    },
  );

  expect(resumed).toBe(false);
  expect(stopped).toBe(false);
});

test("issue 1270: rollback terminalizes the matching active hand-over before coordinator recovery", () => {
  const status = {
    deploymentId: "deploy-runtime-host-failed",
    phase: "host-handoff",
    terminal: false,
    candidate: {
      image: active.image,
      revision: active.revision,
    },
  } as ViewerDeploymentStatus;

  expect(runtimeHostRollbackDeploymentUpdate(status, target)).toEqual({
    phase: "failed",
    terminal: true,
    error: `runtime-host handoff rolled back to ${previous.revision} after the successor failed serving readiness`,
  });
  expect(runtimeHostRollbackDeploymentUpdate({ ...status, phase: "succeeded", terminal: true }, target)).toBeNull();
  expect(runtimeHostRollbackDeploymentUpdate({
    ...status,
    candidate: { ...status.candidate!, image: "another-image" },
  }, target)).toBeNull();
});

test("issue 1270: an in-flight handoff is a rollback target before successor cleanup", () => {
  expect(runtimeHostRollbackTargetFromHandoff({
    revision: active.revision,
    image: active.image,
    successorContainer: active.container,
    predecessorId: target.predecessorId,
    previousRelease: previous,
    successorRelease: active,
    recordedAt: target.recordedAt,
  })).toEqual(target);
  expect(runtimeHostRollbackTargetFromHandoff({
    revision: active.revision,
    image: active.image,
    successorContainer: active.container,
    predecessorId: target.predecessorId,
    recordedAt: target.recordedAt,
  })).toBeNull();
});
