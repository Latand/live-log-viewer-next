import { expect, test } from "bun:test";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";
import { WAKATIME_CREDENTIAL_ENV } from "@/lib/wakatime/credential";

import {
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  type RuntimeHostHandoffIntent,
  type RuntimeHostReleaseRecord,
} from "./hostRelease";
import {
  completeRuntimeHostHandoff,
  RUNTIME_HOST_FENCE_WAIT_ENV,
  RUNTIME_HOST_SUCCESSOR_LABEL,
  runtimeHostSuccessorName,
  stageRuntimeHostSuccessorContainer,
  type RuntimeHostSuccessorPorts,
} from "./hostSuccessor";

const revision = "b".repeat(40);
const candidate: ViewerReleaseIdentity = {
  revision,
  image: `agent-log-viewer:deploy-${revision}-cafe`,
  container: `llv-deploy-${revision.slice(0, 8)}`,
  endpoint: "http://127.0.0.1:18001",
};

test("issue 521 review: separate deployments of the same revision receive distinct successor names", () => {
  const repeatCandidate = {
    ...candidate,
    image: `${candidate.image}-repeat`,
    container: `${candidate.container}-repeat`,
  };

  expect(runtimeHostSuccessorName(candidate.revision, candidate.image))
    .not.toBe(runtimeHostSuccessorName(repeatCandidate.revision, repeatCandidate.image));
});

test("issue 521 review: the fenced successor removes its durable predecessor and clears cleanup ownership", async () => {
  const successorContainer = runtimeHostSuccessorName(candidate.revision, candidate.image);
  const calls: string[][] = [];
  let intent: RuntimeHostHandoffIntent | null = {
    revision: candidate.revision,
    image: candidate.image,
    successorContainer,
    predecessorId: "predecessor-for-cleanup",
    recordedAt: "2026-07-21T09:00:00.000Z",
  };

  const completed = await completeRuntimeHostHandoff({
    image: candidate.image,
    revision: candidate.revision,
    container: successorContainer,
  }, {
    docker: async (argv) => {
      calls.push(argv);
      return argv[1] === "inspect" ? JSON.stringify([{ Id: "successor-id" }]) : "";
    },
    readHandoffIntent: () => intent,
    clearHandoffIntent: () => { intent = null; },
  });

  expect(completed).toBe(true);
  expect(calls).toEqual([
    ["container", "inspect", successorContainer],
    ["container", "rm", "-f", "predecessor-for-cleanup"],
  ]);
  expect(intent).toBeNull();
});

test("issue 521 review: successor cleanup converges when the predecessor is already absent", async () => {
  const successorContainer = runtimeHostSuccessorName(candidate.revision, candidate.image);
  let cleared = false;
  const completed = await completeRuntimeHostHandoff({
    image: candidate.image,
    revision: candidate.revision,
    container: successorContainer,
  }, {
    docker: async (argv) => {
      if (argv[1] === "inspect") return JSON.stringify([{ Id: "successor-id" }]);
      throw new Error("No such container: predecessor-already-gone");
    },
    readHandoffIntent: () => ({
      revision: candidate.revision,
      image: candidate.image,
      successorContainer,
      predecessorId: "predecessor-already-gone",
      recordedAt: "2026-07-21T09:00:00.000Z",
    }),
    clearHandoffIntent: () => { cleared = true; },
  });

  expect(completed).toBe(true);
  expect(cleared).toBe(true);
});

/* The unsupported credential as Docker would report it from the predecessor's
   environment. The value is a test placeholder, never a real credential. */
const wakatimePlaceholderValue = "waka-credential-value-placeholder";

const predecessorInspect = JSON.stringify([{
  State: { Pid: 3970 },
  Config: {
    Env: [
      "LLV_RUNTIME_EVENTS=1",
      "HOME=/home/user",
      `${WAKATIME_CREDENTIAL_ENV}=${wakatimePlaceholderValue}`,
    ],
    Cmd: ["bun-container", "run", "src/runtime-host/main.ts"],
    "User": "1000:1000",
    WorkingDir: "/app",
  },
  HostConfig: {
    Binds: ["/home/user:/home/user"],
    GroupAdd: ["957"],
    NetworkMode: "host",
    PidMode: "host",
    Privileged: true,
  },
}]);

