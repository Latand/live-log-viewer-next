import { expect, test } from "bun:test";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import {
  awaitRuntimeHostSuccessorFence,
  executeRuntimeHostBootstrap,
  planRuntimeHostBootstrap,
  renderRuntimeHostBootstrapPlan,
  runtimeHostBootstrapRefusal,
  type RuntimeHostBootstrapMode,
  type RuntimeHostBootstrapPorts,
} from "./hostBootstrap";
import { runtimeHostSuccessorName } from "./hostSuccessor";

const revision = "c".repeat(40);
const image = `agent-log-viewer:hostboot-${revision}`;
const stableEndpoint = "http://127.0.0.1:8898";

function predecessor(overrides: Partial<{ id: string; name: string; image: string }> = {}) {
  return {
    id: "f".repeat(64),
    name: "llv-runtime-host-704ff4636294-0123456789ab",
    image: "agent-log-viewer:deploy-704ff4636294",
    ...overrides,
  };
}

function plan(mode: RuntimeHostBootstrapMode, overrides: Partial<Parameters<typeof planRuntimeHostBootstrap>[0]> = {}) {
  return planRuntimeHostBootstrap({
    mode,
    revision,
    image,
    predecessor: predecessor(),
    stableEndpoint,
    ...overrides,
  });
}

function candidate(): ViewerReleaseIdentity {
  return { revision, image, container: runtimeHostSuccessorName(revision, image), endpoint: stableEndpoint };
}

interface Recorded {
  calls: string[];
  lines: string[];
  ports: RuntimeHostBootstrapPorts;
}

function recorder(options: { fenceOwner?: (calls: string[]) => number | null; successorPid?: number | null } = {}): Recorded {
  const calls: string[] = [];
  const lines: string[] = [];
  const successorPid = options.successorPid === undefined ? 4242 : options.successorPid;
  return {
    calls,
    lines,
    ports: {
      stageSuccessor: async (target) => {
        calls.push(`stage:${target.revision}`);
        return { successorContainer: runtimeHostSuccessorName(target.revision, target.image) };
      },
      stopPredecessor: async (id) => { calls.push(`stop:${id.slice(0, 6)}`); },
      successorPid: async () => successorPid,
      fenceOwnerPid: () => options.fenceOwner ? options.fenceOwner(calls) : successorPid,
      sleep: async () => {},
      log: (line) => { lines.push(line); },
    },
  };
}

/* The reopened half of #1216: a runtime host pinned to the revision that
   carries the promote defect can only be replaced by a deployment that
   reaches `host-handoff`, which is downstream of the promote that fails. The
   bootstrap is the path that does not require a promote to have succeeded, so
   the first thing it owes an operator whose host owns live agent sessions is a
   statement of what it will stop. */
test("issue 1216: the plan names the one container a hand-over stops before anything runs", () => {
  const rendered = renderRuntimeHostBootstrapPlan(plan("hand-over"));

  expect(rendered).toContain("mode         hand-over");
  expect(rendered).toContain(`revision     ${revision}`);
  expect(rendered).toContain(`successor    ${runtimeHostSuccessorName(revision, image)}`);
  expect(rendered).toContain("predecessor  llv-runtime-host-704ff4636294-0123456789ab");
  expect(rendered).toContain("the predecessor runtime-host container llv-runtime-host-704ff4636294-0123456789ab, and nothing else");
  /* The sessions the operator is worried about are named as untouched, not
     left to inference. */
  expect(rendered).toContain("every live agent session, pipeline, and orchestrator they own");
  expect(rendered).toContain(`${stableEndpoint} is unserved between the predecessor exit and the successor acquiring the singleton fence`);
});

test("issue 1216: the plan and stage modes both promise to stop nothing", () => {
  for (const mode of ["plan", "stage"] as const) {
    expect(renderRuntimeHostBootstrapPlan(plan(mode)))
      .toContain("nothing — this mode never stops a container");
  }
});

test("issue 1216: a bootstrap without a running runtime host is refused by name", () => {
  expect(runtimeHostBootstrapRefusal(plan("hand-over", { predecessor: null })))
    .toBe("no running runtime-host container owns the singleton fence; start the runtime-host service before bootstrapping a successor");
});

test("issue 1216: a runtime host already on the target generation is refused rather than restarted", () => {
  const already = predecessor({ name: runtimeHostSuccessorName(revision, image) });

  expect(runtimeHostBootstrapRefusal(plan("hand-over", { predecessor: already })))
    .toBe(`the runtime host already runs ${revision} from ${image}`);
});

