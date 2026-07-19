import { describe, expect, test } from "bun:test";

import type { Flow, FlowState, ReviewVerdict, Round } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { AssignmentState, BoardTask, TaskStatus } from "@/lib/tasks/types";

import {
  READINESS_ORDER,
  buildReadinessIndex,
  issueRefs,
  partitionReadiness,
  taskReadiness,
  type Readiness,
} from "./taskReadiness";

let sequence = 0;

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  sequence += 1;
  return {
    id: `task-${sequence}`,
    project: "demo",
    status: "inbox",
    text: "A durable card",
    placement: "pinned",
    pos: { x: 100, y: 100 },
    assignments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as BoardTask;
}

function assignment(state: AssignmentState, overrides: Partial<BoardTask["assignments"][number]> = {}) {
  return {
    path: null,
    panePid: null,
    state,
    error: null,
    at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function pipeline(overrides: Partial<Pipeline> & { attempts?: Array<Partial<PipelineStageAttempt>> } = {}): Pipeline {
  const { attempts, ...rest } = overrides;
  sequence += 1;
  return {
    id: `pipe-${sequence}`,
    task: "t",
    project: "demo",
    repoDir: "/repo",
    worktreeDir: "/wt",
    branch: "b",
    baseBranch: "main",
    baseRef: "r",
    lastPassedCommit: "",
    stages: [{ id: "s1", kind: "run", prompt: "p", next: null, effectiveRole: {} as Pipeline["stages"][number]["effectiveRole"] }],
    runs: [
      {
        stageId: "s1",
        attempts: (attempts ?? [{}]).map((attempt, n) => ({
          n: n + 1,
          state: "running",
          effectiveRole: {} as PipelineStageAttempt["effectiveRole"],
          launchId: null,
          conversationId: null,
          sessionId: null,
          agentPath: null,
          paneId: null,
          flowId: null,
          startedAt: null,
          completedAt: null,
          output: null,
          verdict: null,
          error: null,
          ...attempt,
        })),
      },
    ],
    cursor: null,
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    closedAt: null,
    ...rest,
  } as Pipeline;
}

function flow(overrides: Partial<Flow> & { verdicts?: Array<ReviewVerdict | null> } = {}): Flow {
  const { verdicts, ...rest } = overrides;
  sequence += 1;
  const rounds: Round[] = (verdicts ?? []).map((verdict, n) => ({
    n: n + 1,
    reviewerPath: null,
    findingsPath: null,
    triggeredBy: "marker",
    readyNote: null,
    verdict,
    findingsCount: null,
    startedAt: "2026-07-01T00:00:00.000Z",
    reviewedAt: null,
    relayedAt: null,
    error: null,
  }));
  return {
    id: `flow-${sequence}`,
    template: "implement-review-loop",
    project: "demo",
    cwd: "/repo",
    implementerPath: `/tmp/flow-${sequence}.jsonl`,
    roles: {
      implementer: { engine: "claude", model: null, effort: null },
      reviewer: { engine: "claude", model: null, effort: null },
    },
    baseRef: "r",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds,
    createdAt: "2026-07-01T00:00:00.000Z",
    closedAt: null,
    ...rest,
  } as Flow;
}

const emptyIndex = () => buildReadinessIndex([], []);

describe("rule precedence and positive signals", () => {
  test("done always wins, even over failed assignments and needs_decision links", () => {
    const linked = pipeline({ state: "needs_decision", attempts: [{ agentPath: "/tmp/a.jsonl" }] });
    const index = buildReadinessIndex([linked], []);
    const item = task({ status: "done", assignments: [assignment("failed", { path: "/tmp/a.jsonl" })] });
    expect(taskReadiness(item, index)).toBe("done");
  });

  test("blocked: durable status, failed delivery, and needs_decision links each suffice", () => {
    expect(taskReadiness(task({ status: "blocked" }), emptyIndex())).toBe("blocked");
    expect(taskReadiness(task({ status: "assigned", assignments: [assignment("failed")] }), emptyIndex())).toBe("blocked");
    const stuckPipeline = pipeline({ state: "needs_decision", attempts: [{ agentPath: "/tmp/p.jsonl" }] });
    expect(
      taskReadiness(
        task({ status: "assigned", assignments: [assignment("delivered", { path: "/tmp/p.jsonl" })] }),
        buildReadinessIndex([stuckPipeline], []),
      ),
    ).toBe("blocked");
    const stuckFlow = flow({ state: "needs_decision" });
    expect(
      taskReadiness(
        task({ status: "assigned", assignments: [assignment("delivered", { path: stuckFlow.implementerPath })] }),
        buildReadinessIndex([], [stuckFlow]),
      ),
    ).toBe("blocked");
  });

  test("blocked outranks review on the same links", () => {
    const reviewing = flow({ state: "reviewing" });
    const stuck = pipeline({ state: "needs_decision", attempts: [{ agentPath: "/tmp/x.jsonl" }] });
    const item = task({
      status: "assigned",
      assignments: [assignment("delivered", { path: reviewing.implementerPath }), assignment("delivered", { path: "/tmp/x.jsonl" })],
    });
    expect(taskReadiness(item, buildReadinessIndex([stuck], [reviewing]))).toBe("blocked");
  });

  test("review: reviewing cursor, completed pipeline, terminal pass verdict, review-cycle flow states, APPROVE evidence", () => {
    const cases: Array<{ pipelines?: Pipeline[]; flows?: Flow[]; path: string }> = [
      { pipelines: [pipeline({ cursor: { stageId: "s1", state: "reviewing", input: null, activatedBy: null }, attempts: [{ agentPath: "/tmp/r1.jsonl" }] })], path: "/tmp/r1.jsonl" },
      { pipelines: [pipeline({ state: "completed", attempts: [{ agentPath: "/tmp/r2.jsonl" }] })], path: "/tmp/r2.jsonl" },
      {
        pipelines: [pipeline({ attempts: [{ agentPath: "/tmp/r3.jsonl", state: "passed", verdict: { status: "pass" } }] })],
        path: "/tmp/r3.jsonl",
      },
      ...(["reviewing", "relay_pending", "relaying", "fixing", "approved", "done_comment"] as FlowState[]).map((state) => {
        const linked = flow({ state, implementerPath: `/tmp/f-${state}.jsonl` });
        return { flows: [linked], path: linked.implementerPath };
      }),
      { flows: [flow({ state: "closed", verdicts: ["REQUEST_CHANGES", "APPROVE"], implementerPath: "/tmp/f-ev.jsonl" })], path: "/tmp/f-ev.jsonl" },
    ];
    for (const { pipelines = [], flows = [], path } of cases) {
      const item = task({ status: "assigned", assignments: [assignment("delivered", { path })] });
      expect(taskReadiness(item, buildReadinessIndex(pipelines, flows))).toBe("review");
    }
  });

  test("a terminal fail verdict or an unfinished last stage is not review", () => {
    const failed = pipeline({ attempts: [{ agentPath: "/tmp/pf.jsonl", state: "failed", verdict: { status: "fail" } }] });
    const item = task({ status: "assigned", assignments: [assignment("delivered", { path: "/tmp/pf.jsonl" })] });
    expect(taskReadiness(item, buildReadinessIndex([failed], []))).toBe("now");
  });

  test("paused containers are deliberate operator state — status rules win", () => {
    const pausedFlow = flow({ state: "paused", pausedState: "needs_decision", implementerPath: "/tmp/pause.jsonl" });
    const pausedPipeline = pipeline({ state: "paused", cursor: { stageId: "s1", state: "reviewing", input: null, activatedBy: null }, attempts: [{ agentPath: "/tmp/pp.jsonl" }] });
    const index = buildReadinessIndex([pausedPipeline], [pausedFlow]);
    expect(taskReadiness(task({ status: "assigned", assignments: [assignment("delivered", { path: "/tmp/pause.jsonl" })] }), index)).toBe("now");
    expect(taskReadiness(task({ status: "inbox", assignments: [assignment("handoff", { path: "/tmp/pp.jsonl" })] }), index)).toBe("planned");
  });

  test("cross-project links never classify", () => {
    const foreign = flow({ state: "needs_decision", project: "other", implementerPath: "/tmp/foreign.jsonl" });
    const item = task({ status: "assigned", assignments: [assignment("delivered", { path: "/tmp/foreign.jsonl" })] });
    expect(taskReadiness(item, buildReadinessIndex([], [foreign]))).toBe("now");
  });

  test("now and planned fall out of durable status alone", () => {
    expect(taskReadiness(task({ status: "assigned" }), emptyIndex())).toBe("now");
    expect(taskReadiness(task({ status: "inbox" }), emptyIndex())).toBe("planned");
    expect(taskReadiness(task({ status: "inbox", placement: "unplaced", pos: undefined }), emptyIndex())).toBe("planned");
  });
});

describe("totality and exclusivity", () => {
  test("every status × assignment-state × linked-state cell lands in exactly one section", () => {
    const statuses: TaskStatus[] = ["inbox", "assigned", "blocked", "done"];
    const assignmentStates: Array<AssignmentState | null> = [null, "delivered", "failed", "spawning", "handoff"];
    const containers: Array<{ pipelines: Pipeline[]; flows: Flow[]; path: string | null }> = [
      { pipelines: [], flows: [], path: null },
      { pipelines: [pipeline({ cursor: { stageId: "s1", state: "reviewing", input: null, activatedBy: null }, attempts: [{ agentPath: "/tmp/m1.jsonl" }] })], flows: [], path: "/tmp/m1.jsonl" },
      { pipelines: [pipeline({ state: "needs_decision", attempts: [{ agentPath: "/tmp/m2.jsonl" }] })], flows: [], path: "/tmp/m2.jsonl" },
      { pipelines: [], flows: [flow({ state: "approved", implementerPath: "/tmp/m3.jsonl" })], path: "/tmp/m3.jsonl" },
      { pipelines: [], flows: [flow({ state: "needs_decision", implementerPath: "/tmp/m4.jsonl" })], path: "/tmp/m4.jsonl" },
      { pipelines: [], flows: [flow({ state: "paused", implementerPath: "/tmp/m5.jsonl" })], path: "/tmp/m5.jsonl" },
    ];
    const tasks: BoardTask[] = [];
    const allPipelines: Pipeline[] = [];
    const allFlows: Flow[] = [];
    for (const status of statuses) {
      for (const state of assignmentStates) {
        for (const container of containers) {
          allPipelines.push(...container.pipelines);
          allFlows.push(...container.flows);
          tasks.push(
            task({
              status,
              assignments: state
                ? [assignment(state, { path: container.path ?? undefined })]
                : [],
            }),
          );
        }
      }
    }
    const index = buildReadinessIndex(allPipelines, allFlows);
    const sections = partitionReadiness(tasks, index);
    expect(sections.map((section) => section.readiness)).toEqual([...READINESS_ORDER]);
    expect(sections.reduce((sum, section) => sum + section.items.length, 0)).toBe(tasks.length);
    const seen = new Set<string>();
    for (const section of sections) {
      for (const item of section.items) {
        expect(seen.has(item.id)).toBeFalse();
        seen.add(item.id);
      }
    }
    expect(seen.size).toBe(tasks.length);
  });

  test("all five sections are always present, zero counts included", () => {
    const sections = partitionReadiness([], emptyIndex());
    expect(sections.map((section) => section.readiness)).toEqual(["now", "review", "blocked", "planned", "done"]);
    expect(sections.every((section) => section.items.length === 0)).toBeTrue();
  });
});

describe("alias remap", () => {
  test("an old conversation id plus the alias map links the pipeline identically pre/post remap", () => {
    const item = task({ status: "assigned", assignments: [assignment("delivered", { conversationId: "conversation_old" })] });
    /* Pre-remap: the durable stores still carry the provisional id everywhere. */
    const prePipeline = pipeline({ cursor: { stageId: "s1", state: "reviewing", input: null, activatedBy: null }, attempts: [{ conversationId: "conversation_old" }] });
    const pre = buildReadinessIndex([prePipeline], []);
    /* Post-remap: the registry canonicalized the pipeline side; the task's
       assignment still says conversation_old and resolves through the alias. */
    const postPipeline = pipeline({ cursor: { stageId: "s1", state: "reviewing", input: null, activatedBy: null }, attempts: [{ conversationId: "conversation_new" }] });
    const post = buildReadinessIndex([postPipeline], [], { conversation_old: "conversation_new" });
    expect(taskReadiness(item, pre)).toBe("review");
    expect(taskReadiness(item, post)).toBe("review");
  });

  test("aliases apply on the index-build side too", () => {
    const linked = pipeline({ cursor: { stageId: "s1", state: "reviewing", input: null, activatedBy: null }, attempts: [{ conversationId: "conversation_old" }] });
    const index = buildReadinessIndex([linked], [], { conversation_old: "conversation_new" });
    const item = task({ status: "assigned", assignments: [assignment("delivered", { conversationId: "conversation_new" })] });
    expect(taskReadiness(item, index)).toBe("review");
  });
});

describe("deleted worktrees and determinism", () => {
  test("a vanished transcript never moves the column or the counts", () => {
    const reviewing = flow({ state: "reviewing", implementerPath: "/tmp/still-there.jsonl" });
    const index = buildReadinessIndex([], [reviewing]);
    const items = [
      task({ status: "assigned", assignments: [assignment("delivered", { path: "/tmp/still-there.jsonl" })] }),
      task({ status: "assigned", assignments: [assignment("delivered", { path: "/tmp/deleted-worktree.jsonl" })] }),
      task({ status: "blocked", assignments: [assignment("handoff", { path: "/tmp/deleted-worktree.jsonl" })] }),
    ];
    /* Classification takes NO file-scan input — a deleted worktree can only
       change chip decorations, never membership. */
    const sections = partitionReadiness(items, index);
    expect(sections.find((section) => section.readiness === "review")!.items.map((item) => item.id)).toEqual([items[0]!.id]);
    expect(sections.find((section) => section.readiness === "now")!.items.map((item) => item.id)).toEqual([items[1]!.id]);
    expect(sections.find((section) => section.readiness === "blocked")!.items.map((item) => item.id)).toEqual([items[2]!.id]);
  });

  test("identical snapshots partition deep-equally, including sort ties", () => {
    const shared = { updatedAt: "2026-07-02T00:00:00.000Z" };
    const tasks = [
      task({ id: "b-tie", status: "inbox", ...shared }),
      task({ id: "a-tie", status: "inbox", ...shared }),
      task({ id: "z-newer", status: "inbox", updatedAt: "2026-07-03T00:00:00.000Z" }),
      task({ id: "done-1", status: "done" }),
    ];
    const first = partitionReadiness(tasks, emptyIndex());
    const second = partitionReadiness([...tasks], emptyIndex());
    expect(second).toEqual(first);
    expect(first.find((section) => section.readiness === "planned")!.items.map((item) => item.id)).toEqual([
      "z-newer",
      "a-tie",
      "b-tie",
    ]);
  });
});

describe("issueRefs", () => {
  test("extracts #NNN, dedupes, sorts ascending, and excludes PR#165 and path/#1 forms", () => {
    expect(issueRefs("Implement issue #290 as production UI")).toEqual([290]);
    expect(issueRefs("#325 depends on #289 and #325 again")).toEqual([289, 325]);
    expect(issueRefs("merged PR#165 but tracked in #12")).toEqual([12]);
    expect(issueRefs("see docs/path/#1 anchor")).toEqual([]);
    expect(issueRefs("no refs here")).toEqual([]);
    expect(issueRefs("#0007 pads to 7")).toEqual([7]);
  });
});

describe("readiness order", () => {
  test("the section order is the spec order", () => {
    const order: readonly Readiness[] = READINESS_ORDER;
    expect(order).toEqual(["now", "review", "blocked", "planned", "done"]);
  });
});
