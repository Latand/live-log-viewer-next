import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import {
  runtimeHostSuccessorName,
  type RuntimeHostPredecessorIdentity,
} from "./hostSuccessor";

/* #1216 runtime-host bootstrap.
 *
 * The runtime host executes the promote, and it runs a baked image, so the
 * only supported way onto a new revision used to be the #518 succession that
 * a deployment stages in its `host-handoff` phase — strictly downstream of the
 * promote. A promote defect therefore pinned the host to the revision that
 * carried the defect: the repair could only be delivered by the mechanism it
 * repaired.
 *
 * This module is the way out. It stages the same #518 successor from a chosen
 * revision without a deployment, so a promote never has to have succeeded.
 * The steps it drives are the deployment's own, in the same order, and it adds
 * exactly one thing a deployment does not need: the predecessor's exit is a
 * named, budgeted step here, because there is no `onHostHandoff` signal to
 * carry it.
 *
 * Nothing runs before the plan is rendered. The plan names the one container
 * this will stop and the ones it will not, because the machine it runs on has
 * live agent sessions on it.
 */

/** The successor waits on the singleton fence for ten minutes (#518), but a
    predecessor that is going to exit does so in seconds: it drains the socket
    server, closes the journal and releases the fence. Two minutes is generous
    for that and short enough that a predecessor which is NOT exiting is
    reported while the operator is still watching. */
export const RUNTIME_HOST_FENCE_TIMEOUT_MS = 120_000;
export const RUNTIME_HOST_FENCE_POLL_MS = 1_000;

export type RuntimeHostBootstrapMode = "plan" | "stage" | "hand-over";

export interface RuntimeHostBootstrapPlan {
  mode: RuntimeHostBootstrapMode;
  revision: string;
  image: string;
  successorContainer: string;
  predecessor: RuntimeHostPredecessorIdentity | null;
  /** The listener the deployment proxy serves, which is unserved for the
      length of the hand-over. */
  stableEndpoint: string;
  fenceTimeoutMs: number;
}

export function planRuntimeHostBootstrap(input: {
  mode: RuntimeHostBootstrapMode;
  revision: string;
  image: string;
  predecessor: RuntimeHostPredecessorIdentity | null;
  stableEndpoint: string;
  fenceTimeoutMs?: number;
}): RuntimeHostBootstrapPlan {
  return {
    mode: input.mode,
    revision: input.revision,
    image: input.image,
    successorContainer: runtimeHostSuccessorName(input.revision, input.image),
    predecessor: input.predecessor,
    stableEndpoint: input.stableEndpoint,
    fenceTimeoutMs: input.fenceTimeoutMs ?? RUNTIME_HOST_FENCE_TIMEOUT_MS,
  };
}

/** Why this bootstrap must not run, or `null`. Refusals are named so the
    operator reads a reason rather than a Docker error from three steps in. */
export function runtimeHostBootstrapRefusal(plan: RuntimeHostBootstrapPlan): string | null {
  if (!/^[0-9a-f]{40}$/.test(plan.revision)) {
    return "runtime-host bootstrap needs a resolved 40-character commit SHA";
  }
  if (!plan.predecessor) {
    return "no running runtime-host container owns the singleton fence; start the runtime-host service before bootstrapping a successor";
  }
  if (plan.predecessor.name === plan.successorContainer) {
    return `the runtime host already runs ${plan.revision} from ${plan.image}`;
  }
  return null;
}

function bullet(lines: string[]): string {
  return lines.map((line) => `  - ${line}`).join("\n");
}

/** The statement the operator reads before anything on the machine changes. */
export function renderRuntimeHostBootstrapPlan(plan: RuntimeHostBootstrapPlan): string {
  const predecessor = plan.predecessor
    ? `${plan.predecessor.name} (${plan.predecessor.id.slice(0, 12)}) running ${plan.predecessor.image || "an unnamed image"}`
    : "none — no container owns the singleton fence";
  const fenceSeconds = Math.round(plan.fenceTimeoutMs / 1_000);
  const stops = plan.mode === "hand-over"
    ? bullet([
      `the predecessor runtime-host container ${plan.predecessor?.name ?? "(none)"}, and nothing else`,
    ])
    : bullet(["nothing — this mode never stops a container"]);
  return [
    "runtime-host bootstrap plan",
    `  mode         ${plan.mode}`,
    `  revision     ${plan.revision}`,
    `  image        ${plan.image}`,
    `  successor    ${plan.successorContainer}`,
    `  predecessor  ${predecessor}`,
    "",
    "will stop:",
    stops,
    "",
    "will NOT stop, signal, or restart:",
    bullet([
      "Viewer release containers, including the one serving production",
      "the structured and engine hosts inside them",
      "every live agent session, pipeline, and orchestrator they own",
    ]),
    "",
    "before anything is stopped:",
    bullet([
      "the successor container is created and proven stable while the predecessor keeps serving",
      "the predecessor restart policy is set to no, so a predecessor that dies later will not come back",
      "the durable runtime-host release record is repointed at the successor",
    ]),
    "",
    "during the hand-over:",
    bullet([
      `${plan.stableEndpoint} is unserved between the predecessor exit and the successor acquiring the singleton fence`,
      `this run waits up to ${fenceSeconds}s for that fence and names what it saw if it never arrives`,
      "the successor removes the stopped predecessor container once it owns the fence",
    ]),
  ].join("\n");
}

