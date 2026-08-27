import { expect, test } from "bun:test";

import type { HotStateAuthority } from "@/lib/state/hotStateAuthority";

import {
  awaitHotStateActivation,
  awaitIncumbentHotStateRelease,
  hotStateActivationObservation,
  hotStateActivationPhase,
  HOT_STATE_ACTIVATION_TIMEOUT_MS,
  incumbentHotStateReleasePhase,
  INCUMBENT_RELEASE_TIMEOUT_MS,
  PROMOTE_ACTION_TIMEOUT_MS,
} from "./deploymentHotState";
import type { ViewerCandidateContainerState } from "./deploymentHealth";

const revision = "9".repeat(40);
const PHASE_ALPHABET = /^[A-Za-z0-9 -]{1,160}$/;

function authority(overrides: Partial<HotStateAuthority> = {}): HotStateAuthority {
  return {
    schemaVersion: 1,
    epoch: 4,
    mode: "sqlite",
    releaseRevision: revision,
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

/** Time advances only when the wait sleeps, so every elapsed value in these
    assertions is the budget the wait actually spent. */
function clock() {
  let elapsedMs = 0;
  return {
    now: () => elapsedMs,
    sleep: async (delayMs: number) => { elapsedMs += delayMs; },
  };
}

/* The promote deadline used to equal the activation budget it contains, so the
   host killed the adapter before the adapter could report anything. */
test("the promote deadline outlives every hand-over budget it contains", () => {
  expect(PROMOTE_ACTION_TIMEOUT_MS).toBeGreaterThan(
    HOT_STATE_ACTIVATION_TIMEOUT_MS + INCUMBENT_RELEASE_TIMEOUT_MS,
  );
});

test("activation observations name the authority the promote can actually see", () => {
  expect(hotStateActivationObservation(null, revision)).toBe("no hot-state authority is published");
  expect(hotStateActivationObservation(authority({ mode: "preparing" }), revision))
    .toBe("authority mode preparing revision matches epoch 4 activation pending");
  expect(hotStateActivationObservation(authority({ releaseRevision: "1".repeat(40) }), revision))
    .toBe("authority mode sqlite revision differs epoch 4 activation pending");
  expect(hotStateActivationObservation(authority({ activationReadyAt: "2026-08-27T00:00:01.000Z" }), revision))
    .toBe("authority mode sqlite revision matches epoch 4 activation ready");
});

test("every reported phase survives the host phase-file alphabet", () => {
  const phases = [
    incumbentHotStateReleasePhase("running", 12_400, 60_000),
    incumbentHotStateReleasePhase("unknown", 0, 60_000),
    hotStateActivationPhase(hotStateActivationObservation(authority({ mode: "fencing" }), revision), 91_000, 180_000),
    hotStateActivationPhase("x".repeat(400), 1_000, 180_000),
  ];
  for (const phase of phases) expect(phase).toMatch(PHASE_ALPHABET);
  expect(phases[0]).toBe("releasing incumbent hot state - 12s of 60s - incumbent running");
  expect(phases[2]).toBe("waiting for hot-state activation - 91s of 180s - authority mode fencing revision matches epoch 4 activation pending");
});

test("activation that never arrives fails with a named reason", async () => {
  const phases: string[] = [];
  await expect(awaitHotStateActivation({
    revision,
    readAuthority: () => authority({ mode: "preparing" }),
    release: { outcome: "retained", state: "running", waitedMs: 60_000 },
    ...clock(),
    reportPhase: (phase) => { phases.push(phase); },
    timeoutMs: 200,
    pollMs: 100,
  })).rejects.toThrow(
    `promoted Viewer never published hot-state activation for revision ${revision}`
    + "; waited 0s of 0s"
    + "; last observed authority mode preparing revision matches epoch 4 activation pending"
    + "; candidate container state is unobservable"
    + "; incumbent still running after 60s",
  );
  expect(phases[0]).toBe("waiting for hot-state activation - 0s of 0s - authority mode preparing revision matches epoch 4 activation pending");
});

test("a candidate that died during its own activation is named separately", async () => {
  await expect(awaitHotStateActivation({
    revision,
    readAuthority: () => authority({ mode: "preparing" }),
    inspectCandidate: async () => "exited",
    ...clock(),
    timeoutMs: 200,
    pollMs: 100,
  })).rejects.toThrow("; candidate container is exited; incumbent release not required");
});

test("activation that arrives late but inside the budget succeeds", async () => {
  let reads = 0;
  const phases: string[] = [];
  await awaitHotStateActivation({
    revision,
    readAuthority: () => {
      reads += 1;
      return reads < 4 ? authority({ mode: "preparing" }) : authority({ activationReadyAt: "2026-08-27T00:00:09.000Z" });
    },
    ...clock(),
    reportPhase: (phase) => { phases.push(phase); },
    timeoutMs: 5_000,
    pollMs: 1_000,
  });

  expect(reads).toBe(4);
  expect(phases).toHaveLength(3);
});

test("the incumbent release step reports the hand-over it observed", async () => {
  const states: ViewerCandidateContainerState[] = ["running", "running", "exited"];
  const phases: string[] = [];
  const release = await awaitIncumbentHotStateRelease({
    inspect: async () => states.shift() ?? "missing",
    activated: () => false,
    ...clock(),
    reportPhase: (phase) => { phases.push(phase); },
    timeoutMs: 60_000,
    pollMs: 1_000,
  });

  expect(release).toEqual({ outcome: "released", state: "exited", waitedMs: 2_000 });
  expect(phases[0]).toBe("releasing incumbent hot state - 0s of 60s - incumbent running");
});

test("an incumbent that never lets go is reported rather than fatal", async () => {
  const release = await awaitIncumbentHotStateRelease({
    inspect: async () => "running",
    activated: () => false,
    ...clock(),
    timeoutMs: 60_000,
    pollMs: 1_000,
  });

  expect(release).toEqual({ outcome: "retained", state: "running", waitedMs: 60_000 });
});

test("an unobservable incumbent does not stall the promote", async () => {
  const release = await awaitIncumbentHotStateRelease({
    inspect: async () => { throw new Error("docker daemon is unreachable"); },
    activated: () => false,
    ...clock(),
    timeoutMs: 60_000,
    pollMs: 1_000,
  });

  expect(release).toEqual({ outcome: "unobservable", state: "unknown", waitedMs: 60_000 });
});

test("activation that already landed retires the incumbent release step immediately", async () => {
  let inspected = 0;
  const release = await awaitIncumbentHotStateRelease({
    inspect: async () => { inspected += 1; return "running"; },
    activated: () => true,
    ...clock(),
    timeoutMs: 60_000,
    pollMs: 1_000,
  });

  expect({ release, inspected }).toEqual({
    release: { outcome: "not required", state: "unknown", waitedMs: 0 },
    inspected: 0,
  });
});