interface Harness {
  ports: RuntimeHostSuccessorPorts;
  calls: string[][];
  events: string[];
  records: RuntimeHostReleaseRecord[];
  intents: RuntimeHostHandoffIntent[];
  storedIntent: () => RuntimeHostHandoffIntent | null;
}

function harness(overrides: {
  fenceOwnerPid?: number | null;
  handoffIntent?: RuntimeHostHandoffIntent;
  runFailure?: Error;
  runConflict?: boolean;
  readIntentFailure?: Error;
  successorState?: string;
  stableSuccessorState?: string;
  stableRestartCount?: number;
  stableStartedAt?: string;
  successorImage?: string;
  updateFailure?: Error;
} = {}): Harness {
  const calls: string[][] = [];
  const events: string[] = [];
  const records: RuntimeHostReleaseRecord[] = [];
  const intents: RuntimeHostHandoffIntent[] = [];
  let storedIntent: RuntimeHostHandoffIntent | null = overrides.handoffIntent ?? null;
  let successorInspection = 0;
  const successorName = runtimeHostSuccessorName(revision, candidate.image);
  function successorInspect(state: string, stable: boolean): string {
    return JSON.stringify([{
      Id: "5ucce5501d5ucce5501d",
      RestartCount: stable ? overrides.stableRestartCount ?? 0 : 0,
      State: {
        Status: state,
        Running: state === "running",
        Restarting: state === "restarting",
        StartedAt: stable
          ? overrides.stableStartedAt ?? "2026-07-21T08:59:58.000Z"
          : "2026-07-21T08:59:58.000Z",
      },
      Config: {
        Image: overrides.successorImage ?? candidate.image,
        Labels: {
          [RUNTIME_HOST_SUCCESSOR_LABEL]: "1",
          "dev.live-log-viewer.revision": candidate.revision,
        },
        Env: [
          `${RUNTIME_HOST_IMAGE_ENV}=${candidate.image}`,
          `${RUNTIME_HOST_REVISION_ENV}=${candidate.revision}`,
          `${RUNTIME_HOST_CONTAINER_ENV}=${successorName}`,
        ],
      },
    }]);
  }
  const ports: RuntimeHostSuccessorPorts = {
    docker: async (argv) => {
      calls.push([...argv]);
      events.push(`docker:${argv.join(" ")}`);
      if (argv[0] === "container" && argv[1] === "ls") return "abc123\n";
      if (argv[0] === "container" && argv[1] === "inspect" && argv[2] === "abc123") return predecessorInspect;
      if (argv[0] === "run") {
        if (overrides.runFailure) throw overrides.runFailure;
        if (overrides.runConflict) throw new Error(`docker: Error response from daemon: Conflict. The container name "/${argv[3]}" is already in use`);
        return "successor-id";
      }
      if (argv[0] === "container" && argv[1] === "inspect" && argv[2] === successorName) {
        successorInspection += 1;
        const stable = successorInspection > 1;
        const state = stable
          ? overrides.stableSuccessorState ?? overrides.successorState ?? "running"
          : overrides.successorState ?? "running";
        return successorInspect(state, stable);
      }
      if (argv[0] === "container" && argv[1] === "update" && overrides.updateFailure) {
        throw overrides.updateFailure;
      }
      return "";
    },
    writeRelease: (record) => {
      events.push("write-release");
      records.push(record);
    },
    readRelease: () => records[records.length - 1] ?? null,
    readHandoffIntent: () => {
      if (overrides.readIntentFailure) throw overrides.readIntentFailure;
      return storedIntent;
    },
    writeHandoffIntent: (intent) => {
      events.push("write-handoff-intent");
      intents.push(intent);
      storedIntent = intent;
    },
    clearHandoffIntent: () => {
      events.push("clear-handoff-intent");
      storedIntent = null;
    },
    fenceOwnerPid: () => overrides.fenceOwnerPid === undefined ? 3970 : overrides.fenceOwnerPid,
    now: () => "2026-07-21T09:00:00.000Z",
    wait: async () => undefined,
  };
  return { ports, calls, events, records, intents, storedIntent: () => storedIntent };
}

