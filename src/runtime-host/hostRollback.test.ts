import { expect, test } from "bun:test";

import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import type {
  RuntimeHostReleaseRecord,
  RuntimeHostRollbackIntent,
  RuntimeHostRollbackTarget,
} from "./hostRelease";
import {
  completeRuntimeHostRollback,
  runtimeHostRollbackTargetFromHandoff,
  requestRuntimeHostRollback,
  resumeRuntimeHostRollback,
  runtimeHostRollbackDeploymentUpdate,
} from "./hostRollback";

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

test("issue 1270: a retained predecessor finishes rollback after the requesting executor dies", async () => {
  let intent: RuntimeHostRollbackIntent | null = null;
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

  const completed = await completeRuntimeHostRollback(
    { image: previous.image, revision: previous.revision, container: previous.container },
    {
      readIntent: () => intent,
      removeFailed: async (container) => { calls.push(`remove:${container}`); },
      clearTarget: () => { targetExists = false; },
      clearIntent: () => { intent = null; },
    },
  );

  expect(completed).toBe(true);
  expect(calls.at(-1)).toBe(`remove:${active.container}`);
  expect(targetExists).toBe(false);
  expect(intent).toBeNull();
});

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
