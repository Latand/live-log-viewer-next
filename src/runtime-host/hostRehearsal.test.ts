import { expect, test } from "bun:test";

import {
  parseRuntimeHostRehearsalReport,
  rehearseRuntimeHost,
  runtimeHostRehearsalDockerArgs,
  RUNTIME_HOST_REHEARSAL_REPORT_PREFIX,
  type RuntimeHostRehearsalGeneration,
  type RuntimeHostRehearsalPorts,
} from "./hostRehearsal";

interface Script {
  /** Answers for the stable listener, consumed in order; the last repeats. */
  listener: boolean[];
  /** Answers for the runtime socket, consumed the same way. */
  socket?: boolean[];
  /** Which poll the successor process dies on, counted from one. */
  diesAtPoll?: number;
}

interface Recorded {
  started: string[];
  stopped: string[];
  seeded: number;
  abandonedListener: number;
  abandonedSocket: number;
}

function harness(script: Script): { ports: RuntimeHostRehearsalPorts; recorded: Recorded } {
  const recorded: Recorded = { started: [], stopped: [], seeded: 0, abandonedListener: 0, abandonedSocket: 0 };
  let clock = 0;
  let listenerPolls = 0;
  let socketPolls = 0;
  let successorExited = false;
  const answer = (answers: boolean[], index: number): boolean => answers[Math.min(index, answers.length - 1)] ?? true;
  const generation = (role: string): RuntimeHostRehearsalGeneration => ({
    stop: async () => { recorded.stopped.push(role); },
    exited: () => role === "successor" && successorExited,
    log: () => [`${role}: line one`],
  });
  return {
    recorded,
    ports: {
      start: async (role) => { recorded.started.push(role); return generation(role); },
      seed: async () => { recorded.seeded += 1; },
      probeListener: async ({ abandon }) => {
        if (abandon) recorded.abandonedListener += 1;
        return answer(script.listener, listenerPolls++);
      },
      probeSocket: async ({ abandon }) => {
        if (abandon) recorded.abandonedSocket += 1;
        socketPolls += 1;
        if (script.diesAtPoll !== undefined && socketPolls >= script.diesAtPoll) successorExited = true;
        return answer(script.socket ?? [true], socketPolls - 1);
      },
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    },
  };
}

const options = { runtime: "bun 1.4.0", holdWindowMs: 2_000, holdPollMs: 500 };

test("a runtime that boots, succeeds the fence and holds both endpoints passes", async () => {
  const { ports, recorded } = harness({ listener: [true] });

  const report = await rehearseRuntimeHost(ports, options);

  expect(report.ok).toBe(true);
  expect(report.runtime).toBe("bun 1.4.0");
  expect(report.succession.completed).toBe(true);
  expect(report.listener.polls).toBeGreaterThan(0);
  expect(report.listener.answered).toBe(report.listener.polls);
  expect(report.socket.answered).toBe(report.socket.polls);
  // Both generations ran, in order, and the journal was filled before the
  // succession so the socket answers are large ones.
  expect(recorded.started).toEqual(["predecessor", "successor"]);
  expect(recorded.seeded).toBe(1);
  // Half the callers left mid-answer on each endpoint.
  expect(report.listener.abandoned).toBeGreaterThan(0);
  expect(report.socket.abandoned).toBe(report.listener.abandoned);
});

test("a host that never holds the listener fails before a successor is started", async () => {
  const { ports, recorded } = harness({ listener: [false] });

  const report = await rehearseRuntimeHost(ports, { ...options, readyBudgetMs: 1_000 });

  expect(report.ok).toBe(false);
  expect(report.detail).toContain("did not hold the stable listener");
  expect(report.detail).toContain("bun 1.4.0");
  expect(report.succession.completed).toBe(false);
  expect(recorded.started).toEqual(["predecessor"]);
  expect(report.log).toEqual(["predecessor: line one"]);
});

test("a successor that never takes the fence fails the rehearsal", async () => {
  // The predecessor answers once, then nothing answers after it is stopped.
  const { ports } = harness({ listener: [true, false] });

  const report = await rehearseRuntimeHost(ports, { ...options, successionBudgetMs: 1_000 });

  expect(report.ok).toBe(false);
  expect(report.detail).toContain("never took the singleton fence");
  expect(report.succession.completed).toBe(false);
  expect(report.log).toEqual(["successor: line one"]);
});

test("a listener that stops answering inside the hold window fails the rehearsal", async () => {
  const { ports } = harness({ listener: [true, true, true, false] });

  const report = await rehearseRuntimeHost(ports, options);

  expect(report.ok).toBe(false);
  expect(report.detail).toContain("stable listener stopped answering");
  // The succession itself completed; what failed is holding what it handed over.
  expect(report.succession.completed).toBe(true);
});

test("a runtime socket that stops answering inside the hold window fails the rehearsal", async () => {
  const { ports } = harness({ listener: [true], socket: [true, false] });

  const report = await rehearseRuntimeHost(ports, options);

  expect(report.ok).toBe(false);
  expect(report.detail).toContain("runtime socket stopped answering");
  expect(report.succession.completed).toBe(true);
});

test("a host that exits mid-hold fails even while its endpoints still answer", async () => {
  const { ports } = harness({ listener: [true], diesAtPoll: 2 });

  const report = await rehearseRuntimeHost(ports, options);

  expect(report.ok).toBe(false);
  expect(report.detail).toContain("exited during the");
});

test("every generation is stopped even when the rehearsal fails", async () => {
  const { ports, recorded } = harness({ listener: [true, true, true, false] });

  await rehearseRuntimeHost(ports, options);

  expect(recorded.stopped).toContain("predecessor");
  expect(recorded.stopped).toContain("successor");
});

test("the image rehearsal runs in a throwaway container that cannot reach live state", () => {
  const args = runtimeHostRehearsalDockerArgs("agent-log-viewer:candidate-abc");

  expect(args.slice(0, 4)).toEqual(["docker", "run", "--rm", "--network"]);
  expect(args).toContain("none");
  expect(args.slice(-3)).toEqual(["agent-log-viewer:candidate-abc", "run", "src/runtime-host/hostRehearsalRun.ts"]);
  // No bind mount can carry the operator's state directory into the rehearsal.
  expect(args).not.toContain("-v");
  expect(args).not.toContain("--volume");
});

test("the rehearsal report is read back out of a stream of host output", () => {
  const output = [
    "[runtime host] some unrelated line",
    `${RUNTIME_HOST_REHEARSAL_REPORT_PREFIX}${JSON.stringify({
      checkedAt: "2026-08-28T00:00:00.000Z",
      runtime: "bun 1.4.0",
      succession: { predecessorReadyMs: 1, successorTookOverMs: 2, completed: true },
      listener: { windowMs: 15_000, polls: 30, answered: 30, abandoned: 15 },
      socket: { polls: 30, answered: 30, abandoned: 15 },
      ok: true,
    })}`,
    "",
  ].join("\n");

  expect(parseRuntimeHostRehearsalReport(output).ok).toBe(true);
  expect(parseRuntimeHostRehearsalReport(output).runtime).toBe("bun 1.4.0");
  expect(() => parseRuntimeHostRehearsalReport("nothing here")).toThrow("produced no report");
});