/* A stateful Docker world that survives across staging attempts, for
   deterministic crash injection: the initiating client process dies between
   daemon-side atomic calls, and a later retry must recover. */
const SUCCESSOR_PID = 4200;
const SUCCESSOR_ID = "5ucce5501d5ucce5501d";

interface CrashWorld {
  fenceOwnerPid: number | null;
  predecessorExists: boolean;
  predecessorRunning: boolean;
  predecessorRestart: string;
  successorExists: boolean;
  successorRestart: string | null;
  crashAfterRestartDisable: boolean;
  crashAfterPublish: boolean;
  releaseRecords: RuntimeHostReleaseRecord[];
  handoffIntent: RuntimeHostHandoffIntent | null;
}

function crashWorld(): CrashWorld {
  return {
    fenceOwnerPid: 3970,
    predecessorExists: true,
    predecessorRunning: true,
    predecessorRestart: "unless-stopped",
    successorExists: false,
    successorRestart: null,
    crashAfterRestartDisable: false,
    crashAfterPublish: false,
    releaseRecords: [],
    handoffIntent: null,
  };
}

function crashHarness(world: CrashWorld): { ports: RuntimeHostSuccessorPorts; calls: string[][] } {
  const calls: string[][] = [];
  const successorName = runtimeHostSuccessorName(revision, candidate.image);
  function successorJson(): string {
    return JSON.stringify([{
      Id: SUCCESSOR_ID,
      RestartCount: 0,
      State: {
        Status: "running",
        Running: true,
        Restarting: false,
        StartedAt: "2026-07-21T08:59:58.000Z",
        Pid: SUCCESSOR_PID,
      },
      Config: {
        Image: candidate.image,
        Cmd: ["bun-container", "run", "src/runtime-host/main.ts"],
        Env: [
          `${RUNTIME_HOST_IMAGE_ENV}=${candidate.image}`,
          `${RUNTIME_HOST_REVISION_ENV}=${candidate.revision}`,
          `${RUNTIME_HOST_CONTAINER_ENV}=${successorName}`,
        ],
        Labels: {
          [RUNTIME_HOST_SUCCESSOR_LABEL]: "1",
          "dev.live-log-viewer.revision": candidate.revision,
        },
      },
      HostConfig: { Binds: [], GroupAdd: [], NetworkMode: "host", PidMode: "host", Privileged: false },
    }]);
  }
  const ports: RuntimeHostSuccessorPorts = {
    docker: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "container" && argv[1] === "ls") {
        const listed = [
          ...(world.predecessorExists && world.predecessorRunning ? ["abc123"] : []),
          ...(world.successorExists ? [SUCCESSOR_ID] : []),
        ];
        return `${listed.join("\n")}\n`;
      }
      if (argv[0] === "container" && argv[1] === "inspect" && argv[2] === "abc123") {
        if (!world.predecessorExists) throw new Error("Error: No such container: abc123");
        return predecessorInspect;
      }
      if (argv[0] === "container" && argv[1] === "inspect" && (argv[2] === SUCCESSOR_ID || argv[2] === successorName)) {
        if (!world.successorExists) throw new Error(`Error: No such container: ${argv[2]}`);
        return successorJson();
      }
      if (argv[0] === "run") {
        if (world.successorExists) throw new Error(`docker: Error response from daemon: Conflict. The container name "/${successorName}" is already in use`);
        world.successorExists = true;
        world.successorRestart = "unless-stopped";
        return SUCCESSOR_ID;
      }
      if (argv[0] === "container" && argv[1] === "start") {
        if (!world.successorExists) throw new Error(`Error: No such container: ${argv[2]}`);
        return "";
      }
      if (argv[0] === "container" && argv[1] === "update") {
        const target = argv[argv.length - 1];
        if (target === "abc123") {
          if (!world.predecessorExists) throw new Error("Error: No such container: abc123");
          world.predecessorRestart = "no";
        } else if (target === SUCCESSOR_ID || target === successorName) {
          world.successorRestart = "no";
        }
        if (world.crashAfterRestartDisable) {
          world.crashAfterRestartDisable = false;
          throw new Error("simulated staging crash");
        }
        return "";
      }
      if (argv[0] === "container" && argv[1] === "rm") {
        if (!world.predecessorExists) throw new Error("Error: No such container: abc123");
        world.predecessorExists = false;
        world.predecessorRunning = false;
        return "";
      }
      return "";
    },
    writeRelease: (record) => {
      world.releaseRecords.push(record);
      if (world.crashAfterPublish) {
        world.crashAfterPublish = false;
        throw new Error("simulated staging crash");
      }
    },
    readRelease: () => world.releaseRecords[world.releaseRecords.length - 1] ?? null,
    readHandoffIntent: () => world.handoffIntent,
    writeHandoffIntent: (intent) => { world.handoffIntent = intent; },
    clearHandoffIntent: () => { world.handoffIntent = null; },
    fenceOwnerPid: () => world.fenceOwnerPid,
    now: () => "2026-07-21T09:00:00.000Z",
    wait: async () => undefined,
  };
  return { ports, calls };
}