export interface RuntimeHostBootstrapPorts {
  /** #518 staging, unchanged: creates the successor, proves it stable, and
      publishes the release record without touching the predecessor process. */
  stageSuccessor(candidate: ViewerReleaseIdentity): Promise<{ successorContainer: string }>;
  /** Graceful stop of the predecessor container — the only thing this module
      ever stops. */
  stopPredecessor(predecessorId: string): Promise<void>;
  /** The successor container's main pid, or `null` while it is not running. */
  successorPid(): Promise<number | null>;
  /** The singleton fence owner pid, or `null` when the lock is unreadable. */
  fenceOwnerPid(): number | null;
  sleep(milliseconds: number): Promise<void>;
  now?(): number;
  log(line: string): void;
}

export interface RuntimeHostBootstrapOutcome {
  successorContainer: string;
  handedOver: boolean;
  fenceWaitedMs: number | null;
}

export function runtimeHostFenceObservation(successor: number | null, fenceOwner: number | null): string {
  if (successor === null) return "the successor container is not running";
  if (fenceOwner === null) return `successor pid ${successor}, fence owner unreadable`;
  return `successor pid ${successor}, fence owner pid ${fenceOwner}`;
}

export function runtimeHostFenceTimeoutMessage(input: {
  successorContainer: string;
  waitedMs: number;
  budgetMs: number;
  observation: string;
}): string {
  const seconds = (value: number) => Math.max(0, Math.round(value / 1_000));
  return [
    `runtime-host successor ${input.successorContainer} never acquired the singleton fence`,
    `waited ${seconds(input.waitedMs)}s of ${seconds(input.budgetMs)}s`,
    `last observed ${input.observation}`,
  ].join("; ");
}

/** The hand-over's own visible outcome. The predecessor's exit is asynchronous
    — dockerd stops it, it drains, and only then does the successor's fence
    wait return — so this step reports what it is waiting for, how long it has
    waited, and what it saw at give-up, exactly like the promote's hot-state
    waits do (#1216). */
export async function awaitRuntimeHostSuccessorFence(options: {
  successorContainer: string;
  successorPid(): Promise<number | null>;
  fenceOwnerPid(): number | null;
  sleep(milliseconds: number): Promise<void>;
  now?(): number;
  report?(line: string): void;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{ waitedMs: number; pid: number }> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(100, options.timeoutMs ?? RUNTIME_HOST_FENCE_TIMEOUT_MS);
  const pollMs = Math.max(5, options.pollMs ?? RUNTIME_HOST_FENCE_POLL_MS);
  const started = now();
  let observation = runtimeHostFenceObservation(null, null);
  for (;;) {
    const successor = await options.successorPid();
    const fenceOwner = options.fenceOwnerPid();
    observation = runtimeHostFenceObservation(successor, fenceOwner);
    if (successor !== null && fenceOwner === successor) return { waitedMs: now() - started, pid: successor };
    const elapsedMs = now() - started;
    options.report?.(`waiting for the runtime-host successor to acquire the singleton fence - ${Math.round(elapsedMs / 1_000)}s of ${Math.round(timeoutMs / 1_000)}s - ${observation}`);
    if (elapsedMs >= timeoutMs) {
      throw new Error(runtimeHostFenceTimeoutMessage({
        successorContainer: options.successorContainer,
        waitedMs: elapsedMs,
        budgetMs: timeoutMs,
        observation,
      }));
    }
    await options.sleep(pollMs);
  }
}

/** Ordered, and every step announces itself before it runs. `plan` returns
    before anything mutates; `stage` leaves the predecessor serving; only
    `hand-over` stops it, and only after the successor is durably staged. */
export async function executeRuntimeHostBootstrap(
  plan: RuntimeHostBootstrapPlan,
  candidate: ViewerReleaseIdentity,
  ports: RuntimeHostBootstrapPorts,
): Promise<RuntimeHostBootstrapOutcome> {
  const refusal = runtimeHostBootstrapRefusal(plan);
  if (refusal) throw new Error(refusal);
  const predecessor = plan.predecessor;
  if (!predecessor) throw new Error("runtime-host bootstrap lost its predecessor between planning and staging");
  if (plan.mode === "plan") {
    return { successorContainer: plan.successorContainer, handedOver: false, fenceWaitedMs: null };
  }
  ports.log(`staging runtime-host successor ${plan.successorContainer} for ${plan.revision}; ${predecessor.name} keeps serving`);
  const staged = await ports.stageSuccessor(candidate);
  ports.log(`staged runtime-host successor ${staged.successorContainer}; it is waiting for the singleton fence`);
  if (plan.mode === "stage") {
    ports.log(`nothing was stopped; re-run with --hand-over to stop ${predecessor.name} and let the successor take over`);
    return { successorContainer: staged.successorContainer, handedOver: false, fenceWaitedMs: null };
  }
  ports.log(`stopping the predecessor runtime-host container ${predecessor.name}; ${plan.stableEndpoint} is unserved until the successor acquires the fence`);
  await ports.stopPredecessor(predecessor.id);
  const fence = await awaitRuntimeHostSuccessorFence({
    successorContainer: staged.successorContainer,
    successorPid: () => ports.successorPid(),
    fenceOwnerPid: () => ports.fenceOwnerPid(),
    sleep: (milliseconds) => ports.sleep(milliseconds),
    ...(ports.now ? { now: () => ports.now!() } : {}),
    report: (line) => ports.log(line),
    timeoutMs: plan.fenceTimeoutMs,
  });
  ports.log(`runtime-host successor ${staged.successorContainer} owns the singleton fence after ${Math.round(fence.waitedMs / 1_000)}s; the runtime host now runs ${plan.revision}`);
  return { successorContainer: staged.successorContainer, handedOver: true, fenceWaitedMs: fence.waitedMs };
}
