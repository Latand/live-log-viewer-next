import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import type { RuntimeHostReleaseRecord } from "./hostRelease";

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
  /** The singleton fence owner (host pid — the runtime-host service runs with
      pid: host), or null when unreadable. */
  fenceOwnerPid(): number | null;
  now?(): string;
}

export function runtimeHostSuccessorName(revision: string): string {
  return `llv-runtime-host-${revision.slice(0, 12)}`;
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
    env: stringArray(config.Env),
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
    candidate.image,
    ...predecessor.cmd,
  ];
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
    4. the durable release record binds successor image to revision only
       after the successor container is observably running;
    5. the predecessor's own restart policy is disabled last, so its later
       graceful exit (the handoff) cannot resurrect the stale image.
    A failure at any step throws before the record is written, leaving the
    predecessor serving and the staging retryable on the next deployment. */
export async function stageRuntimeHostSuccessorContainer(
  candidate: ViewerReleaseIdentity,
  runtimeHostImageTag: string,
  ports: RuntimeHostSuccessorPorts,
): Promise<{ successorContainer: string }> {
  await ports.docker(["image", "inspect", candidate.image]);
  await ports.docker(["tag", candidate.image, runtimeHostImageTag]);
  const predecessor = await findPredecessor(ports);
  if (!predecessor) throw new Error("runtime-host predecessor container is unavailable for successor staging");
  const name = runtimeHostSuccessorName(candidate.revision);
  try {
    await ports.docker(successorRunArgs(name, candidate, predecessor));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    /* A same-revision leftover from an interrupted staging is reused: the
       container name embeds the revision, so a conflict is always the same
       successor generation. */
    if (!/is already in use|Conflict/.test(message)) throw error;
    await ports.docker(["container", "start", name]);
  }
  const state = (await ports.docker(["container", "inspect", "--format", "{{.State.Status}}", name])).trim();
  if (state !== "running" && state !== "restarting") {
    throw new Error(`runtime-host successor container is ${state || "unavailable"}`);
  }
  ports.writeRelease({
    ...candidate,
    container: name,
    stagedAt: (ports.now ?? (() => new Date().toISOString()))(),
  });
  await ports.docker(["container", "update", "--restart", "no", predecessor.id]);
  return { successorContainer: name };
}