/* Production #518: the runtime-host ran a stale baked image for hours after
   the fixed revision was deployed. The staging below is the corrected
   handoff: every mutating step is a short-lived CLI call against dockerd, so
   the successor exists daemon-side before the predecessor generation exits. */
test("issue 518: staging creates a dockerd-owned successor from the candidate image without stopping the predecessor", async () => {
  const { ports, calls, events, records, storedIntent } = harness();

  const staged = await stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports);

  expect(staged.successorContainer).toBe(runtimeHostSuccessorName(revision, candidate.image));
  /* The successor container boots exactly the deployed candidate image with
     the predecessor's topology, owned by dockerd with a restart policy — it
     survives the death of every initiating client process, including the
     predecessor stop that follows. */
  const run = calls.find((argv) => argv[0] === "run");
  expect(run).toBeDefined();
  expect(run).toContain(candidate.image);
  expect(run?.join(" ")).toContain("--restart unless-stopped");
  expect(run?.join(" ")).toContain(`-e ${RUNTIME_HOST_FENCE_WAIT_ENV}=`);
  expect(run?.join(" ")).toContain("-v /home/user:/home/user");
  expect(run?.slice(-3)).toEqual(["bun-container", "run", "src/runtime-host/main.ts"]);
  /* The durable record binds the successor to the deployed revision only
     after the successor is observably running. */
  expect(records).toEqual([{
    ...candidate,
    container: runtimeHostSuccessorName(revision, candidate.image),
    stagedAt: "2026-07-21T09:00:00.000Z",
  }]);
  /* The predecessor is never stopped, killed, or removed by staging: its own
     graceful exit is the handoff. Only its restart policy is disabled — after
     the successor exists — so the stale image cannot restart. */
  expect(calls.some((argv) => ["stop", "kill", "rm"].includes(argv[0]) || ["stop", "kill", "rm"].includes(argv[1] ?? ""))).toBe(false);
  const runIndex = calls.findIndex((argv) => argv[0] === "run");
  const restartOffIndex = calls.findIndex((argv) => argv[0] === "container" && argv[1] === "update");
  expect(calls[restartOffIndex]).toEqual(["container", "update", "--restart", "no", "abc123"]);
  expect(restartOffIndex).toBeGreaterThan(runIndex);
  expect(events.indexOf("write-release")).toBeGreaterThan(events.indexOf("docker:container update --restart no abc123"));
  expect(storedIntent()).toMatchObject({ predecessorId: "abc123", successorContainer: staged.successorContainer });
  /* The image tag is repointed before anything else durable, so any future
     compose (re)creation of the service also boots the deployed revision. */
  expect(calls.find((argv) => argv[0] === "tag")).toEqual(["tag", candidate.image, "agent-log-viewer:node22"]);
});