test("issue 1216: a bootstrap refuses a revision that is not a resolved commit", () => {
  expect(runtimeHostBootstrapRefusal(plan("stage", { revision: "origin/main" })))
    .toBe("runtime-host bootstrap needs a resolved 40-character commit SHA");
});

test("issue 1216: plan mode changes nothing at all", async () => {
  const recorded = recorder();

  const outcome = await executeRuntimeHostBootstrap(plan("plan"), candidate(), recorded.ports);

  expect(outcome).toEqual({
    successorContainer: runtimeHostSuccessorName(revision, image),
    handedOver: false,
    fenceWaitedMs: null,
  });
  expect(recorded.calls).toEqual([]);
});

test("issue 1216: stage mode creates the successor and leaves the predecessor serving", async () => {
  const recorded = recorder();

  const outcome = await executeRuntimeHostBootstrap(plan("stage"), candidate(), recorded.ports);

  expect(outcome.handedOver).toBe(false);
  expect(recorded.calls).toEqual([`stage:${revision}`]);
  expect(recorded.lines.some((line) => line.startsWith("nothing was stopped;"))).toBe(true);
});

test("issue 1216: a hand-over stops the predecessor only after the successor is staged", async () => {
  const recorded = recorder();

  const outcome = await executeRuntimeHostBootstrap(plan("hand-over"), candidate(), recorded.ports);

  expect(recorded.calls).toEqual([`stage:${revision}`, "stop:ffffff"]);
  expect(outcome.handedOver).toBe(true);
  expect(outcome.successorContainer).toBe(runtimeHostSuccessorName(revision, image));
  expect(recorded.lines.some((line) => line.includes("owns the singleton fence"))).toBe(true);
});

/* The predecessor's exit is asynchronous — the successor only acquires the
   fence once the predecessor has drained. #1216 is what a wait with no name
   costs, so this one reports what it is waiting for and what it saw. */
test("issue 1216: a fence that arrives late but inside the budget succeeds", async () => {
  let elapsedMs = 0;
  const reports: string[] = [];
  let polls = 0;

  const fence = await awaitRuntimeHostSuccessorFence({
    successorContainer: "llv-runtime-host-abcdef012345-0123456789ab",
    successorPid: async () => { polls += 1; return polls < 4 ? null : 4242; },
    fenceOwnerPid: () => polls < 4 ? 99 : 4242,
    sleep: async (delayMs) => { elapsedMs += delayMs; },
    now: () => elapsedMs,
    report: (line) => { reports.push(line); },
    timeoutMs: 10_000,
    pollMs: 1_000,
  });

  expect(fence).toEqual({ waitedMs: 3_000, pid: 4242 });
  expect(reports[0]).toBe("waiting for the runtime-host successor to acquire the singleton fence - 0s of 10s - the successor container is not running");
});

test("issue 1216: a fence that never arrives fails with a named reason and what it saw", async () => {
  let elapsedMs = 0;

  await expect(awaitRuntimeHostSuccessorFence({
    successorContainer: "llv-runtime-host-abcdef012345-0123456789ab",
    successorPid: async () => 4242,
    fenceOwnerPid: () => 99,
    sleep: async (delayMs) => { elapsedMs += delayMs; },
    now: () => elapsedMs,
    timeoutMs: 3_000,
    pollMs: 1_000,
  })).rejects.toThrow(
    "runtime-host successor llv-runtime-host-abcdef012345-0123456789ab never acquired the singleton fence"
    + "; waited 3s of 3s"
    + "; last observed successor pid 4242, fence owner pid 99",
  );
});

test("issue 1216: an unreadable fence lock is named rather than read as success", async () => {
  let elapsedMs = 0;

  await expect(awaitRuntimeHostSuccessorFence({
    successorContainer: "llv-runtime-host-abcdef012345-0123456789ab",
    successorPid: async () => 4242,
    fenceOwnerPid: () => null,
    sleep: async (delayMs) => { elapsedMs += delayMs; },
    now: () => elapsedMs,
    timeoutMs: 1_000,
    pollMs: 1_000,
  })).rejects.toThrow("; last observed successor pid 4242, fence owner unreadable");
});

test("issue 1216: a refused plan never reaches the staging step", async () => {
  const recorded = recorder();

  await expect(executeRuntimeHostBootstrap(plan("hand-over", { predecessor: null }), candidate(), recorded.ports))
    .rejects.toThrow("no running runtime-host container owns the singleton fence");
  expect(recorded.calls).toEqual([]);
});
