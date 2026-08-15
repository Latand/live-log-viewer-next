import {
  WORKTIME_TIMEZONE,
  type CanonicalOperatorEvent,
  type DailyProjectRollup,
  type DailyWorktimeRollup,
  type EditorInterval,
} from "./types";

const MINUTE_MS = 60_000;
const EPISODE_GAP_MS = 30 * MINUTE_MS;
const MINIMUM_EPISODE_MS = 10 * MINUTE_MS;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Interval {
  startMs: number;
  endMs: number;
}

function localParts(atMs: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: WORKTIME_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const value = (kind: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === kind)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

function kyivMidnight(year: number, month: number, day: number): number {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(guess);
    const difference = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    ) - target;
    if (difference === 0) return guess;
    guess -= difference;
  }
  return guess;
}

export function kyivDayBounds(day: string): { startMs: number; endMs: number } {
  const match = day.match(DAY_PATTERN);
  if (!match) throw new Error("worktime day must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const validated = new Date(Date.UTC(year, month - 1, date));
  if (validated.getUTCFullYear() !== year || validated.getUTCMonth() !== month - 1 || validated.getUTCDate() !== date) {
    throw new Error("worktime day must be a calendar date");
  }
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return {
    startMs: kyivMidnight(year, month, date),
    endMs: kyivMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

export function kyivDayKey(atMs: number): string {
  const parts = localParts(atMs);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function nextDayKey(day: string): string {
  const match = day.match(DAY_PATTERN);
  if (!match) throw new Error("worktime day must use YYYY-MM-DD");
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return next.toISOString().slice(0, 10);
}

function previousDayKey(day: string): string {
  const match = day.match(DAY_PATTERN);
  if (!match) throw new Error("worktime day must use YYYY-MM-DD");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1)).toISOString().slice(0, 10);
}

export function previousCompleteKyivDay(atMs: number): string {
  return previousDayKey(kyivDayKey(atMs));
}

function operatorEpisodes(events: CanonicalOperatorEvent[]): Interval[] {
  const times = [...new Set(events.map((event) => event.occurredAtMs))].sort((left, right) => left - right);
  if (times.length === 0) return [];
  const result: Interval[] = [];
  let first = times[0]!;
  let last = first;
  for (const current of times.slice(1)) {
    if (current - last <= EPISODE_GAP_MS) {
      last = current;
      continue;
    }
    result.push({ startMs: first, endMs: Math.max(last, first + MINIMUM_EPISODE_MS) });
    first = current;
    last = current;
  }
  result.push({ startMs: first, endMs: Math.max(last, first + MINIMUM_EPISODE_MS) });
  return result;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const ordered = intervals
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: Interval[] = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (!previous || interval.startMs > previous.endMs) merged.push({ ...interval });
    else previous.endMs = Math.max(previous.endMs, interval.endMs);
  }
  return merged;
}

function clipped(interval: Interval, bounds: { startMs: number; endMs: number }): Interval | null {
  const startMs = Math.max(interval.startMs, bounds.startMs);
  const endMs = Math.min(interval.endMs, bounds.endMs);
  return endMs > startMs ? { startMs, endMs } : null;
}

function minutes(milliseconds: number): number {
  return Math.round((milliseconds / MINUTE_MS) * 1_000) / 1_000;
}

function roundedHours(milliseconds: number): number {
  if (milliseconds <= 0) return 0;
  return Math.max(0.5, Math.round((milliseconds / (60 * MINUTE_MS)) * 2) / 2);
}

function appendInterval(intervals: Interval[], startMs: number, endMs: number): void {
  if (endMs <= startMs) return;
  const previous = intervals.at(-1);
  if (previous && startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, endMs);
  else intervals.push({ startMs, endMs });
}

function intervalDuration(intervals: Interval[]): number {
  return intervals.reduce((total, interval) => total + interval.endMs - interval.startMs, 0);
}

export function calculateDailyRollup(input: {
  day: string;
  events: CanonicalOperatorEvent[];
  editorIntervals: EditorInterval[];
  excludedSyntheticMs: number;
  projectPriority: string[];
}): DailyWorktimeRollup {
  const bounds = kyivDayBounds(input.day);
  const events = input.events.filter((event) =>
    event.provenOperator && event.occurredAtMs >= bounds.startMs && event.occurredAtMs < bounds.endMs);
  const editors = input.editorIntervals
    .map((interval) => ({ interval, clipped: clipped(interval, bounds) }))
    .filter((item): item is { interval: EditorInterval; clipped: Interval } => item.clipped !== null);
  const projectNames = new Set<string>();
  for (const event of events) if (event.project) projectNames.add(event.project);
  for (const item of editors) if (item.interval.project) projectNames.add(item.interval.project);

  const intervalsByProject = new Map<string, Interval[]>();
  for (const project of projectNames) {
    const operator = operatorEpisodes(events.filter((event) => event.project === project))
      .map((interval) => clipped(interval, bounds))
      .filter((interval): interval is Interval => interval !== null);
    const editor = editors.filter((item) => item.interval.project === project).map((item) => item.clipped);
    intervalsByProject.set(project, mergeIntervals([...operator, ...editor]));
  }

  const ambiguousIntervals = mergeIntervals([
    ...operatorEpisodes(events.filter((event) => event.ambiguous || event.project === null)),
    ...editors.filter((item) => item.interval.project === null).map((item) => item.clipped),
  ].map((interval) => clipped(interval, bounds)).filter((interval): interval is Interval => interval !== null));
  const changes = new Map<number, { projects: Map<string, number>; ambiguous: number }>();
  const changeAt = (atMs: number) => {
    const existing = changes.get(atMs) ?? { projects: new Map<string, number>(), ambiguous: 0 };
    changes.set(atMs, existing);
    return existing;
  };
  for (const [project, intervals] of intervalsByProject) {
    for (const interval of intervals) {
      const start = changeAt(interval.startMs);
      start.projects.set(project, (start.projects.get(project) ?? 0) + 1);
      const end = changeAt(interval.endMs);
      end.projects.set(project, (end.projects.get(project) ?? 0) - 1);
    }
  }
  for (const interval of ambiguousIntervals) {
    changeAt(interval.startMs).ambiguous += 1;
    changeAt(interval.endMs).ambiguous -= 1;
  }
  const orderedBoundaries = [...changes.keys()].sort((left, right) => left - right);
  const assignedByProject = new Map<string, Interval[]>();
  const assignedAmbiguous: Interval[] = [];
  const activeProjects = new Map<string, number>();
  let activeAmbiguous = 0;
  const rank = new Map(input.projectPriority.map((project, index) => [project, input.projectPriority.length - index]));
  for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
    const startMs = orderedBoundaries[index]!;
    const change = changes.get(startMs)!;
    activeAmbiguous += change.ambiguous;
    for (const [project, delta] of change.projects) {
      const count = (activeProjects.get(project) ?? 0) + delta;
      if (count > 0) activeProjects.set(project, count);
      else activeProjects.delete(project);
    }
    const endMs = orderedBoundaries[index + 1]!;
    if (endMs <= startMs) continue;
    if (activeAmbiguous > 0) {
      appendInterval(assignedAmbiguous, startMs, endMs);
      continue;
    }
    if (activeProjects.size === 0) continue;
    const active = [...activeProjects.keys()].sort();
    const highest = Math.max(...active.map((project) => rank.get(project) ?? 0));
    const winners = active.filter((project) => (rank.get(project) ?? 0) === highest);
    if (winners.length !== 1) {
      appendInterval(assignedAmbiguous, startMs, endMs);
      continue;
    }
    const winner = winners[0]!;
    const assigned = assignedByProject.get(winner) ?? [];
    appendInterval(assigned, startMs, endMs);
    assignedByProject.set(winner, assigned);
  }

  const projects: DailyProjectRollup[] = [...assignedByProject.entries()]
    .map(([project, intervals]) => [project, intervals, intervalDuration(intervals)] as const)
    .filter(([, , duration]) => duration > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([project, intervals, duration]) => {
      const projectEvents = events.filter((event) => event.project === project);
      const projectEditors = editors.filter((item) => item.interval.project === project);
      return {
        project,
        intervals,
        rawMinutes: minutes(duration),
        roundedHours: roundedHours(duration),
        operatorEventCount: projectEvents.length,
        editorIntervalCount: projectEditors.length,
        evidenceCount: projectEvents.length + projectEditors.length,
        deduplicatedCount: projectEvents.reduce((total, event) => total + event.deduplicatedCount, 0),
      };
    });
  const totalAssignedMs = [...assignedByProject.values()].reduce((total, intervals) => total + intervalDuration(intervals), 0);
  return {
    day: input.day,
    timezone: WORKTIME_TIMEZONE,
    projects,
    rawMinutes: minutes(totalAssignedMs),
    roundedHours: projects.reduce((total, project) => total + project.roundedHours, 0),
    operatorEventCount: events.filter((event) => event.project !== null).length,
    editorIntervalCount: editors.filter((item) => item.interval.project !== null).length,
    evidenceCount: events.length + editors.length,
    deduplicatedCount: events.reduce((total, event) => total + event.deduplicatedCount, 0),
    excludedSyntheticMinutes: minutes(Math.max(0, input.excludedSyntheticMs)),
    ambiguousMinutes: minutes(intervalDuration(assignedAmbiguous)),
    ambiguousEvidenceCount: events.filter((event) => event.ambiguous || event.project === null).length
      + editors.filter((item) => item.interval.project === null).length,
    ambiguousIntervals: assignedAmbiguous,
  };
}