test("issue 518: a failed successor start throws before anything durable, leaving the predecessor serving and staging retryable", async () => {
  const { ports, calls, records } = harness({ runFailure: new Error("no space left on device") });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("no space left on device");

  expect(records).toEqual([]);
  expect(calls.some((argv) => argv[0] === "container" && argv[1] === "update")).toBe(false);
  expect(calls.some((argv) => ["stop", "kill", "rm"].includes(argv[0]) || ["stop", "kill", "rm"].includes(argv[1] ?? ""))).toBe(false);
});

test("issue 518: an interrupted prior staging of the same revision is reused idempotently", async () => {
  const { ports, calls, records } = harness({ runConflict: true });

  const staged = await stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports);

  expect(staged.successorContainer).toBe(runtimeHostSuccessorName(revision, candidate.image));
  expect(calls).toContainEqual(["container", "start", runtimeHostSuccessorName(revision, candidate.image)]);
  expect(records).toHaveLength(1);
});

test("issue 521 review: A to B to A stages each deployment generation and never restarts the first A", async () => {
  const candidates = [
    candidate,
    {
      ...candidate,
      revision: "c".repeat(40),
      image: `agent-log-viewer:deploy-${"c".repeat(40)}-beef`,
      container: "llv-deploy-b-generation",
    },
    {
      ...candidate,
      image: `agent-log-viewer:deploy-${revision}-f00d`,
      container: "llv-deploy-a-repeat",
    },
  ];
  type Container = {
    id: string;
    name: string;
    image: string;
    revision: string;
    env: string[];
    pid: number;
    running: boolean;
    restart: string;
  };
  const containers: Container[] = [{
    id: "predecessor-zero",
    name: "llv-runtime-host-initial",
    image: "agent-log-viewer:node22",
    revision: "0".repeat(40),
    env: ["LLV_RUNTIME_EVENTS=1"],
    pid: 3970,
    running: true,
    restart: "unless-stopped",
  }];
  const starts: string[] = [];
  const releases: RuntimeHostReleaseRecord[] = [];
  let intent: RuntimeHostHandoffIntent | null = null;
  let active = containers[0]!;
  let nextContainerId = 1;

  function inspect(container: Container): string {
    return JSON.stringify([{
      Id: container.id,
      RestartCount: 0,
      State: {
        Status: container.running ? "running" : "exited",
        Running: container.running,
        Restarting: false,
        StartedAt: `2026-07-21T09:00:0${containers.indexOf(container)}.000Z`,
        Pid: container.running ? container.pid : 0,
      },
      Config: {
        Image: container.image,
        Cmd: ["bun-container", "run", "src/runtime-host/main.ts"],
        Env: container.env,
        Labels: {
          [RUNTIME_HOST_SUCCESSOR_LABEL]: "1",
          "dev.live-log-viewer.revision": container.revision,
        },
        "User": "1000:1000",
        WorkingDir: "/app",
      },
      HostConfig: { Binds: [], GroupAdd: [], NetworkMode: "host", PidMode: "host", Privileged: true },
    }]);
  }

  const ports: RuntimeHostSuccessorPorts = {
    docker: async (argv) => {
      if (argv[0] === "image" || argv[0] === "tag") return "";
      if (argv[0] === "container" && argv[1] === "ls") {
        return `${containers.filter((item) => item.running).map((item) => item.id).join("\n")}\n`;
      }
      if (argv[0] === "container" && argv[1] === "inspect") {
        const found = containers.find((item) => item.id === argv[2] || item.name === argv[2]);
        if (!found) throw new Error(`No such container: ${argv[2]}`);
        return inspect(found);
      }
      if (argv[0] === "run") {
        const name = argv[3]!;
        if (containers.some((item) => item.name === name)) throw new Error(`Conflict. The container name "/${name}" is already in use`);
        const imageEntry = argv.findLast((item) => item.startsWith(`${RUNTIME_HOST_IMAGE_ENV}=`));
        const revisionEntry = argv.findLast((item) => item.startsWith(`${RUNTIME_HOST_REVISION_ENV}=`));
        const env = argv.flatMap((item, index) => argv[index - 1] === "-e" ? [item] : []);
        const created: Container = {
          id: `successor-${nextContainerId}`,
          name,
          image: imageEntry!.slice(RUNTIME_HOST_IMAGE_ENV.length + 1),
          revision: revisionEntry!.slice(RUNTIME_HOST_REVISION_ENV.length + 1),
          env,
          pid: 4200 + containers.length,
          running: true,
          restart: "unless-stopped",
        };
        nextContainerId += 1;
        containers.push(created);
        return created.id;
      }
      if (argv[0] === "container" && argv[1] === "start") {
        starts.push(argv[2]!);
        const found = containers.find((item) => item.id === argv[2] || item.name === argv[2]);
        if (!found) throw new Error(`No such container: ${argv[2]}`);
        found.running = true;
        return "";
      }
      if (argv[0] === "container" && argv[1] === "update") {
        const found = containers.find((item) => item.id === argv.at(-1) || item.name === argv.at(-1));
        if (!found) throw new Error(`No such container: ${argv.at(-1)}`);
        found.restart = "no";
        return "";
      }
      if (argv[0] === "container" && argv[1] === "rm") {
        const target = argv.at(-1);
        const index = containers.findIndex((item) => item.id === target || item.name === target);
        if (index < 0) throw new Error(`No such container: ${target}`);
        containers.splice(index, 1);
        return "";
      }
      return "";
    },
    writeRelease: (record) => { releases.push(record); },
    readRelease: () => releases.at(-1) ?? null,
    readHandoffIntent: () => intent,
    writeHandoffIntent: (next) => { intent = next; },
    clearHandoffIntent: () => { intent = null; },
    fenceOwnerPid: () => active.pid,
    now: () => "2026-07-21T09:00:00.000Z",
    wait: async () => undefined,
  };

  for (const next of candidates) {
    const staged = await stageRuntimeHostSuccessorContainer(next, "agent-log-viewer:node22", ports);
    active.running = false;
    active = containers.find((item) => item.name === staged.successorContainer)!;
    await completeRuntimeHostHandoff({ image: next.image, revision: next.revision, container: staged.successorContainer }, ports);
  }

  const successorNames = candidates.map((item) => runtimeHostSuccessorName(item.revision, item.image));
  expect(successorNames[0]).not.toBe(successorNames[2]);
  expect(releases.map((item) => item.container)).toEqual(successorNames);
  expect(starts).toEqual([]);
  expect(active).toMatchObject({ name: successorNames[2], running: true, restart: "unless-stopped" });
  for (const key of [RUNTIME_HOST_FENCE_WAIT_ENV, RUNTIME_HOST_IMAGE_ENV, RUNTIME_HOST_REVISION_ENV, RUNTIME_HOST_CONTAINER_ENV]) {
    expect(active.env.filter((entry) => entry.startsWith(`${key}=`))).toHaveLength(1);
  }
  expect(containers).toHaveLength(1);
  expect(intent).toBeNull();
});

