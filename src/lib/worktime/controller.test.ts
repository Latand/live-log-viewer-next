import { describe, expect, test } from "bun:test";

import { runWorktimeCatchupPass } from "./controller";
import { emptyWorktimeState } from "./ledger";
import type { WorktimeStateV1 } from "./types";

const NOW = Date.parse("2026-08-15T09:00:00.000Z");

describe("complete-inventory catch-up controller", () => {
  test("first enable persists its boundary only after a complete inventory and performs no editor fetch", async () => {
    const state = emptyWorktimeState(NOW);
    let mutations = 0;
    let fetches = 0;
    await runWorktimeCatchupPass({
      now: () => NOW,
      stateExists: () => false,
      readState: () => state,
      scanHistoricalDay: async () => ({ complete: true, occurrences: [] }),
      fetchEditorEvidence: async () => { fetches += 1; return { intervals: [], excludedSyntheticMs: 0 }; },
      mutate: <T>(operation: (draft: WorktimeStateV1) => T): T => {
        mutations += 1;
        return operation(state);
      },
      projectPriority: [],
    });

    expect({ mutations, fetches }).toEqual({ mutations: 1, fetches: 0 });
  });

  test("derivation-incomplete inventory performs no mutation, credential lookup, or fetch", async () => {
    const state = emptyWorktimeState(Date.parse("2026-08-14T09:00:00.000Z"));
    let mutations = 0;
    let fetches = 0;
    await runWorktimeCatchupPass({
      now: () => NOW,
      readState: () => structuredClone(state),
      scanHistoricalDay: async () => ({ complete: false, occurrences: [] }),
      fetchEditorEvidence: async () => { fetches += 1; return { intervals: [], excludedSyntheticMs: 0 }; },
      mutate: () => { mutations += 1; throw new Error("must stay untouched"); },
      projectPriority: [],
    });

    expect(fetches).toBe(0);
    expect(mutations).toBe(0);
  });

  test("tail-incomplete inventory has the same fail-closed behavior", async () => {
    const state = emptyWorktimeState(Date.parse("2026-08-14T09:00:00.000Z"));
    let fetches = 0;
    let mutations = 0;
    await runWorktimeCatchupPass({
      now: () => NOW,
      readState: () => structuredClone(state),
      scanHistoricalDay: async () => ({ complete: false, reason: "transcript-tail-incomplete", occurrences: [] }),
      fetchEditorEvidence: async () => { fetches += 1; return { intervals: [], excludedSyntheticMs: 0 }; },
      mutate: <T>(): T => { mutations += 1; throw new Error("must stay untouched"); },
      projectPriority: [],
    });
    expect({ fetches, mutations }).toEqual({ fetches: 0, mutations: 0 });
  });

  test("an editor failure stops the day sequence and the next healthy pass backfills it", async () => {
    let state: WorktimeStateV1 = emptyWorktimeState(Date.parse("2026-08-13T09:00:00.000Z"));
    let failFirst = true;
    const dependencies = {
      now: () => NOW,
      readState: () => structuredClone(state),
      scanHistoricalDay: async () => ({ complete: true, occurrences: [] }),
      fetchEditorEvidence: async (day: string) => {
        if (day === "2026-08-13" && failFirst) throw new Error("fixture outage");
        return { intervals: [], excludedSyntheticMs: 0 };
      },
      mutate: <T>(operation: (draft: WorktimeStateV1) => T): T => {
        const draft = structuredClone(state);
        const result = operation(draft);
        state = draft;
        return result;
      },
      projectPriority: [],
    };

    await runWorktimeCatchupPass(dependencies);
    expect(state.rollups).toEqual({});
    expect(state.catchup.failedDay).toBe("2026-08-13");

    failFirst = false;
    await runWorktimeCatchupPass(dependencies);
    expect(Object.keys(state.rollups)).toEqual(["2026-08-13", "2026-08-14"]);
  });

  test("a weekly boundary processes the previous complete day idempotently", async () => {
    let state: WorktimeStateV1 = emptyWorktimeState(Date.parse("2026-08-16T09:00:00.000Z"));
    let fetches = 0;
    const dependencies = {
      now: () => Date.parse("2026-08-17T09:00:00.000Z"),
      readState: () => structuredClone(state),
      scanHistoricalDay: async () => ({
        complete: true,
        occurrences: [{
          sourceId: "sunday-event",
          occurrenceId: "sunday-event",
          origin: "composer" as const,
          relation: "direct" as const,
          occurredAtMs: Date.parse("2026-08-16T09:00:00.000Z"),
          projectCandidates: [{ project: "fixture-project", rank: 4, evidence: "ownership" }],
        }],
      }),
      fetchEditorEvidence: async () => { fetches += 1; return { intervals: [], excludedSyntheticMs: 0 }; },
      mutate: <T>(operation: (draft: WorktimeStateV1) => T): T => {
        const draft = structuredClone(state);
        const result = operation(draft);
        state = draft;
        return result;
      },
      projectPriority: [],
    };

    await runWorktimeCatchupPass(dependencies);
    const first = structuredClone(state.rollups["2026-08-16"]);
    await runWorktimeCatchupPass(dependencies);

    expect(state.rollups["2026-08-16"]).toEqual(first);
    expect(fetches).toBe(1);
  });

  test("a later complete scan imports evidence and calculates the missing day once", async () => {
    let state: WorktimeStateV1 = emptyWorktimeState(Date.parse("2026-08-14T09:00:00.000Z"));
    let fetches = 0;
    const dependencies = {
      now: () => NOW,
      readState: () => structuredClone(state),
      scanHistoricalDay: async () => ({
        complete: true,
        occurrences: [{
          sourceId: "operator-source",
          occurrenceId: "record-one",
          origin: "api-human" as const,
          relation: "direct" as const,
          occurredAtMs: Date.parse("2026-08-14T09:00:00.000Z"),
          projectCandidates: [{ project: "fixture-project", rank: 3, evidence: "cwd" }],
        }],
      }),
      fetchEditorEvidence: async () => { fetches += 1; return { intervals: [], excludedSyntheticMs: 0 }; },
      mutate: <T>(operation: (draft: WorktimeStateV1) => T): T => {
        const draft = structuredClone(state);
        const result = operation(draft);
        state = draft;
        return result;
      },
      projectPriority: [],
    };

    await runWorktimeCatchupPass(dependencies);
    await runWorktimeCatchupPass(dependencies);

    expect(fetches).toBe(1);
    expect(state.rollups["2026-08-14"]?.rollup.projects[0]).toMatchObject({
      project: "fixture-project",
      rawMinutes: 10,
      roundedHours: 0.5,
    });
  });

  test("a later mirror moves an undelivered canonical event earlier after restart", async () => {
    let state: WorktimeStateV1 = emptyWorktimeState(Date.parse("2026-08-14T09:00:00.000Z"));
    let earlierMirrorVisible = false;
    let fetches = 0;
    const occurrence = (occurredAtMs: number, occurrenceId: string) => ({
      sourceId: "stable-operator-source",
      occurrenceId,
      origin: "composer" as const,
      relation: "direct" as const,
      occurredAtMs,
      projectCandidates: [{ project: "fixture-project", rank: 3, evidence: "cwd" }],
    });
    const dependencies = {
      now: () => NOW,
      readState: () => structuredClone(state),
      scanHistoricalDay: async () => ({
        complete: true,
        occurrences: earlierMirrorVisible
          ? [occurrence(Date.parse("2026-08-14T08:55:00.000Z"), "mirror"), occurrence(Date.parse("2026-08-14T09:00:00.000Z"), "original")]
          : [occurrence(Date.parse("2026-08-14T09:00:00.000Z"), "original")],
      }),
      fetchEditorEvidence: async () => { fetches += 1; return { intervals: [], excludedSyntheticMs: 0 }; },
      mutate: <T>(operation: (draft: WorktimeStateV1) => T): T => {
        const draft = structuredClone(state);
        const result = operation(draft);
        state = draft;
        return result;
      },
      projectPriority: [],
    };

    await runWorktimeCatchupPass(dependencies);
    earlierMirrorVisible = true;
    await runWorktimeCatchupPass(dependencies);
    await runWorktimeCatchupPass(dependencies);

    expect(fetches).toBe(2);
    expect(state.rollups["2026-08-14"]?.rollup.projects[0]?.intervals).toEqual([{
      startMs: Date.parse("2026-08-14T08:55:00.000Z"),
      endMs: Date.parse("2026-08-14T09:05:00.000Z"),
    }]);
  });
});
