import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildMobileBoard, mobileRowState, nowFragment, RECENT_CAP } from "./mobileBoardModel";

/*
 * The phone board's projection (issue #1439, lane 2; README §4.1, §4.2).
 *
 * The list is the operator's triage surface, so the things asserted here are
 * the decisions the design makes and nothing about how they look: which
 * section a conversation lands in, the ONE precedence every surface reads
 * (killed > stalled > limit > held > waiting > working > returned > done), the
 * seat kept out of the sections it sits above, pipelines waiting on a decision
 * standing in the queue beside conversations, the pipelines summary rising
 * above Working while any pipeline runs, Recent capped at three, and the
 * now-fragment that says what a working agent is doing.
 */

const NOW = 1_800_000_000;
const PROJECT = "atlas";

function entry(over: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: over.path.split("/").pop() ?? "x.jsonl",
    project: PROJECT,
    title: "A conversation",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 60,
    size: 1_024,
    activity: "idle",
    proc: null,
    pid: null,
    model: "opus",
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

/** A conversation mid-turn: the open-turn condition the spinner paints from. */
const working = (over: Partial<FileEntry> & { path: string }) => entry({
  activity: "live",
  proc: "running",
  pid: 4_401,
  lastTurn: { startedAt: (NOW - 760) * 1_000, endedAt: null },
  ...over,
});

const question = (over: Partial<FileEntry> & { path: string }, kind: "question" | "plan" = "question") => working({
  pendingQuestion: {
    kind,
    toolUseId: `toolu-${kind}`,
    transcriptPath: over.path,
    pid: 4_402,
    paneTarget: null,
    askedAt: new Date((NOW - 540) * 1_000).toISOString(),
  } as FileEntry["pendingQuestion"],
  ...over,
});

function pipeline(over: Partial<Pipeline> & { id: string }): Pipeline {
  return {
    task: "A lane",
    taskIds: [],
    project: PROJECT,
    repoDir: "/repo",
    worktreeDir: "/repo-lane",
    branch: "lane/1",
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [
      { id: "design", kind: "run" },
      { id: "implement", kind: "run" },
      { id: "review", kind: "review-loop" },
    ],
    runs: [],
    cursor: null,
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: new Date((NOW - 7_200) * 1_000).toISOString(),
    closedAt: null,
    ...over,
  } as Pipeline;
}

test("the precedence is one order, and a lower signal never outranks a higher one", () => {
  const base = { path: "/p/a.jsonl" };
  /* Every case below also carries the signals of the ones under it, so each
     assertion is the precedence itself, not merely the mapping. */
  const stalledAndWaiting = question({ ...base, activity: "stalled", mtime: NOW - 840 });
  expect(mobileRowState(question(base), NOW).key).toBe("waiting");
  expect(mobileRowState(stalledAndWaiting, NOW).key).toBe("stalled");
  expect(mobileRowState({ ...stalledAndWaiting, proc: "killed" } as FileEntry, NOW).key).toBe("killed");
  expect(mobileRowState(question({ ...base, rateLimit: { source: "account", accountId: null, window: "session", resetAt: NOW + 600 } }), NOW).key).toBe("limit");
  /* The wall carries BOTH halves of what the row must say — which account, and
     when it reopens — so «Main resets 16:40» is rendered from the read, never
     re-derived from somewhere else (README §4.2). */
  const walled = mobileRowState(question({ ...base, rateLimit: { source: "account", accountId: "main", window: "session", resetAt: NOW + 600 } }), NOW);
  expect(walled).toMatchObject({ key: "limit", account: "main", resetAt: NOW + 600, badge: "limit", edge: "warning" });
  /* A read that names no account and no reset still says «limit» and nothing
     it does not know. */
  expect(mobileRowState(question({ ...base, rateLimit: { source: "pane", accountId: null, window: null, resetAt: null } }), NOW))
    .toMatchObject({ key: "limit", account: null, resetAt: null });
  const held = question({
    ...base,
    migration: { intentId: "i1", trigger: "manual", phase: "switching", targetAccountId: "other", heldDeliveries: 2, failure: null },
  });
  expect(mobileRowState(held, NOW).key).toBe("held");
  expect(mobileRowState(held, NOW).held).toBe(2);
  expect(mobileRowState(working(base), NOW).key).toBe("working");
  expect(mobileRowState(entry({ ...base, activity: "recent" }), NOW).key).toBe("returned");
  expect(mobileRowState(entry(base), NOW).key).toBe("done");
});

test("a row that needs the operator carries the edge and the badge; the rest carry neither", () => {
  const asked = mobileRowState(question({ path: "/p/q.jsonl" }), NOW);
  expect(asked).toMatchObject({ section: "needs", edge: "warning", badge: "question" });
  expect(Math.round(asked.seconds ?? 0)).toBe(540);
  expect(mobileRowState(question({ path: "/p/plan.jsonl" }, "plan"), NOW).badge).toBe("plan");
  const stalled = mobileRowState(question({ path: "/p/s.jsonl", activity: "stalled", mtime: NOW - 900 }), NOW);
  expect(stalled).toMatchObject({ section: "needs", edge: "danger", badge: "stalled" });
  const run = mobileRowState(working({ path: "/p/w.jsonl" }), NOW);
  expect(run).toMatchObject({ section: "working", edge: null, badge: null, dot: "success" });
  expect(Math.round(run.seconds ?? 0)).toBe(760);
});

test("the sections group by state, the seat is never a row, and Recent is capped at three", () => {
  const files = [
    working({ path: "/p/seat.jsonl", title: "Orchestrator" }),
    question({ path: "/p/ask.jsonl", title: "Implement the export endpoint" }),
    working({ path: "/p/run.jsonl", title: "Rebuild the board status projection" }),
    working({ path: "/p/run2.jsonl", title: "Fix the flaky reseat test" }),
    entry({ path: "/p/r1.jsonl", activity: "recent", mtime: NOW - 100 }),
    entry({ path: "/p/r2.jsonl", activity: "recent", mtime: NOW - 200 }),
    entry({ path: "/p/r3.jsonl", mtime: NOW - 300 }),
    entry({ path: "/p/r4.jsonl", mtime: NOW - 400 }),
    entry({ path: "/p/other.jsonl", project: "beacon", activity: "live" }),
    entry({ path: "/p/shell.log", engine: "shell", kind: "task", activity: "live", proc: "running", pid: 41_822 }),
  ];
  const model = buildMobileBoard({ files, pipelines: [], project: PROJECT, seatPath: "/p/seat.jsonl", now: NOW });

  const paths = (rows: { path: string }[]) => rows.map((row) => row.path);
  expect(model.needsYou.map((item) => (item.kind === "conversation" ? item.path : item.id))).toEqual(["/p/ask.jsonl"]);
  expect(paths(model.working)).toEqual(["/p/run.jsonl", "/p/run2.jsonl"]);
  /* The seat sits in the card above the sections; another project and a
     background process are not board rows at all. */
  expect([...paths(model.working), ...paths(model.recent)]).not.toContain("/p/seat.jsonl");
  expect([...paths(model.working), ...paths(model.recent)]).not.toContain("/p/other.jsonl");
  expect([...paths(model.working), ...paths(model.recent)]).not.toContain("/p/shell.log");
  /* Freshest first, three rows, and the total the catalog row names. */
  expect(paths(model.recent)).toEqual(["/p/r1.jsonl", "/p/r2.jsonl", "/p/r3.jsonl"]);
  expect(model.recent).toHaveLength(RECENT_CAP);
  expect(model.recentTotal).toBe(4);
});

test("the queue reads in the attention queue's own order, not merely oldest first", () => {
  /* README §4.6: the rows, the bar's badge and the sheet's «Next ›» are one
     queue, so the board cannot invent a second order. `buildAttentionQueue`
     ranks the hard-blocked segment ahead of the stalled tail and sorts by age
     only inside each — here the stalled row is by far the oldest signal and
     still reads second. */
  const asked = question({ path: "/p/ask.jsonl", title: "Implement the export endpoint" });
  const stalled = working({ path: "/p/stalled.jsonl", title: "Fix the flaky reseat test", activity: "stalled", mtime: NOW - 5_400 });
  const older = question({ path: "/p/plan.jsonl", title: "Migrate accounts to the new binding" }, "plan");
  older.pendingQuestion!.askedAt = new Date((NOW - 1_500) * 1_000).toISOString();

  const model = buildMobileBoard({ files: [asked, stalled, older], pipelines: [], project: PROJECT, now: NOW });
  expect(model.needsYou.map((item) => (item.kind === "conversation" ? item.path : item.id)))
    .toEqual(["/p/plan.jsonl", "/p/ask.jsonl", "/p/stalled.jsonl"]);
  /* The stalled row is the oldest of the three, so an age-only order would
     have led with it. */
  expect(mobileRowState(stalled, NOW).seconds).toBeGreaterThan(mobileRowState(older, NOW).seconds ?? 0);
});

test("a closed card and an archived conversation leave the board; a crowned one wears its mark", () => {
  const files = [
    working({ path: "/p/run.jsonl" }),
    working({ path: "/p/closed.jsonl" }),
    entry({ path: "/p/archived.jsonl", activity: "recent" }),
  ];
  const model = buildMobileBoard({
    files,
    pipelines: [],
    project: PROJECT,
    hidden: new Set(["/p/closed.jsonl"]),
    archived: new Set(["/p/archived.jsonl"]),
    crowned: new Set(["/p/run.jsonl"]),
    now: NOW,
  });
  expect(model.working.map((row) => row.path)).toEqual(["/p/run.jsonl"]);
  expect(model.working[0]!.crowned).toBe(true);
  expect(model.recent).toEqual([]);
});

test("a pipeline waiting on a decision is a queue row beside the conversations, and the badge counts both", () => {
  const needs = pipeline({
    id: "pipeline_atlas_p2",
    task: "Fast conversation switching",
    state: "needs_decision",
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    runs: [{
      stageId: "review",
      attempts: [{
        n: 3,
        state: "failed",
        verdict: { status: "fail", findings: ["remount drops the feed cache", "the switch is 640 ms against a 200 ms bar"] },
        completedAt: new Date((NOW - 3_600) * 1_000).toISOString(),
      }],
    }] as unknown as Pipeline["runs"],
  });
  const model = buildMobileBoard({
    files: [question({ path: "/p/ask.jsonl" })],
    pipelines: [needs, pipeline({ id: "pipeline_atlas_p1", state: "running" })],
    project: PROJECT,
    now: NOW,
  });

  expect(model.needsYou).toHaveLength(2);
  const row = model.needsYou.find((item) => item.kind === "pipeline");
  expect(row).toBeDefined();
  /* `stage k/n · <stage> · <state>`: the failing round is what put the row in
     the queue, and the badge's «needs a decision» does not say it. */
  /* Read before the matcher below: `toMatchObject` rewrites the fields it
     matched on the received object. The stage travels as the pipeline declared
     it, so the row can name it in the operator's words (`stageChipLabel`)
     instead of printing an id. */
  expect((row as { stageRef: { id: string } | null }).stageRef?.id).toBe("review");
  expect(row).toMatchObject({ id: "pipeline_atlas_p2", task: "Fast conversation switching", stage: 3, total: 3, stageFailed: true, findings: 2 });
  expect(Math.round((row as { seconds: number }).seconds)).toBe(3_600);
  /* One count for the bar's badge and the queue's rows: conversations first,
     pipelines after, both reachable from the same list. */
  expect(model.attentionCount).toBe(model.needsYou.length);
  expect(model.pipelines).toEqual({ total: 2, active: 1, needsDecision: 1, completed: 0 });

  /* A round that asked for the operator rather than failing says nothing extra:
     the badge already carries that word. */
  const asking = pipeline({
    id: "pipeline_atlas_p4",
    state: "needs_decision",
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "needs_decision", verdict: { status: "needs_decision", findings: [] }, completedAt: new Date((NOW - 600) * 1_000).toISOString() }] }] as unknown as Pipeline["runs"],
  });
  const undecided = buildMobileBoard({ files: [], pipelines: [asking], project: PROJECT, now: NOW });
  expect(undecided.needsYou[0]).toMatchObject({ kind: "pipeline", stageFailed: false, findings: 0 });
});