test("issue 518: a successor that is not running never becomes the durable release", async () => {
  const { ports, records } = harness({ successorState: "exited" });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("runtime-host successor container failed its identity or running-state gate");

  expect(records).toEqual([]);
});

test("issue 518: a restarting successor never disables or publishes the predecessor", async () => {
  const { ports, calls, records } = harness({ successorState: "restarting" });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("runtime-host successor container failed its identity or running-state gate");

  expect(records).toEqual([]);
  expect(calls.some((argv) => argv[0] === "container" && argv[1] === "update")).toBe(false);
});

test("issue 518: a successor that restarts between readiness probes never becomes durable", async () => {
  const { ports, calls, records } = harness({ stableSuccessorState: "restarting" });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("runtime-host successor container did not remain stably ready");

  expect(records).toEqual([]);
  expect(calls.some((argv) => argv[0] === "container" && argv[1] === "update")).toBe(false);
});

test("issue 518: a same-name container with the wrong image never becomes durable", async () => {
  const { ports, calls, records } = harness({ runConflict: true, successorImage: "agent-log-viewer:stale" });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("runtime-host successor container failed its identity or running-state gate");

  expect(records).toEqual([]);
  expect(calls.some((argv) => argv[0] === "container" && argv[1] === "start")).toBe(false);
  expect(calls.some((argv) => argv[0] === "container" && argv[1] === "update")).toBe(false);
});

