import { describe, expect, test } from "bun:test";

import { calculateDailyRollup, kyivDayBounds } from "./calculator";
import { editorEvidenceFromHeartbeats } from "./wakatimeEditor";
import type { CanonicalOperatorEvent, EditorInterval } from "./types";

const MINUTE = 60_000;
const DAY = "2026-08-14";
const START = Date.parse("2026-08-13T21:00:00.000Z");

function event(id: string, atMinutes: number, project: string | null = "project-a"): CanonicalOperatorEvent {
  return {
    id,
    sourceDigest: id.padEnd(64, "0").slice(0, 64),
    origin: "composer",
    occurredAtMs: START + atMinutes * MINUTE,
    provenOperator: true,
    project,
    ambiguous: project === null,
    projectCandidates: {},
    occurrenceDigests: [id.padEnd(64, "1").slice(0, 64)],
    occurrenceCount: 1,
    deduplicatedCount: 0,
    evidenceDigests: [id.padEnd(64, "2").slice(0, 64)],
  };
}

function editor(project: string | null, startMinute: number, endMinute: number): EditorInterval {
  return {
    project,
    startMs: START + startMinute * MINUTE,
    endMs: START + endMinute * MINUTE,
    evidenceDigest: "e".repeat(64),
  };
}

describe("Europe/Kyiv daily worktime calculation", () => {
  test("uses exact Kyiv bounds, including daylight-saving days", () => {
    expect(kyivDayBounds("2026-03-29").endMs - kyivDayBounds("2026-03-29").startMs).toBe(23 * 60 * MINUTE);
    expect(kyivDayBounds("2026-10-25").endMs - kyivDayBounds("2026-10-25").startMs).toBe(25 * 60 * MINUTE);
    expect(() => kyivDayBounds("2026-02-30")).toThrow("calendar date");
  });

  test("events 29 minutes apart form one episode and 31 minutes apart form two", () => {
    const joined = calculateDailyRollup({
      day: DAY,
      events: [event("a", 60), event("b", 89)],
      editorIntervals: [],
      excludedSyntheticMs: 0,
      projectPriority: [],
    });
    const split = calculateDailyRollup({
      day: DAY,
      events: [event("c", 60), event("d", 91)],
      editorIntervals: [],
      excludedSyntheticMs: 0,
      projectPriority: [],
    });

    expect(joined.projects[0]).toMatchObject({ rawMinutes: 29, roundedHours: 0.5 });
    expect(split.projects[0]).toMatchObject({ rawMinutes: 20, roundedHours: 0.5 });
  });

  test("a singleton contributes ten raw minutes and rounds to the half-hour minimum", () => {
    const result = calculateDailyRollup({
      day: DAY,
      events: [event("singleton", 120)],
      editorIntervals: [],
      excludedSyntheticMs: 0,
      projectPriority: [],
    });

    expect(result.projects).toEqual([expect.objectContaining({
      project: "project-a",
      rawMinutes: 10,
      roundedHours: 0.5,
      operatorEventCount: 1,
      intervals: [{ startMs: START + 120 * MINUTE, endMs: START + 130 * MINUTE }],
    })]);
  });

  test("silent tool execution after the final event cannot extend an episode", () => {
    const result = calculateDailyRollup({
      day: DAY,
      events: [event("single", 60)],
      editorIntervals: [],
      excludedSyntheticMs: 0,
      projectPriority: [],
    });

    expect(result.projects[0]?.rawMinutes).toBe(10);
  });

  test("unions editor evidence with operator episodes without double-counting", () => {
    const result = calculateDailyRollup({
      day: DAY,
      events: [event("union", 60)],
      editorIntervals: [editor("project-a", 65, 80)],
      excludedSyntheticMs: 0,
      projectPriority: [],
    });

    expect(result.projects[0]).toMatchObject({ rawMinutes: 20, editorIntervalCount: 1 });
    expect(result.projects[0]?.intervals).toEqual([{
      startMs: START + 60 * MINUTE,
      endMs: START + 80 * MINUTE,
    }]);
  });

  test("cross-project overlap is assigned once by priority", () => {
    const result = calculateDailyRollup({
      day: DAY,
      events: [],
      editorIntervals: [editor("project-a", 60, 90), editor("project-b", 75, 105)],
      excludedSyntheticMs: 0,
      projectPriority: ["project-b", "project-a"],
    });

    expect(result.projects).toEqual([
      expect.objectContaining({ project: "project-a", rawMinutes: 15 }),
      expect.objectContaining({ project: "project-b", rawMinutes: 30 }),
    ]);
    expect(result.ambiguousMinutes).toBe(0);
  });

  test("equal-priority overlap enters the ambiguity bucket independent of input order", () => {
    const calculate = (intervals: EditorInterval[]) => calculateDailyRollup({
      day: DAY,
      events: [],
      editorIntervals: intervals,
      excludedSyntheticMs: 0,
      projectPriority: [],
    });
    const forward = calculate([editor("project-a", 60, 90), editor("project-b", 75, 105)]);
    const reversed = calculate([editor("project-b", 75, 105), editor("project-a", 60, 90)]);

    expect(forward.projects).toEqual([
      expect.objectContaining({ project: "project-a", rawMinutes: 15 }),
      expect.objectContaining({ project: "project-b", rawMinutes: 15 }),
    ]);
    expect(forward.ambiguousMinutes).toBe(15);
    expect(forward.ambiguousIntervals).toEqual([{
      startMs: START + 75 * MINUTE,
      endMs: START + 90 * MINUTE,
    }]);
    expect(reversed).toEqual(forward);
  });

  test("ambiguous operator evidence remains review-only", () => {
    const result = calculateDailyRollup({
      day: DAY,
      events: [event("ambiguous", 60, null)],
      editorIntervals: [],
      excludedSyntheticMs: 0,
      projectPriority: [],
    });

    expect(result.projects).toHaveLength(0);
    expect(result.ambiguousMinutes).toBe(10);
    expect(result.ambiguousEvidenceCount).toBe(1);
  });

  test("late overlap rebuilds one canonical interval without stale internal boundaries", () => {
    const result = calculateDailyRollup({
      day: DAY,
      events: [event("early", 60), event("late", 75)],
      editorIntervals: [],
      excludedSyntheticMs: 0,
      projectPriority: [],
    });

    expect(result.projects[0]?.intervals).toEqual([{
      startMs: START + 60 * MINUTE,
      endMs: START + 75 * MINUTE,
    }]);
  });

  test("production-sized interval sweeps remain bounded", () => {
    const editorIntervals = Array.from({ length: 10_000 }, (_, index) => {
      const startMinute = index * 0.1;
      return editor(`project-${index % 25}`, startMinute, startMinute + 0.05);
    });
    const started = performance.now();
    calculateDailyRollup({
      day: DAY,
      events: [],
      editorIntervals,
      excludedSyntheticMs: 0,
      projectPriority: Array.from({ length: 25 }, (_, index) => `project-${index}`),
    });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("WakaTime editor evidence", () => {
  test("excludes Viewer entities and boundary projects while retaining real editor intervals", () => {
    const evidence = editorEvidenceFromHeartbeats(DAY, [
      { entity: "/repo/file.ts", type: "file", category: "coding", project: "project-a", time: (START + 60 * MINUTE) / 1_000 },
      { entity: "/repo/file.ts", type: "file", category: "coding", project: "project-a", time: (START + 65 * MINUTE) / 1_000 },
      { entity: "agent-log-viewer/codex/session", type: "app", category: "ai coding", project: "project-a", time: (START + 70 * MINUTE) / 1_000 },
      { entity: "agent-log-viewer/codex/session", type: "app", category: "ai coding", project: "project-a", time: (START + 72 * MINUTE) / 1_000 },
      { entity: "agent-log-viewer/boundary/session", type: "app", category: "ai coding", project: "agent-log-viewer-boundary", time: (START + 73 * MINUTE) / 1_000 },
    ]);

    expect(evidence.intervals).toEqual([expect.objectContaining({
      project: "project-a",
      startMs: START + 60 * MINUTE,
      endMs: START + 65 * MINUTE,
    })]);
    expect(evidence.excludedSyntheticMs).toBe(2 * MINUTE);
    expect(JSON.stringify(evidence)).not.toContain("/repo/file.ts");
  });
});
