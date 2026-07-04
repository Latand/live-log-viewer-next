"use client";

import { useMemo } from "react";

import type { ActionEvent, FileEntry } from "@/lib/types";
import { cleanTitle } from "@/lib/title";

import { isAuxTask, isConversation, isSubagent, kidsIndex, projectKey } from "@/components/projectModel";
import { fmtAge } from "@/components/utils";

const DAY = 86400;
const FIVE_MIN = 300;

export type SwitchboardCardKind = "waiting" | "working" | "recent" | "older";

export interface SwitchboardItem {
  file: FileEntry;
  project: string;
  title: string;
  descendants: number;
  smt: number;
  kind: SwitchboardCardKind;
  statusLine: string;
}

export interface SwitchboardData {
  waiting: SwitchboardItem[];
  working: SwitchboardItem[];
  recent: SwitchboardItem[];
  older: SwitchboardItem[];
  livePreview: SwitchboardItem[];
}

function descendantCounts(files: FileEntry[]): Map<string, number> {
  const kids = kidsIndex(files);
  const counts = new Map<string, number>();
  for (const file of files) {
    const stack = [...(kids.get(file.path) ?? [])];
    const seen = new Set<string>();
    let count = 0;
    while (stack.length) {
      const child = stack.pop()!;
      if (seen.has(child.path)) continue;
      seen.add(child.path);
      count += 1;
      stack.push(...(kids.get(child.path) ?? []));
    }
    counts.set(file.path, count);
  }
  return counts;
}

function recentBucketSort(a: SwitchboardItem, b: SwitchboardItem): number {
  return Math.floor(b.smt / FIVE_MIN) - Math.floor(a.smt / FIVE_MIN) || a.file.path.localeCompare(b.file.path);
}

function timelineLabel(file: FileEntry, latestByFile: ReadonlyMap<string, ActionEvent>): string {
  if (file.pendingQuestion) return file.pendingQuestion.kind === "plan" ? "чекає затвердження плану" : "чекає відповіді на питання";
  if (file.waitingInput) return "чекає на відповідь у терміналі";
  const event = latestByFile.get(file.path);
  if (event) return `${event.label} · ${fmtAge(event.ts)}`;
  if (file.activity === "live") return "працює…";
  if (isReturnedSubagent(file)) return "повернувся з результатом";
  if (file.activity === "stalled") return "перервано або чекає дозволу";
  if (isAwaitingUser(file)) return "закінчив хід — чекає відповіді";
  return "";
}

function isReturnedSubagent(file: FileEntry): boolean {
  return isSubagent(file) && file.proc !== "running";
}

/* An interrupted session stops being "yours to answer" after a while: a
   permission prompt from two days ago is dead context, so old stalled entries
   sink into the recency buckets instead of inflating the waiting counter. */
const WAITING_TTL = 2 * 3600;

export function isAwaitingUser(file: FileEntry, now = Date.now() / 1000): boolean {
  if (file.pendingQuestion || file.waitingInput) return true;
  if (file.activity === "stalled") return !isReturnedSubagent(file) && now - file.mtime <= WAITING_TTL;
  return file.activity === "recent" && (file.engine === "claude" || file.engine === "codex") && isConversation(file) && !isSubagent(file);
}

export function useSwitchboardData(
  files: FileEntry[],
  events: ActionEvent[],
  query: string,
  now: number,
  archived: ReadonlySet<string> = EMPTY_ARCHIVED,
): SwitchboardData {
  return useMemo(() => {
    const counts = descendantCounts(files);
    const latestByFile = new Map<string, ActionEvent>();
    for (const event of events) {
      const prev = latestByFile.get(event.file);
      if (!prev || event.ts > prev.ts) latestByFile.set(event.file, event);
    }
    const normalized = query.trim().toLowerCase();
    const base = files
      .filter(
        (file) =>
          !archived.has(file.path) &&
          (isConversation(file) ||
            file.activity === "live" ||
            file.activity === "stalled" ||
            (file.activity === "recent" && !isAuxTask(file))),
      )
      .map<SwitchboardItem>((file) => {
        const project = projectKey(file);
        const title = cleanTitle(file.title);
        const age = now - file.mtime;
        const kind: SwitchboardCardKind =
          file.pendingQuestion || file.waitingInput
            ? "waiting"
            : file.activity === "live"
            ? "working"
            : isAwaitingUser(file, now)
              ? "waiting"
              : age <= DAY
                ? "recent"
                : "older";
        return {
          file,
          project,
          title,
          descendants: counts.get(file.path) ?? 0,
          smt: file.mtime,
          kind,
          statusLine: timelineLabel(file, latestByFile),
        };
      })
      .filter((item) => {
        if (!normalized) return true;
        return `${item.title} ${item.project}`.toLowerCase().includes(normalized);
      });

    const byFreshness = (a: SwitchboardItem, b: SwitchboardItem) => b.smt - a.smt || a.file.path.localeCompare(b.file.path);
    const waiting = base.filter((item) => item.kind === "waiting").sort(byFreshness);
    const working = base.filter((item) => item.kind === "working").sort(byFreshness);
    const recent = base.filter((item) => item.kind === "recent").sort(recentBucketSort);
    const older = base.filter((item) => item.kind === "older").sort(recentBucketSort);
    return { waiting, working, recent, older, livePreview: working.slice(0, 3) };
  }, [files, events, query, now, archived]);
}

const EMPTY_ARCHIVED: ReadonlySet<string> = new Set();
