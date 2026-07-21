import { expect, test } from "bun:test";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import {
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  type RuntimeHostReleaseRecord,
} from "./hostRelease";
import {
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

const predecessorInspect = JSON.stringify([{
  State: { Pid: 3970 },
  Config: {
    Env: ["LLV_RUNTIME_EVENTS=1", "HOME=/home/user"],
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
}

function harness(overrides: {
  fenceOwnerPid?: number | null;
  runFailure?: Error;
  runConflict?: boolean;
  successorState?: string;
  stableSuccessorState?: string;
  successorImage?: string;
  updateFailure?: Error;
} = {}): Harness {
  const calls: string[][] = [];
  const events: string[] = [];
  const records: RuntimeHostReleaseRecord[] = [];
  let successorInspection = 0;
  const successorName = runtimeHostSuccessorName(revision);
  function successorInspect(state: string): string {
    return JSON.stringify([{
      State: {
        Status: state,
        Running: state === "running",
        Restarting: state === "restarting",
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
        const state = successorInspection === 1
          ? overrides.successorState ?? "running"
          : overrides.stableSuccessorState ?? overrides.successorState ?? "running";
        return successorInspect(state);
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
    fenceOwnerPid: () => overrides.fenceOwnerPid === undefined ? 3970 : overrides.fenceOwnerPid,
    now: () => "2026-07-21T09:00:00.000Z",
    wait: async () => undefined,
  };
  return { ports, calls, events, records };
}

/* Production #518: the runtime-host ran a stale baked image for hours after
   the fixed revision was deployed. The staging below is the corrected
   handoff: every mutating step is a short-lived CLI call against dockerd, so
   the successor exists daemon-side before the predecessor generation exits. */
test("issue 518: staging creates a dockerd-owned successor from the candidate image without stopping the predecessor", async () => {
  const { ports, calls, events, records } = harness();

  const staged = await stageRuntimeHostSuccessorContainer(candidate, "agent-log-viewer:node22", ports);

  expect(staged.successorContainer).toBe(runtimeHostSuccessorName(revision));
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
    container: runtimeHostSuccessorName(revision),
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

  expect(staged.successorContainer).toBe(runtimeHostSuccessorName(revision));
  expect(calls).toContainEqual(["container", "start", runtimeHostSuccessorName(revision)]);
  expect(records).toHaveLength(1);
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
