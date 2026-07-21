import { describe, expect, test } from "bun:test";

import {
  FOLDED_ACTIVE_PIPELINE_SENTINEL,
  MOBILE_READINESS_DEFAULTS,
  NEGATIVE_CONTROL_BLIND,
  SCAN_READINESS_DEFAULTS,
  isFoldedActivePipelineError,
  runFoldedNegativeControl,
  waitForMaterializedVerifyStage,
  waitForMobilePipelineReady,
  type MobileReadinessDriver,
  type ScanReadinessDriver,
} from "./capture-issue-507-gate";

describe("#507 F1 folded-pipeline negative control", () => {
  test("fires when the gate throws the exact fold sentinel", async () => {
    await expect(
      runFoldedNegativeControl(async () => {
        throw new Error(FOLDED_ACTIVE_PIPELINE_SENTINEL);
      }),
    ).resolves.toBeUndefined();
  });

  test("fails loudly when the deliberate fold does NOT trip the gate", async () => {
    await expect(runFoldedNegativeControl(async () => {})).rejects.toThrow(NEGATIVE_CONTROL_BLIND);
  });

  test("rethrows a forced evaluation failure instead of swallowing it as a pass", async () => {
    /* The regression the repair targets: previously `catch {}` treated ANY throw
       as "the gate tripped", so a crashed page (a destroyed execution context)
       silently counted as acceptance. The control must now propagate it. */
    const evalFailure = new Error("Execution context was destroyed, most likely because of a navigation");
    await expect(
      runFoldedNegativeControl(async () => {
        throw evalFailure;
      }),
    ).rejects.toBe(evalFailure);
  });

  test("rethrows a near-miss fold message — matching is exact, not substring", async () => {
    const nearMiss = new Error(`${FOLDED_ACTIVE_PIPELINE_SENTINEL} — and then some drift`);
    await expect(
      runFoldedNegativeControl(async () => {
        throw nearMiss;
      }),
    ).rejects.toBe(nearMiss);
    expect(isFoldedActivePipelineError(nearMiss)).toBe(false);
    expect(isFoldedActivePipelineError(new Error(FOLDED_ACTIVE_PIPELINE_SENTINEL))).toBe(true);
    expect(isFoldedActivePipelineError("not even an error")).toBe(false);
  });
});

describe("#507 F2 deterministic mobile readiness wait", () => {
  /** A virtual-clock driver: the summary reports the expected count only once the
      clock passes `summaryAt`, and layout stops churning at `layoutStableFrom`.
      `sleep` advances the clock instantly, so the whole wait runs synchronously. */
  function fakeDriver(script: { summaryAt: number; layoutStableFrom: number; expectedCount: number }) {
    let clock = 0;
    const summaryObservations: Array<{ t: number; count: number | null }> = [];
    const driver: MobileReadinessDriver = {
      async summaryPipelineCount() {
        const count = clock >= script.summaryAt ? script.expectedCount : null;
        summaryObservations.push({ t: clock, count });
        return count;
      },
      async layoutMetrics() {
        /* Height keeps changing (a reflow) until layoutStableFrom, then holds. */
        const churn = Math.min(clock, script.layoutStableFrom);
        return { scrollWidth: 390, scrollHeight: 800 + churn };
      },
      now: () => clock,
      async sleep(ms: number) {
        clock += ms;
      },
    };
    return { driver, summaryObservations, clock: () => clock };
  }

  test("waits past three seconds for a late summary that a fixed 3s delay would have missed", async () => {
    /* The seeded summary only renders at 3.5s — beyond the retired fixed delay. */
    const fake = fakeDriver({ summaryAt: 3500, layoutStableFrom: 3600, expectedCount: 2 });
    const result = await waitForMobilePipelineReady(fake.driver, { expectedPipelines: 2 });

    expect(result.waitedMs).toBeGreaterThan(3000);
    /* Proof the old fixed 3s delay would have photographed empty UI: at the
       3000ms mark the summary was still absent. */
    const atThreeSeconds = fake.summaryObservations.find((obs) => obs.t === 3000);
    expect(atThreeSeconds?.count ?? null).toBeNull();
    /* And it did eventually observe the fully-seeded summary. */
    expect(fake.summaryObservations.at(-1)?.count).toBe(2);
    expect(result.scrollWidth).toBe(390);
  });

  test("resolves immediately once the summary and layout are already ready", async () => {
    const fake = fakeDriver({ summaryAt: 0, layoutStableFrom: 0, expectedCount: 2 });
    const result = await waitForMobilePipelineReady(fake.driver, { expectedPipelines: 2, pollMs: 50 });
    /* Only the consecutive stable-layout confirmation polls elapse, well under a second. */
    expect(result.waitedMs).toBeLessThan(1000);
    expect(result.scrollHeight).toBe(800);
  });

  test("times out with a summary-specific error if the pipelines never load", async () => {
    const fake = fakeDriver({ summaryAt: Number.POSITIVE_INFINITY, layoutStableFrom: 0, expectedCount: 2 });
    await expect(
      waitForMobilePipelineReady(fake.driver, { expectedPipelines: 2, timeoutMs: 5_000 }),
    ).rejects.toThrow(/summary never reported 2 seeded pipelines/);
  });

  test("times out with a layout-specific error if the layout never settles", async () => {
    /* Summary is ready at once, but layout churns forever (height tracks the clock),
       so no run of consecutive equal samples ever forms. */
    let clock = 0;
    const driver: MobileReadinessDriver = {
      async summaryPipelineCount() {
        return 2;
      },
      async layoutMetrics() {
        return { scrollWidth: 390, scrollHeight: 800 + clock };
      },
      now: () => clock,
      async sleep(ms: number) {
        clock += ms;
      },
    };
    await expect(
      waitForMobilePipelineReady(driver, { expectedPipelines: 2, timeoutMs: 5_000 }),
    ).rejects.toThrow(/layout never settled/);
  });

  test("exposes sane defaults", () => {
    expect(MOBILE_READINESS_DEFAULTS.stableSamples).toBeGreaterThanOrEqual(2);
    expect(MOBILE_READINESS_DEFAULTS.pollMs).toBeGreaterThan(0);
    expect(MOBILE_READINESS_DEFAULTS.timeoutMs).toBeGreaterThan(3000);
  });
});

