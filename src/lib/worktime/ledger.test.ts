import { describe, expect, test } from "bun:test";

import {
  emptyWorktimeState,
  historicalOperatorOccurrence,
  upsertOperatorOccurrence,
} from "./ledger";

const DAY = Date.parse("2026-08-14T09:00:00.000Z");

describe("canonical operator-event ledger", () => {
  test("accepts a direct API-human event with an arbitrary stable id at any conversation depth", () => {
    const state = emptyWorktimeState(DAY);

    const event = upsertOperatorOccurrence(state, {
      sourceId: "api-human-request-7",
      occurrenceId: "api-human-request-7",
      origin: "api-human",
      relation: "direct",
      occurredAtMs: DAY,
      projectCandidates: [{ project: "fixture-project", rank: 4, evidence: "ownership" }],
    });

    expect(event).toMatchObject({
      occurredAtMs: DAY,
      origin: "api-human",
      provenOperator: true,
      project: "fixture-project",
      ambiguous: false,
    });
    expect(event.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(state)).not.toContain("api-human-request-7");
  });

  test("one direct event copied through fan-out, resume, mirror, and retry remains one canonical event", () => {
    const state = emptyWorktimeState(DAY);
    const base = {
      sourceId: "stable-source",
      origin: "composer" as const,
      occurredAtMs: DAY,
      projectCandidates: [{ project: "fixture-project", rank: 3, evidence: "cwd" }],
    };

    upsertOperatorOccurrence(state, { ...base, occurrenceId: "direct", relation: "direct" });
    upsertOperatorOccurrence(state, { ...base, occurrenceId: "direct", relation: "direct" });
    upsertOperatorOccurrence(state, { ...base, occurrenceId: "worker-copy", relation: "copy", occurredAtMs: DAY + 100 });
    upsertOperatorOccurrence(state, { ...base, occurrenceId: "resume-copy", relation: "copy", occurredAtMs: DAY + 200 });
    upsertOperatorOccurrence(state, { ...base, occurrenceId: "mirror-copy", relation: "copy", occurredAtMs: DAY + 300 });

    const events = Object.values(state.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provenOperator: true, occurrenceCount: 4, deduplicatedCount: 3 });
  });

  test("a copied launch without direct operator evidence contributes zero", () => {
    const state = emptyWorktimeState(DAY);
    const event = upsertOperatorOccurrence(state, {
      sourceId: "fanout-only",
      occurrenceId: "worker-copy",
      origin: "composer",
      relation: "copy",
      occurredAtMs: DAY,
      projectCandidates: [{ project: "fixture-project", rank: 4, evidence: "ownership" }],
    });

    expect(event).toMatchObject({ provenOperator: false, project: null, ambiguous: false });
  });

  test("an earlier copied occurrence cannot move the supervised interval before direct input", () => {
    const state = emptyWorktimeState(DAY);
    const base = {
      sourceId: "copy-before-direct",
      origin: "composer" as const,
      projectCandidates: [{ project: "fixture-project", rank: 4, evidence: "ownership" }],
    };
    upsertOperatorOccurrence(state, {
      ...base,
      occurrenceId: "worker-copy",
      relation: "copy",
      occurredAtMs: DAY - 5_000,
    });
    const event = upsertOperatorOccurrence(state, {
      ...base,
      occurrenceId: "operator-direct",
      relation: "direct",
      occurredAtMs: DAY,
    });

    expect(event.occurredAtMs).toBe(DAY);
    expect(event).toMatchObject({ provenOperator: true, occurrenceCount: 2, deduplicatedCount: 1 });
  });

  test("late discovery moves the canonical event to the earliest observed timestamp", () => {
    const state = emptyWorktimeState(DAY);
    const input = {
      sourceId: "late-source",
      origin: "realtime" as const,
      relation: "direct" as const,
      projectCandidates: [{ project: "fixture-project", rank: 3, evidence: "cwd" }],
    };
    upsertOperatorOccurrence(state, { ...input, occurrenceId: "later", occurredAtMs: DAY + 500 });
    const event = upsertOperatorOccurrence(state, { ...input, occurrenceId: "earlier", occurredAtMs: DAY });

    expect(event.occurredAtMs).toBe(DAY);
    expect(event.occurrenceCount).toBe(2);
  });

  test("equal-rank project evidence enters ambiguity independent of scan order", () => {
    const resolve = (projects: string[]) => {
      const state = emptyWorktimeState(DAY);
      for (const project of projects) {
        upsertOperatorOccurrence(state, {
          sourceId: "shared-source",
          occurrenceId: `copy-${project}`,
          origin: "historical",
          relation: "direct",
          occurredAtMs: DAY,
          projectCandidates: [{ project, rank: 3, evidence: `cwd-${project}` }],
        });
      }
      return Object.values(state.events)[0];
    };

    expect(resolve(["project-a", "project-b"])).toMatchObject({ project: null, ambiguous: true });
    expect(resolve(["project-b", "project-a"])).toMatchObject({ project: null, ambiguous: true });
  });

  test("historical fallback uses normalized-content and lineage digests inside a bounded window", () => {
    const state = emptyWorktimeState(DAY);
    const first = historicalOperatorOccurrence({
      normalizedText: "  Review\r\n the   change ",
      lineageId: "root-lineage",
      occurrenceId: "record-later",
      occurredAtMs: DAY + 20_000,
      projectCandidates: [{ project: "fixture-project", rank: 2, evidence: "profile" }],
    });
    const earlier = historicalOperatorOccurrence({
      normalizedText: "review\nTHE change",
      lineageId: "root-lineage",
      occurrenceId: "record-earlier",
      occurredAtMs: DAY,
      projectCandidates: [{ project: "fixture-project", rank: 2, evidence: "profile" }],
    });
    const distant = historicalOperatorOccurrence({
      normalizedText: "review the change",
      lineageId: "root-lineage",
      occurrenceId: "record-distant",
      occurredAtMs: DAY + 31_000,
      projectCandidates: [{ project: "fixture-project", rank: 2, evidence: "profile" }],
    });

    upsertOperatorOccurrence(state, first);
    const firstId = Object.values(state.events)[0]!.id;
    const canonical = upsertOperatorOccurrence(state, earlier);
    upsertOperatorOccurrence(state, distant);

    expect(Object.values(state.events)).toHaveLength(2);
    expect(canonical.occurredAtMs).toBe(DAY);
    expect(canonical.id).not.toBe(firstId);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("review the change");
    expect(serialized).not.toContain("root-lineage");
  });
});
