import { createHash } from "node:crypto";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";
import { withoutWakatimeCredentialEntries } from "@/lib/wakatime/credential";

import {
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  type RuntimeHostHandoffIntent,
  type RuntimeHostReleaseRecord,
} from "./hostRelease";

/** Environment variable read by main.ts: a successor boots while the
    predecessor still holds the singleton fence and must wait for it instead
    of failing its container. */
export const RUNTIME_HOST_FENCE_WAIT_ENV = "LLV_RUNTIME_HOST_FENCE_WAIT_MS";
const SUCCESSOR_FENCE_WAIT_MS = 10 * 60_000;
export const RUNTIME_HOST_SUCCESSOR_LABEL = "dev.live-log-viewer.runtime-host-successor";

export interface RuntimeHostSuccessorPorts {
  /** Short-lived CLI call against the host Docker daemon. Every mutation this
      module performs is daemon-owned and atomic per call, so the initiating
      process may die between calls without losing the successor. */
  docker(argv: string[]): Promise<string>;
  writeRelease(record: RuntimeHostReleaseRecord): void;
  /** The current durable release record, or null. Recovery reads it to keep
      publication exactly-once across a crash boundary (PR #521). */
  readRelease(): RuntimeHostReleaseRecord | null;
  /** The durable intermediate successor identity (PR #521): written after the
      successor is observably stable and before the predecessor's restart
      policy is disabled. The fenced successor clears it after removing the
      predecessor container. */
  readHandoffIntent(): RuntimeHostHandoffIntent | null;
  writeHandoffIntent(intent: RuntimeHostHandoffIntent): void;
  clearHandoffIntent(): void;
  /** The singleton fence owner (host pid — the runtime-host service runs with
      pid: host), or null when unreadable. */
  fenceOwnerPid(): number | null;
  now?(): string;
  wait?(milliseconds: number): Promise<void>;
}

export interface RuntimeHostHandoffCleanupPorts {
  docker(argv: string[]): Promise<string>;
  readHandoffIntent(): RuntimeHostHandoffIntent | null;
  clearHandoffIntent(): void;
}

export interface RuntimeHostGenerationIdentity {
  image: string;
  revision: string;
  container: string;
}

export function runtimeHostSuccessorName(revision: string, image: string): string {
  const generation = createHash("sha256").update(image).digest("hex").slice(0, 12);
  return `llv-runtime-host-${revision.slice(0, 12)}-${generation}`;
}

/** Complete cleanup only from the successor generation after it owns the
    singleton fence. The durable intent retains the predecessor container id
    across both process exits and machine restarts. */
