"use client";

import { useMemo } from "react";

import type { Flow } from "@/lib/flows/types";
import { translate, type TFunction, useLocale } from "@/lib/i18n";
import type { ActionEvent, FileEntry } from "@/lib/types";
import { cleanTitle } from "@/lib/title";

import { attentionId } from "@/components/attention";
import { isDirectReviewFlow } from "@/components/flows/directReviewGroups";
import { claimedReviewerPaths, flowByImplementer, flowPresentation } from "@/components/flows/flowModel";
import { descendantCounts, isAuxTask, isConversation, isSubagent, projectKey } from "@/components/projectModel";
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

function recentBucketSort(a: SwitchboardItem, b: SwitchboardItem): number {
  return Math.floor(b.smt / FIVE_MIN) - Math.floor(a.smt / FIVE_MIN) || a.file.path.localeCompare(b.file.path);
}

function timelineLabel(t: TFunction, file: FileEntry, latestByFile: ReadonlyMap<string, ActionEvent>): string {
  if (file.pendingQuestion) return file.pendingQuestion.kind === "plan" ? t("status.awaitingPlan") : t("status.awaitingAnswer");
  if (file.rateLimit) return t("status.rateLimited");
  if (file.waitingInput) return t("status.awaitingTerminal");
  /* A live agent's own plan step names its current goal better than the last
     timeline event does. */
  if (file.activity === "live" && file.plan?.current) {
    return `${file.plan.done}/${file.plan.total} · ${file.plan.current}`;
  }
  const event = latestByFile.get(file.path);
  if (event) return `${event.label} · ${fmtAge(event.ts)}`;
  if (file.activity === "live") return t("status.working");
  if (isReturnedSubagent(file)) return t("status.returnedResult");
  if (file.activity === "stalled") return t("status.stalled");
  if (isAwaitingUser(file)) return t("status.finishedTurn");
  return "";
}

function isReturnedSubagent(file: FileEntry): boolean {
  return isSubagent(file) && file.proc !== "running";
}

export function isAwaitingUser(file: FileEntry, now = Date.now() / 1000): boolean {
  if (file.pendingQuestion || file.rateLimit || file.waitingInput) return true;
  /* An interrupted session stops being "yours to answer" after a while: a
     permission prompt from two days ago is dead context, so old stalled
     entries sink into the recency buckets instead of inflating the waiting
     counter. The attention queue owns that TTL judgement. */
  if (file.activity === "stalled") return attentionId(file, now) !== null;
  return file.activity === "recent" && (file.engine === "claude" || file.engine === "codex") && isConversation(file) && !isSubagent(file);
}

export function useSwitchboardData(
  files: FileEntry[],
  events: ActionEvent[],
  query: string,
  now: number,
  archived: ReadonlySet<string> = EMPTY_ARCHIVED,
  flows: Flow[] = EMPTY_FLOWS,
): SwitchboardData {
  const { locale } = useLocale();
  return useMemo(() => {
    const t: TFunction = (key, params) => translate(locale, key, params);
    const counts = descendantCounts(files);
    const latestByFile = new Map<string, ActionEvent>();
    for (const event of events) {
      const prev = latestByFile.get(event.file);
      if (!prev || event.ts > prev.ts) latestByFile.set(event.file, event);
    }
    /* Flow-aware attention: an implementer whose loop waits on a decision is
       "yours" even while its transcript looks idle; claimed reviewer runs
       never surface as standalone cards. Direct review groups (issue #325)
       claim their reviewers the same way, but they are synthetic read-model
       flows — the status-line/attention override stays with REAL flows only. */
    const flowByImpl = flowByImplementer(flows.filter((flow) => !isDirectReviewFlow(flow)));
    const claimed = claimedReviewerPaths(flows, files);
    const normalized = query.trim().toLowerCase();
    const base = files
      .filter(
        (file) =>
          !archived.has(file.path) &&
          !claimed.has(file.path) &&
          (isConversation(file) ||
            file.activity === "live" ||
            file.activity === "stalled" ||
            (file.activity === "recent" && !isAuxTask(file))),
      )
      .map<SwitchboardItem>((file) => {
        const project = projectKey(file);
        const title = cleanTitle(file.title);
        const age = now - file.mtime;
        const flow = flowByImpl.get(file.path);
        let kind: SwitchboardCardKind =
          file.pendingQuestion || file.rateLimit || file.waitingInput
            ? "waiting"
            : file.activity === "live"
            ? "working"
            : isAwaitingUser(file, now)
              ? "waiting"
              : age <= DAY
                ? "recent"
                : "older";
        let statusLine = timelineLabel(t, file, latestByFile);
        if (flow) {
          const presentation = flowPresentation(t, flow, locale);
          if (presentation.attention) kind = "waiting";
          else if (flow.state === "reviewing" || flow.state === "relaying" || flow.state === "spawning") kind = "working";
          statusLine = `${t("status.flow", { label: presentation.label })}${presentation.detail ? ` — ${presentation.detail}` : ""}`;
        }
        return {
          file,
          project,
          title,
          descendants: counts.get(file.path) ?? 0,
          smt: file.mtime,
          kind,
          statusLine,
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
  }, [files, events, query, now, archived, flows, locale]);
}

const EMPTY_ARCHIVED: ReadonlySet<string> = new Set();
const EMPTY_FLOWS: Flow[] = [];
