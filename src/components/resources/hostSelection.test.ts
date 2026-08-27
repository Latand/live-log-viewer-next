import { expect, test } from "bun:test";

import type { ResourceSession } from "@/lib/types";

import { bulkKillTargets, idleKillTargets, isStructuredHost, resourceCounts } from "./hostSelection";

const NOW = Date.parse("2026-08-26T12:00:00.000Z") / 1_000;

function session(over: Partial<ResourceSession> & Pick<ResourceSession, "target">): ResourceSession {
  return {
    panePid: 100,
    path: null,
    engine: "claude",
    title: null,
    project: null,
    activity: "idle",
    lastActiveAt: null,
    cwd: "/repo",
    rssBytes: 100,
    swapBytes: 0,
    procCount: 1,
    ...over,
  };
}

const hoursAgo = (hours: number) => new Date((NOW - hours * 3_600) * 1_000).toISOString();

test("idle means the turn settled and the transcript went quiet for the threshold", () => {
  const sessions = [
    session({ target: "long-idle", lastActiveAt: hoursAgo(6) }),
    session({ target: "recently-idle", lastActiveAt: hoursAgo(1) }),
    session({ target: "live", activity: "live", lastActiveAt: hoursAgo(6) }),
    /* Quiet transcript, unsettled turn: the host is mid-tool-call, not idle. */
    session({ target: "mid-turn", kind: "structured", turnBusy: true, lastActiveAt: hoursAgo(6) }),
    /* No idle age to compare against — "idle longer than N" is unprovable. */
    session({ target: "ageless" }),
  ];

  expect(idleKillTargets(sessions, 2, NOW, new Set()).map((item) => item.target)).toEqual(["long-idle"]);
});

test("a live orchestrator seat is listed but stays out of both bulk kills until ticked", () => {
  const sessions = [
    session({ target: "lane", kind: "structured", seat: false, turnBusy: false, lastActiveAt: hoursAgo(6) }),
    session({ target: "seat", kind: "structured", seat: true, turnBusy: false, lastActiveAt: hoursAgo(6) }),
  ];

  expect(idleKillTargets(sessions, 2, NOW, new Set()).map((item) => item.target)).toEqual(["lane"]);
  expect(bulkKillTargets(sessions, new Set()).map((item) => item.target)).toEqual(["lane"]);

  const ticked = new Set(["seat"]);
  expect(idleKillTargets(sessions, 2, NOW, ticked).map((item) => item.target)).toEqual(["lane", "seat"]);
  expect(bulkKillTargets(sessions, ticked).map((item) => item.target)).toEqual(["lane", "seat"]);
});

test("a structured host whose seat status is unknown stays out of every bulk kill", () => {
  const unknown = session({
    target: "scan-only-host",
    kind: "structured",
    seat: null,
    turnBusy: null,
    lastActiveAt: hoursAgo(6),
  });

  expect(idleKillTargets([unknown], 2, NOW, new Set())).toEqual([]);
  expect(bulkKillTargets([unknown], new Set())).toEqual([]);
});

test("kill all takes live hosts too — that is the point of the clean slate", () => {
  const sessions = [
    session({ target: "live", activity: "live" }),
    session({ target: "idle", lastActiveAt: hoursAgo(6) }),
  ];

  expect(bulkKillTargets(sessions, new Set()).map((item) => item.target)).toEqual(["live", "idle"]);
});

test("the footer counts hosts, idle hosts and the resident memory they hold", () => {
  const sessions = [
    session({ target: "a", kind: "structured", seat: false, turnBusy: false, rssBytes: 600, swapBytes: 40, lastActiveAt: hoursAgo(6) }),
    session({ target: "b", kind: "structured", seat: false, turnBusy: true, rssBytes: 300, swapBytes: 7, activity: "live" }),
    session({ target: "c", rssBytes: 100, swapBytes: 0, lastActiveAt: hoursAgo(3) }),
  ];

  /* Resident only: the swapped-out pages of these hosts are not RAM they are
     holding, and the Swap row above already reports that pressure. */
  expect(resourceCounts(sessions, 2, NOW)).toEqual({ hosts: 3, idle: 2, bytes: 1_000 });
});

test("a row without a kind is a legacy tmux pane", () => {
  expect(isStructuredHost(session({ target: "pane" }))).toBeFalse();
  expect(isStructuredHost(session({ target: "host", kind: "structured" }))).toBeTrue();
});