export async function completeRuntimeHostHandoff(
  generation: RuntimeHostGenerationIdentity,
  ports: RuntimeHostHandoffCleanupPorts,
): Promise<boolean> {
  const intent = ports.readHandoffIntent();
  if (!intent
    || intent.image !== generation.image
    || intent.revision !== generation.revision
    || intent.successorContainer !== generation.container) return false;
  const successorInspection = JSON.parse(await ports.docker(["container", "inspect", generation.container])) as Array<Record<string, unknown>>;
  const successorId = successorInspection[0]?.Id;
  if (intent.predecessorId === generation.container || intent.predecessorId === successorId) {
    throw new Error("runtime-host handoff predecessor matches the active successor");
  }
  try {
    await ports.docker(["container", "rm", "-f", intent.predecessorId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/No such container|No such object/i.test(message)) throw error;
  }
  ports.clearHandoffIntent();
  return true;
}

interface PredecessorTopology {
  id: string;
  env: string[];
  cmd: string[];
  containerUser: string;
  workingDir: string;
  binds: string[];
  groupAdd: string[];
  networkMode: string;
  pidMode: string;
  privileged: boolean;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : [];
}

function parseTopology(id: string, raw: string): PredecessorTopology {
  const inspected = JSON.parse(raw) as Array<Record<string, unknown>>;
  const container = inspected[0] ?? {};
  const config = (container.Config ?? {}) as Record<string, unknown>;
  const hostConfig = (container.HostConfig ?? {}) as Record<string, unknown>;
  const cmd = stringArray(config.Cmd);
  if (cmd.length === 0) throw new Error("predecessor runtime-host command is unavailable");
  return {
    id,
    /* PR #521: the inspected predecessor environment may carry the unsupported
       credential; drop the entry before its name or value can reach `docker
       run` arguments or successor metadata. */
    env: withoutWakatimeCredentialEntries(stringArray(config.Env)),
    cmd,
    containerUser: typeof config.User === "string" ? config.User : "",
    workingDir: typeof config.WorkingDir === "string" ? config.WorkingDir : "",
    binds: stringArray(hostConfig.Binds),
    groupAdd: stringArray(hostConfig.GroupAdd),
    networkMode: typeof hostConfig.NetworkMode === "string" ? hostConfig.NetworkMode : "host",
    pidMode: typeof hostConfig.PidMode === "string" ? hostConfig.PidMode : "host",
    privileged: hostConfig.Privileged === true,
  };
}

async function findPredecessor(ports: RuntimeHostSuccessorPorts): Promise<PredecessorTopology | null> {
  const ownerPid = ports.fenceOwnerPid();
  if (!ownerPid) return null;
  const listed = await ports.docker(["container", "ls", "--format", "{{.ID}}"]);
  for (const id of listed.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const raw = await ports.docker(["container", "inspect", id]);
    const inspected = JSON.parse(raw) as Array<Record<string, unknown>>;
    const state = (inspected[0]?.State ?? {}) as Record<string, unknown>;
    if (state.Pid === ownerPid) return parseTopology(id, raw);
  }
  return null;
}

function successorRunArgs(
  name: string,
  candidate: ViewerReleaseIdentity,
  predecessor: PredecessorTopology,
): string[] {
  return [
    "run", "-d",
    "--name", name,
    /* dockerd owns the restart policy: the successor waits for the singleton
       fence and survives every client-process death, including this one. */
    "--restart", "unless-stopped",
    "--label", `${RUNTIME_HOST_SUCCESSOR_LABEL}=1`,
    "--label", `dev.live-log-viewer.revision=${candidate.revision}`,
    "--network", predecessor.networkMode,
    "--pid", predecessor.pidMode,
    ...(predecessor.privileged ? ["--privileged"] : []),
    ...(predecessor.containerUser ? ["--user", predecessor.containerUser] : []),
    ...(predecessor.workingDir ? ["--workdir", predecessor.workingDir] : []),
    ...predecessor.groupAdd.flatMap((group) => ["--group-add", group]),
    ...predecessor.binds.flatMap((bind) => ["-v", bind]),
    ...predecessor.env.flatMap((entry) => ["-e", entry]),
    "-e", `${RUNTIME_HOST_FENCE_WAIT_ENV}=${SUCCESSOR_FENCE_WAIT_MS}`,
    "-e", `${RUNTIME_HOST_IMAGE_ENV}=${candidate.image}`,
    "-e", `${RUNTIME_HOST_REVISION_ENV}=${candidate.revision}`,
    "-e", `${RUNTIME_HOST_CONTAINER_ENV}=${name}`,
    candidate.image,
    ...predecessor.cmd,
  ];
}

/** The successor's start identity. A crash-looping container can present two
    "running" snapshots while dockerd restarts it in between (PR #521), so the
    stability gate compares the container id, its restart count, and its
    StartedAt timestamp across the two observations. */
interface SuccessorStartIdentity {
  id: string;
  restartCount: number | null;
  startedAt: string | null;
}

function successorStartIdentity(raw: string): SuccessorStartIdentity {
  const container = ((JSON.parse(raw) as Array<Record<string, unknown>>)[0] ?? {}) as Record<string, unknown>;
  const state = (container.State ?? {}) as Record<string, unknown>;
  return {
    id: typeof container.Id === "string" ? container.Id : "",
    restartCount: typeof container.RestartCount === "number" ? container.RestartCount : null,
    startedAt: typeof state.StartedAt === "string" ? state.StartedAt : null,
  };
}

function successorMatchesGeneration(raw: string, name: string, candidate: ViewerReleaseIdentity): boolean {
  const inspected = JSON.parse(raw) as Array<Record<string, unknown>>;
  const container = inspected[0] ?? {};
  const config = (container.Config ?? {}) as Record<string, unknown>;
  const labels = (config.Labels ?? {}) as Record<string, unknown>;
  const environment = stringArray(config.Env);
  return config.Image === candidate.image
    && labels[RUNTIME_HOST_SUCCESSOR_LABEL] === "1"
    && labels["dev.live-log-viewer.revision"] === candidate.revision
    && environment.includes(`${RUNTIME_HOST_IMAGE_ENV}=${candidate.image}`)
    && environment.includes(`${RUNTIME_HOST_REVISION_ENV}=${candidate.revision}`)
    && environment.includes(`${RUNTIME_HOST_CONTAINER_ENV}=${name}`);
}

function successorIsReady(raw: string, name: string, candidate: ViewerReleaseIdentity): boolean {
  const inspected = JSON.parse(raw) as Array<Record<string, unknown>>;
  const state = (inspected[0]?.State ?? {}) as Record<string, unknown>;
  return successorMatchesGeneration(raw, name, candidate)
    && state.Status === "running"
    && state.Running === true
    && state.Restarting !== true;
}

/** Two identity-aware observations: both must report the ready running state,
    and the successor's start identity must not change between them — a
    crash-looping container can report "running" to both probes while dockerd
    restarts it in between (PR #521). */
async function observeStableSuccessor(
  name: string,
  candidate: ViewerReleaseIdentity,
  ports: RuntimeHostSuccessorPorts,
): Promise<void> {
  const firstEvidence = await ports.docker(["container", "inspect", name]);
  if (!successorIsReady(firstEvidence, name, candidate)) {
    throw new Error("runtime-host successor container failed its identity or running-state gate");
  }
  await (ports.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(250);
  const stableEvidence = await ports.docker(["container", "inspect", name]);
  if (!successorIsReady(stableEvidence, name, candidate)) {
    throw new Error("runtime-host successor container did not remain stably ready");
  }
  const first = successorStartIdentity(firstEvidence);
  const stable = successorStartIdentity(stableEvidence);
  if (first.id !== stable.id || first.restartCount !== stable.restartCount || first.startedAt !== stable.startedAt) {
    throw new Error("runtime-host successor container restarted between readiness probes");
  }
}

async function disablePredecessorRestart(predecessorId: string, ports: RuntimeHostSuccessorPorts): Promise<void> {
  try {
    await ports.docker(["container", "update", "--restart", "no", predecessorId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    /* Recovery may run after the crashed predecessor already exited and was
       removed; a missing container can never restart, which is the goal
       state of this step. */
    if (!/No such container|No such object/i.test(message)) throw error;
  }
}

/** Publication is exactly-once across crash boundaries: a retry that finds
    the release record already bound to this successor generation must not
    write it again (PR #521). */
function publishReleaseOnce(name: string, candidate: ViewerReleaseIdentity, ports: RuntimeHostSuccessorPorts): void {
  const current = ports.readRelease();
  if (current && current.image === candidate.image && current.revision === candidate.revision && current.container === name) return;
  ports.writeRelease({
    ...candidate,
    container: name,
    stagedAt: (ports.now ?? (() => new Date().toISOString()))(),
  });
}

/** #518 runtime-host generation handoff, built exclusively from daemon-side
    atomic Docker operations. The runtime-host container runs a baked image
    and Bun loads modules once at boot, so only a successor container created
    from the freshly built candidate image can execute the deployed revision.

    Ordering is the contract:
    1. the candidate image must exist — nothing durable changes otherwise;
    2. the service tag is repointed at the candidate image, so any future
       (re)creation of the compose service boots the deployed revision;
    3. the successor container is created and started by dockerd with a
       restart policy, cloned from the predecessor's topology. It waits for
       the singleton fence, so both generations coexist without a second
       journal writer, and it survives the death of every initiating client
       process — this module never stops, kills, or removes the predecessor;
    4. two identity-aware observations prove that the successor remains in its
       running fence-wait state without restarting in between;
    5. the durable handoff intent records the successor and predecessor
       identities (PR #521) — from here on a crash is recovered from the
       intent, never by rediscovering a predecessor through the fence owner,
       which may already be the successor itself;
    6. the predecessor's restart policy is disabled before publication, so a
       stale generation can never boot and claim the candidate record;
    7. the durable release record binds the successor image, revision, and
       container identity after every prerequisite is complete — exactly once;
    8. after the predecessor exits and the successor acquires the fence, the
       successor removes the recorded predecessor and clears the intent.
    A failure leaves the predecessor serving and the staging operation
    retryable from its durable deployment phase. */
export async function stageRuntimeHostSuccessorContainer(
  candidate: ViewerReleaseIdentity,
  runtimeHostImageTag: string,
  ports: RuntimeHostSuccessorPorts,
): Promise<{ successorContainer: string }> {
  const name = runtimeHostSuccessorName(candidate.revision, candidate.image);
  const intent = ports.readHandoffIntent();
  const exactIntent = intent
    && intent.revision === candidate.revision
    && intent.image === candidate.image
    && intent.successorContainer === name;
  if (intent && !exactIntent) {
    throw new Error("runtime-host handoff intent is owned by another generation");
  }
  await ports.docker(["image", "inspect", candidate.image]);
  await ports.docker(["tag", candidate.image, runtimeHostImageTag]);
  if (exactIntent) {
    /* PR #521 crash recovery: the previous staging died between recording the
       intent and clearing it. The predecessor may have exited and the
       successor may already own the singleton fence, so fence-owner
       predecessor discovery is forbidden here — it would select, disable,
       and exit the successor itself. Both identities come from the intent. */
    await ports.docker(["container", "start", name]);
    await observeStableSuccessor(name, candidate, ports);
    await disablePredecessorRestart(intent.predecessorId, ports);
    publishReleaseOnce(name, candidate, ports);
    return { successorContainer: name };
  }
  const predecessor = await findPredecessor(ports);
  if (!predecessor) throw new Error("runtime-host predecessor container is unavailable for successor staging");
  try {
    await ports.docker(successorRunArgs(name, candidate, predecessor));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    /* A same-attempt leftover may be reused only after its complete immutable
       generation identity matches. A stale or foreign collision must stay
       stopped so it can never acquire the singleton fence. */
    if (!/is already in use|Conflict/.test(message)) throw error;
    const collision = await ports.docker(["container", "inspect", name]);
    if (!successorMatchesGeneration(collision, name, candidate)) {
      throw new Error("runtime-host successor container failed its identity or running-state gate");
    }
    await ports.docker(["container", "start", name]);
  }
  await observeStableSuccessor(name, candidate, ports);
  ports.writeHandoffIntent({
    revision: candidate.revision,
    image: candidate.image,
    successorContainer: name,
    predecessorId: predecessor.id,
    recordedAt: (ports.now ?? (() => new Date().toISOString()))(),
  });
  await disablePredecessorRestart(predecessor.id, ports);
  publishReleaseOnce(name, candidate, ports);
  return { successorContainer: name };
}