test("the pipelines summary rises above Working while a pipeline is active, and sinks below it when none is", () => {
  const files = [working({ path: "/p/run.jsonl" })];
  const active = buildMobileBoard({ files, pipelines: [pipeline({ id: "p1", state: "running" })], project: PROJECT, now: NOW });
  expect(active.pipelinesFirst).toBe(true);
  const quiet = buildMobileBoard({ files, pipelines: [pipeline({ id: "p1", state: "completed" })], project: PROJECT, now: NOW });
  expect(quiet.pipelinesFirst).toBe(false);
  expect(quiet.pipelines).toEqual({ total: 1, active: 0, needsDecision: 0, completed: 1 });
  /* A closed lane is off the board entirely, so it cannot inflate the summary. */
  const closed = buildMobileBoard({ files, pipelines: [pipeline({ id: "p1", state: "closed" })], project: PROJECT, now: NOW });
  expect(closed.pipelines).toBeNull();
});

test("the now-fragment is the agent's own current step, and only a working row shows one", () => {
  const plan = working({
    path: "/p/run.jsonl",
    plan: { steps: [], done: 2, total: 5, current: "Rebuild the status projection", updatedAt: null },
  });
  expect(nowFragment(plan)).toBe("Rebuild the status projection");
  /* No plan: the goal the agent declared, while it is still the live one. */
  const goal = working({ path: "/p/goal.jsonl", goal: { objective: "Ship the export endpoint", status: "active", tokensUsed: null, timeUsedSeconds: null } });
  expect(nowFragment(goal)).toBe("Ship the export endpoint");
  expect(nowFragment(working({ path: "/p/quiet.jsonl", goal: { objective: "Old work", status: "complete", tokensUsed: null, timeUsedSeconds: null } }))).toBeNull();
  expect(nowFragment(working({ path: "/p/none.jsonl" }))).toBeNull();

  const model = buildMobileBoard({ files: [plan, entry({ path: "/p/done.jsonl", plan: { steps: [], done: 5, total: 5, current: "Old step", updatedAt: null } })], pipelines: [], project: PROJECT, now: NOW });
  expect(model.working[0]!.now).toBe("Rebuild the status projection");
  expect(model.recent[0]!.now).toBeNull();
});