describe("#507 High fail-closed materialized-stage scan-readiness gate", () => {
  const VERIFY_PATH = "/tmp/e507-home/projects/x/verify.jsonl";
  const PIPELINE_ID = "e507mixed";
  const STAGE_ID = "verify";
  const CONVERSATION_ID = "verify-convo";

  /** A virtual-clock driver: the file scan reveals `verifyPath` only once the
      clock passes `discoveredAt`, and the pipelines API reports a materialized
      verify node only once the clock passes `materializedAt`. When either is
      `Infinity`, that condition never becomes true. `nodeOverride` swaps in a
      different materialized node to probe the ownership assertion (wrong path,
      empty conversation id, …). `sleep` advances the clock instantly. */
  function fakeScanDriver(script: {
    discoveredAt: number;
    materializedAt: number;
    nodeOverride?: { pipelineId?: string; stageId?: string; agentPath?: string; conversationId?: string };
  }) {
    let clock = 0;
    const node = {
      pipelineId: script.nodeOverride?.pipelineId ?? PIPELINE_ID,
      stageId: script.nodeOverride?.stageId ?? STAGE_ID,
      agentPath: script.nodeOverride?.agentPath ?? VERIFY_PATH,
      conversationId: script.nodeOverride?.conversationId ?? CONVERSATION_ID,
    };
    const driver: ScanReadinessDriver = {
      async discoveredPaths() {
        return clock >= script.discoveredAt ? [VERIFY_PATH] : [];
      },
      async materializedStageNodes() {
        return clock >= script.materializedAt ? [node] : [];
      },
      now: () => clock,
      async sleep(ms: number) {
        clock += ms;
      },
    };
    return { driver, clock: () => clock };
  }

  test("fails closed when discovery exceeds the deadline (transcript never scanned)", async () => {
    /* The transcript is never discovered on disk within the budget — the retired
       loop would have broken silently and captured placeholder-only UI as if it
       were real. The gate must now throw a discovery-specific failure. */
    const fake = fakeScanDriver({ discoveredAt: Number.POSITIVE_INFINITY, materializedAt: 0 });
    await expect(
      waitForMaterializedVerifyStage(fake.driver, {
        verifyPath: VERIFY_PATH,
        pipelineId: PIPELINE_ID,
        stageId: STAGE_ID,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/failed closed: the verify transcript was never discovered/);
  });

  test("resolves on delayed eventual success — transcript surfaces after several polls", async () => {
    /* Both the scan and the materialized node appear only at 2s, well after the
       first polls — a fixed short delay would have missed them, but observed-state
       polling awaits them correctly and then passes with the real conversation. */
    const fake = fakeScanDriver({ discoveredAt: 2_000, materializedAt: 2_000 });
    const result = await waitForMaterializedVerifyStage(fake.driver, {
      verifyPath: VERIFY_PATH,
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
      timeoutMs: 30_000,
      pollMs: 250,
    });
    expect(result.waitedMs).toBeGreaterThanOrEqual(2_000);
    expect(result.conversationId).toBe(CONVERSATION_ID);
  });

  test("keeps placeholder-only evidence from passing — path scanned but no materialized node", async () => {
    /* The file is on disk, but no stage ever materialized a real node owning it
       (every stage is a queued placeholder). The gate must fail closed with the
       materialization-specific reason, never mistake the bare file for evidence. */
    const fake = fakeScanDriver({ discoveredAt: 0, materializedAt: Number.POSITIVE_INFINITY });
    await expect(
      waitForMaterializedVerifyStage(fake.driver, {
        verifyPath: VERIFY_PATH,
        pipelineId: PIPELINE_ID,
        stageId: STAGE_ID,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/failed closed:.*never materialized a real node owning it \(placeholder-only evidence\)/);
  });

  test("rejects a materialized node that owns a DIFFERENT transcript path", async () => {
    /* A real node exists, but it is bound to another transcript — the verify stage
       does not actually OWN the discovered file, so the gate must still fail. */
    const fake = fakeScanDriver({ discoveredAt: 0, materializedAt: 0, nodeOverride: { agentPath: "/tmp/other.jsonl" } });
    await expect(
      waitForMaterializedVerifyStage(fake.driver, {
        verifyPath: VERIFY_PATH,
        pipelineId: PIPELINE_ID,
        stageId: STAGE_ID,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/placeholder-only evidence/);
  });

  test("rejects a materialized node with an empty conversation id", async () => {
    /* An on-disk path with no live conversation is not a real materialized node. */
    const fake = fakeScanDriver({ discoveredAt: 0, materializedAt: 0, nodeOverride: { conversationId: "" } });
    await expect(
      waitForMaterializedVerifyStage(fake.driver, {
        verifyPath: VERIFY_PATH,
        pipelineId: PIPELINE_ID,
        stageId: STAGE_ID,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/placeholder-only evidence/);
  });

  test("exposes sane scan-readiness defaults", () => {
    expect(SCAN_READINESS_DEFAULTS.pollMs).toBeGreaterThan(0);
    expect(SCAN_READINESS_DEFAULTS.timeoutMs).toBeGreaterThan(SCAN_READINESS_DEFAULTS.pollMs);
  });
});