test("issue 518: predecessor restart-policy failure leaves the release unpublished and retryable", async () => {
  const { ports, records } = harness({ updateFailure: new Error("restart policy update failed") });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("restart policy update failed");

  expect(records).toEqual([]);
});

test("issue 518: staging without an identifiable predecessor fails observably", async () => {
  const { ports, records } = harness({ fenceOwnerPid: null });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("runtime-host predecessor container is unavailable");

  expect(records).toEqual([]);
});

test("issue 521 review: unreadable durable intent blocks predecessor rediscovery and publication", async () => {
  const { ports, calls, records } = harness({ readIntentFailure: new Error("runtime-host handoff intent is unreadable") });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("runtime-host handoff intent is unreadable");

  expect(records).toEqual([]);
  expect(calls.some((argv) => argv[0] === "container")).toBe(false);
  expect(calls.some((argv) => argv[0] === "run")).toBe(false);
});

test("issue 521 review: a foreign durable intent blocks staging before Docker mutation", async () => {
  const existingIntent: RuntimeHostHandoffIntent = {
    revision: "foreign-revision",
    image: "agent-log-viewer:foreign-generation",
    successorContainer: "llv-runtime-host-foreign-generation",
    predecessorId: "foreign-predecessor",
    recordedAt: "2026-07-21T08:00:00.000Z",
  };
  const originalBytes = JSON.stringify(existingIntent);
  const { ports, calls, events, records, intents, storedIntent } = harness({ handoffIntent: existingIntent });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("runtime-host handoff intent is owned by another generation");

  expect(calls).toEqual([]);
  expect(events).toEqual([]);
  expect(records).toEqual([]);
  expect(intents).toEqual([]);
  expect(JSON.stringify(storedIntent())).toBe(originalBytes);
});

/* PR #521 review, finding 1: a crash after the predecessor's restart policy
   was disabled but before the release record became durable used to leave the
   retry with only the fence owner to identify the predecessor. Once the
   predecessor exits and the successor takes the fence, that retry selected
   the successor itself as "predecessor", disabled its restart policy, and
   published a second release bound to it — recovery would then exit the
   successor. The durable handoff intent pins both identities across the
   crash boundary. */
test("issue 521: recovery after a crash between restart-disable and publication never selects or disables the successor", async () => {
  const world = crashWorld();
  world.crashAfterRestartDisable = true;
  const first = crashHarness(world);
  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", first.ports))
    .rejects.toThrow("simulated staging crash");
  expect(world.releaseRecords).toEqual([]);
  expect(world.predecessorRestart).toBe("no");

  /* The predecessor exits gracefully; the staged successor acquires the
     singleton fence and becomes the fence owner before the retry runs. */
  world.predecessorRunning = false;
  world.fenceOwnerPid = SUCCESSOR_PID;

  const retry = crashHarness(world);
  const staged = await stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", retry.ports);

  expect(staged.successorContainer).toBe(runtimeHostSuccessorName(revision, candidate.image));
  /* Recovery never rediscovers a predecessor through the fence owner — the
     fence now belongs to the successor itself. */
  expect(retry.calls.some((argv) => argv[0] === "container" && argv[1] === "ls")).toBe(false);
  /* The successor stays restartable: no restart-policy mutation ever targets
     it, across both the crashed attempt and the recovery. */
  expect(world.successorRestart).toBe("unless-stopped");
  const updates = [...first.calls, ...retry.calls].filter((argv) => argv[0] === "container" && argv[1] === "update");
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.every((argv) => argv[argv.length - 1] === "abc123")).toBe(true);
  /* Publication happens exactly once and binds the successor identity. */
  expect(world.releaseRecords).toEqual([{
    ...candidate,
    container: runtimeHostSuccessorName(revision, candidate.image),
    stagedAt: "2026-07-21T09:00:00.000Z",
  }]);
  await completeRuntimeHostHandoff({ image: candidate.image, revision, container: staged.successorContainer }, retry.ports);
  expect(world.handoffIntent).toBeNull();
});

test("issue 521: a crash between publication and intent clearing never publishes a second release", async () => {
  const world = crashWorld();
  world.crashAfterPublish = true;
  const first = crashHarness(world);
  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", first.ports))
    .rejects.toThrow("simulated staging crash");
  expect(world.releaseRecords).toHaveLength(1);

  const retry = crashHarness(world);
  const staged = await stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", retry.ports);

  expect(staged.successorContainer).toBe(runtimeHostSuccessorName(revision, candidate.image));
  expect(world.releaseRecords).toHaveLength(1);
  world.predecessorRunning = false;
  world.fenceOwnerPid = SUCCESSOR_PID;
  await completeRuntimeHostHandoff({ image: candidate.image, revision, container: staged.successorContainer }, retry.ports);
  expect(world.handoffIntent).toBeNull();
  expect(world.successorRestart).toBe("unless-stopped");
});

test("issue 521: recovery completes when the crashed predecessor container is already gone", async () => {
  const world = crashWorld();
  world.crashAfterRestartDisable = true;
  const first = crashHarness(world);
  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", first.ports))
    .rejects.toThrow("simulated staging crash");

  world.predecessorRunning = false;
  world.predecessorExists = false;
  world.fenceOwnerPid = SUCCESSOR_PID;

  const retry = crashHarness(world);
  const staged = await stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", retry.ports);

  expect(staged.successorContainer).toBe(runtimeHostSuccessorName(revision, candidate.image));
  expect(world.releaseRecords).toHaveLength(1);
  expect(world.successorRestart).toBe("unless-stopped");
  await completeRuntimeHostHandoff({ image: candidate.image, revision, container: staged.successorContainer }, retry.ports);
  expect(world.handoffIntent).toBeNull();
});

/* PR #521 review, finding 3: both readiness inspections can report "running"
   while dockerd restarts a crash-looping successor in between. The probes
   must reject any restart-count or start-identity change. */
test("issue 521: a successor crash-looping across two running inspections never becomes durable", async () => {
  const { ports, calls, records, intents } = harness({
    stableRestartCount: 1,
    stableStartedAt: "2026-07-21T08:59:59.750Z",
  });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("restarted between readiness probes");

  expect(records).toEqual([]);
  expect(intents).toEqual([]);
  expect(calls.some((argv) => argv[0] === "container" && argv[1] === "update")).toBe(false);
});

test("issue 521: a start-identity change alone between running inspections never becomes durable", async () => {
  const { ports, calls, records, intents } = harness({ stableStartedAt: "2026-07-21T08:59:59.750Z" });

  await expect(stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports))
    .rejects.toThrow("restarted between readiness probes");

  expect(records).toEqual([]);
  expect(intents).toEqual([]);
  expect(calls.some((argv) => argv[0] === "container" && argv[1] === "update")).toBe(false);
});

/* PR #521 review, finding 2: the Docker-inspected predecessor environment was
   cloned verbatim into the successor's `docker run` arguments, so the
   unsupported credential's name and value leaked into the successor's
   metadata. Neither may ever reach a Docker call or a durable record. */
test("issue 521: the predecessor's unsupported credential never reaches Docker calls or successor metadata", async () => {
  const { ports, calls, records, intents } = harness();

  await stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports);

  const dockerArguments = calls.flat();
  expect(dockerArguments.some((argument) => argument.includes(WAKATIME_CREDENTIAL_ENV))).toBe(false);
  expect(dockerArguments.some((argument) => argument.includes(wakatimePlaceholderValue))).toBe(false);
  expect(JSON.stringify(records)).not.toContain(WAKATIME_CREDENTIAL_ENV);
  expect(JSON.stringify(records)).not.toContain(wakatimePlaceholderValue);
  expect(JSON.stringify(intents)).not.toContain(WAKATIME_CREDENTIAL_ENV);
  expect(JSON.stringify(intents)).not.toContain(wakatimePlaceholderValue);
  /* Supported predecessor environment entries still clone. */
  expect(calls.find((argv) => argv[0] === "run")?.join(" ")).toContain("-e LLV_RUNTIME_EVENTS=1");
});
