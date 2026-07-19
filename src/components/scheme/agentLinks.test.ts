import { describe, expect, test } from "bun:test";

import type { Flow, FlowState, Round } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { resolvePipelineMemberPaths } from "@/components/pipelines/pipelineModel";

import { buildAnchorIndex, currentRound, deckKey, deriveFlowLinks, deriveGroups, derivePipelineLinks, flowLinkKey, flowLinkPhase, groupRect, hueFromId, pipelineRailSegment } from "./agentLinks";
import type { SchemeRect } from "./layout";

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function round(overrides: Partial<Round> & { n: number }): Round {
  return {
    reviewerPath: null,
    findingsPath: null,
    triggeredBy: "marker",
    readyNote: null,
    verdict: null,
    findingsCount: null,
    startedAt: "2026-07-05T00:00:00Z",
    reviewedAt: null,
    relayedAt: null,
    error: null,
    ...overrides,
  };
}

function flow(overrides: Partial<Flow> & { id: string; implementerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    project: "demo",
    cwd: "/tmp",
    roles: { implementer: roleConfig, reviewer: roleConfig },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [round({ n: 1, reviewerPath: "/reviewer-1" })],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

describe("flowLinkPhase", () => {
  const cases: [FlowState, ReturnType<typeof flowLinkPhase>][] = [
    ["waiting_ready", "waiting"],
    ["spawn_pending", "attention"],
    ["spawning", "running"],
    ["reviewing", "awaiting_verdict"],
    ["relay_pending", "attention"],
    ["relaying", "running"],
    ["fixing", "running"],
    ["approved", "done"],
    ["done_comment", "attention"],
    ["needs_decision", "attention"],
    ["paused", "paused"],
    ["closed", "done"],
  ];
  test.each(cases)("%s → %s", (state, phase) => {
    expect(flowLinkPhase(state)).toBe(phase);
  });
});

test("pipeline links connect adjacent resolved stage sessions", () => {
  const pipeline = {
    id: "pipeline-1",
    state: "running",
    stages: [
      { id: "plan", kind: "run", role: { roleId: "architect" }, engine: "codex", prompt: "plan", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "build", next: null },
    ],
    runs: [
      { stageId: "plan", attempts: [{ agentPath: "/plan" }] },
      { stageId: "build", attempts: [{ agentPath: "/build" }] },
    ],
  } as unknown as Pipeline;
  const links = derivePipelineLinks([pipeline], (key) => key === "/plan" || key === "/build" ? key : null);
  expect(links).toMatchObject([{
    kind: "pipeline",
    from: "/plan",
    to: "/build",
    pipeline: { fromStageId: "plan", toStageId: "build" },
  }]);
  expect(derivePipelineLinks([pipeline], (key) => key === "/plan" ? key : null)).toEqual([]);
});

function threeStagePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "pipeline-2",
    state: "running",
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    stages: [
      { id: "plan", kind: "run", next: "build" },
      { id: "build", kind: "run", next: "verify" },
      { id: "verify", kind: "run", next: null },
    ],
    runs: [
      { stageId: "plan", attempts: [{ agentPath: "/plan", state: "passed", verdict: { status: "pass" } }] },
      { stageId: "build", attempts: [{ agentPath: "/build", state: "running" }] },
      { stageId: "verify", attempts: [{ agentPath: "/verify", state: "pending" }] },
    ],
    ...overrides,
  } as unknown as Pipeline;
}

describe("derivePipelineLinks tones and hub", () => {
  const anchor = (key: string) => (["/plan", "/build", "/verify"].includes(key) ? key : null);

  test("each edge is toned by its target stage's latest attempt", () => {
    const links = derivePipelineLinks([threeStagePipeline()], anchor);
    expect(links.map((link) => [link.pipeline!.toStageId, link.pipeline!.tone])).toEqual([
      ["build", "active"],
      ["verify", "dim"],
    ]);
  });

  test("exactly one edge — the one into the current stage — carries the hub", () => {
    const links = derivePipelineLinks([threeStagePipeline()], anchor);
    expect(links.filter((link) => link.pipeline!.hub).map((link) => link.pipeline!.toStageId)).toEqual(["build"]);
  });

  test("a parked stage tones its incoming edge amber, reserving red for chips", () => {
    const parked = threeStagePipeline({
      state: "needs_decision",
      cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
      runs: [
        { stageId: "plan", attempts: [{ agentPath: "/plan", state: "passed" }] },
        { stageId: "build", attempts: [{ agentPath: "/build", state: "needs_decision" }] },
        { stageId: "verify", attempts: [{ agentPath: "/verify", state: "pending" }] },
      ],
    } as unknown as Partial<Pipeline>);
    const edge = derivePipelineLinks([parked], anchor).find((link) => link.pipeline!.toStageId === "build");
    expect(edge?.pipeline!.tone).toBe("amber");
  });

  test("pausing mid-run keeps the active tone but freezes the chevron drift", () => {
    /* pausedState carries the pre-pause busy state, so the cursor edge stays
       active; the paused flag freezes the animation (nodes.tsx gates on it). */
    const links = derivePipelineLinks([threeStagePipeline({ state: "paused", pausedState: "running" })], anchor);
    expect(links.every((link) => link.pipeline!.paused)).toBe(true);
    const build = links.find((link) => link.pipeline!.toStageId === "build");
    expect(build?.pipeline!.tone).toBe("active");
  });

  test("a pause with no busy pre-state leaves the edge un-animated", () => {
    /* pausedState null (paused while idle/pending) must not fabricate motion. */
    const links = derivePipelineLinks([threeStagePipeline({ state: "paused", pausedState: null })], anchor);
    expect(links.some((link) => link.pipeline!.tone === "active")).toBe(false);
  });

  test("a partially spawned chain draws only its materialized prefix", () => {
    const partial = threeStagePipeline({
      runs: [
        { stageId: "plan", attempts: [{ agentPath: "/plan", state: "passed" }] },
        { stageId: "build", attempts: [] },
        { stageId: "verify", attempts: [] },
      ],
    } as unknown as Partial<Pipeline>);
    expect(derivePipelineLinks([partial], anchor)).toEqual([]);
  });
});

describe("derivePipelineLinks review-loop vertices (no duplicate hub on the flow deck)", () => {
  /* build (run) → review (review-loop) → verify (run). The review attempt's
     agentPath is the reviewer transcript, which the board folds into flow
     f-rev's deck; the flow's implementer is the build node. */
  const reviewPipeline = {
    id: "p-rev",
    state: "running",
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    stages: [
      { id: "build", kind: "run", next: "review" },
      { id: "review", kind: "review-loop", next: "verify" },
      { id: "verify", kind: "run", next: null },
    ],
    runs: [
      { stageId: "build", attempts: [{ agentPath: "/build", state: "passed" }] },
      { stageId: "review", attempts: [{ agentPath: "/reviewer", flowId: "f-rev", state: "reviewing" }] },
      { stageId: "verify", attempts: [{ agentPath: "/verify", state: "pending" }] },
    ],
  } as unknown as Pipeline;
  /* The reviewer path resolves to the deck; build/verify to their nodes. */
  const anchor = (key: string) =>
    key === "/build" || key === "/verify" ? key : key === "/reviewer" || key === deckKey("f-rev") ? deckKey("f-rev") : null;
  const flowImpl = (flowId: string) => (flowId === "f-rev" ? "/build" : null);

  test("the review-loop's incoming edge collapses into the implementer node, never the deck", () => {
    const links = derivePipelineLinks([reviewPipeline], anchor, flowImpl);
    /* build→review suppressed (both resolve to /build); the rail resumes from the
       implementer node to verify. No endpoint is ever the flow deck. */
    expect(links.map((link) => [link.from, link.to, link.pipeline!.toStageId])).toEqual([["/build", "/verify", "verify"]]);
    expect(links.some((link) => link.from === deckKey("f-rev") || link.to === deckKey("f-rev"))).toBe(false);
  });

  test("exactly one hub is placed, clear of the flow deck", () => {
    const links = derivePipelineLinks([reviewPipeline], anchor, flowImpl);
    const hubs = links.filter((link) => link.pipeline!.hub);
    expect(hubs.length).toBe(1);
    expect(hubs.every((link) => link.to !== deckKey("f-rev"))).toBe(true);
  });

  test("without a flow resolver a review-loop stage anchors nowhere (its edge is skipped)", () => {
    /* Defaulting the resolver to null (older callers) must not fall back to the
       reviewer path — the review vertex is simply unresolved and skipped. */
    const links = derivePipelineLinks([reviewPipeline], anchor);
    expect(links.some((link) => link.to === deckKey("f-rev"))).toBe(false);
  });

  test("a 2-stage build→review whose only edge collapses still keeps a control hub (AC6)", () => {
    /* build (run) → review (review-loop): the single edge folds into the
       implementer, leaving no drawn rail. An anchor-only hub must still be
       emitted on the implementer node so the pipeline keeps board controls. */
    const twoStage = {
      id: "p2", state: "running", cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
      stages: [
        { id: "build", kind: "run", next: "review" },
        { id: "review", kind: "review-loop", next: null },
      ],
      runs: [
        { stageId: "build", attempts: [{ agentPath: "/build", state: "passed" }] },
        { stageId: "review", attempts: [{ agentPath: "/reviewer", flowId: "f-rev", state: "reviewing" }] },
      ],
    } as unknown as Pipeline;
    const links = derivePipelineLinks([twoStage], anchor, flowImpl);
    expect(links.length).toBe(1);
    const hub = links[0]!;
    expect(hub.pipeline!.hub).toBe(true);
    expect(hub.pipeline!.anchorOnly).toBe(true);
    /* Anchored on the implementer node, never the flow deck. */
    expect([hub.from, hub.to]).toEqual(["/build", "/build"]);
    expect(hub.from === deckKey("f-rev") || hub.to === deckKey("f-rev")).toBe(false);
  });

  test("a chain still spawning (only one stage materialized) draws nothing", () => {
    /* No adjacent pair exists yet, so nothing collapsed — no anchor hub, matching
       the prior behavior for a partially spawned chain. */
    const spawning = {
      id: "p3", state: "provisioning", cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
      stages: [
        { id: "build", kind: "run", next: "review" },
        { id: "review", kind: "review-loop", next: null },
      ],
      runs: [{ stageId: "build", attempts: [{ agentPath: "/build", state: "running" }] }],
    } as unknown as Pipeline;
    expect(derivePipelineLinks([spawning], anchor, flowImpl)).toEqual([]);
  });
});

describe("pipelineRailSegment", () => {
  const from: SchemeRect = { x: 0, y: 0, w: 100, h: 60 };
  const to: SchemeRect = { x: 300, y: 0, w: 100, h: 60 };

  test("connects facing edges along the dominant axis with an off-center offset", () => {
    const seg = pipelineRailSegment(from, to);
    /* Horizontal handoff: leaves from's right edge, enters to's left edge. */
    expect(seg.x1).toBe(100);
    expect(seg.x2).toBe(300);
    /* Both endpoints share the 14px vertical offset so the rail clears the bezier. */
    expect(seg.y1).toBe(44);
    expect(seg.y2).toBe(44);
  });

  test("emits repeating chevron marks pointing along the handoff", () => {
    const seg = pipelineRailSegment(from, to);
    expect(seg.chevrons.length).toBeGreaterThan(1);
    expect(seg.chevrons.every((mark) => mark.startsWith("M "))).toBe(true);
  });
});

describe("buildAnchorIndex", () => {
  test("resolves nodes to themselves, deck-claimed reviewers to their deck, stack items to their stack", () => {
    const f = flow({ id: "f1", implementerPath: "/impl" });
    const index = buildAnchorIndex(
      ["/impl"],
      [{ key: deckKey("f1"), flow: f }],
      [{ key: "/impl::stack", paths: ["/quiet-branch"] }],
    );
    expect(index.get("/impl")).toBe("/impl");
    expect(index.get("/reviewer-1")).toBe(deckKey("f1"));
    expect(index.get("/quiet-branch")).toBe("/impl::stack");
    expect(index.get("/somewhere-else")).toBeUndefined();
  });

  test("deck keys self-resolve so a roundless flow can still link to its deck placeholder", () => {
    const f = flow({ id: "f1", implementerPath: "/impl", rounds: [] });
    const index = buildAnchorIndex([], [{ key: deckKey("f1"), flow: f }], []);
    expect(index.get(deckKey("f1"))).toBe(deckKey("f1"));
  });

  test("a full node wins over a stack or deck claim of the same path", () => {
    const f = flow({ id: "f1", implementerPath: "/impl" });
    const index = buildAnchorIndex(
      ["/reviewer-1"],
      [{ key: deckKey("f1"), flow: f }],
      [{ key: "/impl::stack", paths: ["/reviewer-1"] }],
    );
    expect(index.get("/reviewer-1")).toBe("/reviewer-1");
  });
});

describe("deriveFlowLinks", () => {
  const anchorsFor = (flows: Flow[], nodePaths: string[] = ["/impl"]) => {
    const index = buildAnchorIndex(
      nodePaths,
      flows.map((f) => ({ key: deckKey(f.id), flow: f })),
      [],
    );
    return (key: string) => index.get(key) ?? null;
  };

  test("an active flow links its implementer node to the deck claiming the current reviewer", () => {
    const f = flow({ id: "f1", implementerPath: "/impl" });
    const links = deriveFlowLinks([f], anchorsFor([f]));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      key: flowLinkKey("f1"),
      kind: "flow",
      from: "/impl",
      to: deckKey("f1"),
      leg: "forward",
    });
    expect(links[0]!.flow).toMatchObject({ round: 1, phase: "awaiting_verdict" });
  });

  test("a round without a transcript yet falls back to the deck placeholder", () => {
    const f = flow({ id: "f1", implementerPath: "/impl", state: "spawning", rounds: [round({ n: 2 })] });
    const links = deriveFlowLinks([f], anchorsFor([f]));
    expect(links[0]!.to).toBe(deckKey("f1"));
    expect(links[0]!.flow).toMatchObject({ round: 2, phase: "running" });
  });

  test("a reviewer visible as its own full node links directly to that node", () => {
    const f = flow({ id: "f1", implementerPath: "/impl" });
    const links = deriveFlowLinks([f], anchorsFor([f], ["/impl", "/reviewer-1"]));
    expect(links[0]!.to).toBe("/reviewer-1");
  });

  test("relay traffic reports the back leg", () => {
    const f = flow({ id: "f1", implementerPath: "/impl", state: "fixing" });
    const links = deriveFlowLinks([f], anchorsFor([f]));
    expect(links[0]!.leg).toBe("back");
    expect(links[0]!.flow!.phase).toBe("running");
  });

  test("a flow with no rounds yet reports round 0 and links to its deck", () => {
    const f = flow({ id: "f1", implementerPath: "/impl", state: "waiting_ready", rounds: [] });
    const links = deriveFlowLinks([f], anchorsFor([f]));
    expect(links[0]!.to).toBe(deckKey("f1"));
    expect(links[0]!.flow).toMatchObject({ round: 0, phase: "waiting" });
    expect(links[0]!.leg).toBeNull();
  });

  test("closed flows emit nothing", () => {
    const f = flow({ id: "f1", implementerPath: "/impl", state: "closed", closedAt: "2026-07-06T00:00:00Z" });
    expect(deriveFlowLinks([f], anchorsFor([f]))).toHaveLength(0);
  });

  test("an implementer off the board emits nothing (conservative endpoints)", () => {
    const f = flow({ id: "f1", implementerPath: "/impl" });
    const links = deriveFlowLinks([f], anchorsFor([f], []));
    expect(links).toHaveLength(0);
  });

  test("an unresolved reviewer side emits nothing", () => {
    const f = flow({ id: "f1", implementerPath: "/impl" });
    /* No deck on the board and the reviewer transcript is unknown. */
    const index = buildAnchorIndex(["/impl"], [], []);
    expect(deriveFlowLinks([f], (key) => index.get(key) ?? null)).toHaveLength(0);
  });

  test("the newest active flow per implementer wins", () => {
    const older = flow({ id: "f1", implementerPath: "/impl", createdAt: "2026-07-01T00:00:00Z" });
    const newer = flow({ id: "f2", implementerPath: "/impl", createdAt: "2026-07-05T00:00:00Z" });
    const links = deriveFlowLinks([older, newer], anchorsFor([older, newer]));
    expect(links).toHaveLength(1);
    expect(links[0]!.key).toBe(flowLinkKey("f2"));
  });

  test("currentRound returns the last round", () => {
    const f = flow({ id: "f1", implementerPath: "/impl", rounds: [round({ n: 1 }), round({ n: 2 })] });
    expect(currentRound(f)!.n).toBe(2);
    expect(currentRound(flow({ id: "f2", implementerPath: "/impl", rounds: [] }))).toBeNull();
  });
});

describe("group overlay derivation (issue #118)", () => {
  test("hueFromId is deterministic, in range, and distinct per id", () => {
    expect(hueFromId("f1")).toBe(hueFromId("f1"));
    expect(hueFromId("f1")).toBeGreaterThanOrEqual(0);
    expect(hueFromId("f1")).toBeLessThan(360);
    expect(hueFromId("flow-a")).not.toBe(hueFromId("flow-b"));
  });

  test("groupRect unions member rects and pads, ignoring the unresolvable", () => {
    const rects = new Map<string, SchemeRect>([
      ["/a", { x: 100, y: 100, w: 200, h: 100 }],
      ["/b", { x: 400, y: 300, w: 200, h: 100 }],
    ]);
    const rect = groupRect(["/a", "/b", "/gone"], (key) => rects.get(key) ?? null, 10);
    expect(rect).toEqual({ x: 90, y: 90, w: 520, h: 320 });
    expect(groupRect(["/gone"], (key) => rects.get(key) ?? null, 10)).toBeNull();
  });

  test("a flow group encloses the implementer node and its round deck", () => {
    const f = flow({ id: "f1", implementerPath: "/impl", rounds: [round({ n: 1, reviewerPath: "/rev" })] });
    const index = buildAnchorIndex(["/impl"], [{ key: deckKey("f1"), flow: f }], []);
    const specs = deriveGroups([f], [], (key) => index.get(key) ?? null);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ kind: "flow", id: "f1" });
    expect([...specs[0]!.members].sort()).toEqual([deckKey("f1"), "/impl"].sort());
  });

  test("a pipeline group gathers every materialized stage vertex", () => {
    const pipeline = {
      id: "p1",
      state: "running",
      stages: [
        { id: "plan", kind: "run", next: "build" },
        { id: "build", kind: "run", next: null },
      ],
      runs: [
        { stageId: "plan", attempts: [{ agentPath: "/plan" }] },
        { stageId: "build", attempts: [{ agentPath: "/build" }] },
      ],
    } as unknown as Pipeline;
    const specs = deriveGroups([], [pipeline], (key) => (["/plan", "/build"].includes(key) ? key : null));
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ kind: "pipeline", id: "p1" });
    expect([...specs[0]!.members].sort()).toEqual(["/build", "/plan"]);
  });

  test("a retried stage keeps every materialized attempt node in the halo", () => {
    /* build was retried: attempt 1 (/build-1) still renders as a sibling node,
       attempt 2 (/build-2) is current. Both must stay inside the halo even though
       links/controls use only the latest. */
    const pipeline = {
      id: "p1",
      state: "running",
      stages: [{ id: "build", kind: "run", next: null }],
      runs: [
        { stageId: "build", attempts: [{ agentPath: "/build-1", state: "failed" }, { agentPath: "/build-2", state: "running" }] },
      ],
    } as unknown as Pipeline;
    const specs = deriveGroups([], [pipeline], (key) => (["/build-1", "/build-2"].includes(key) ? key : null));
    expect([...specs[0]!.members].sort()).toEqual(["/build-1", "/build-2"]);
  });

  test("a stage transcript rotated by an account migration stays inside its pipeline halo (#353)", () => {
    /* Production shape: the build attempt froze /old at launch; the conversation
       migrated onto /new ("Continued from «default»"), which is the only node the
       board draws. Without member-path resolution the halo loses the live
       generation and it renders as a detached standalone card. */
    const stale = {
      id: "p1",
      state: "running",
      stages: [
        { id: "plan", kind: "run", next: "build" },
        { id: "build", kind: "run", next: null },
      ],
      runs: [
        { stageId: "plan", attempts: [{ agentPath: "/plan", conversationId: null }] },
        { stageId: "build", attempts: [{ agentPath: "/old", conversationId: "c-build" }] },
      ],
    } as unknown as Pipeline;
    const files = [
      { path: "/old", conversationId: "c-build", migratedTo: "/new" },
      { path: "/new", conversationId: "c-build", predecessorPath: "/old" },
    ] as unknown as FileEntry[];
    const resolved = resolvePipelineMemberPaths([stale], files);
    const anchorOf = (key: string) => (["/plan", "/new"].includes(key) ? key : null);
    expect([...deriveGroups([], resolved, anchorOf)[0]!.members].sort()).toEqual(["/new", "/plan"]);
    /* The handoff rail reaches the successor node too — the "stage 2/3 shows one
       conversation" symptom came from this same frozen-path seam. */
    const links = derivePipelineLinks(resolved, anchorOf);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: "/plan", to: "/new" });
  });

  test("closed flows and pipelines produce no group (dissolves on close)", () => {
    const closedFlow = flow({ id: "f1", implementerPath: "/impl", state: "closed", closedAt: "2026-07-06T00:00:00Z" });
    const closedPipeline = { id: "p1", state: "closed", stages: [], runs: [] } as unknown as Pipeline;
    const index = buildAnchorIndex(["/impl"], [], []);
    expect(deriveGroups([closedFlow], [closedPipeline], (key) => index.get(key) ?? null)).toEqual([]);
  });

  test("a flow embedded in a pipeline is not drawn as its own group", () => {
    /* build (run) → review (review-loop, flow f-rev). The pipeline group owns
       the flow's implementer + deck, so f-rev has no standalone halo. */
    const f = flow({ id: "f-rev", implementerPath: "/build", rounds: [round({ n: 1, reviewerPath: "/reviewer" })] });
    const pipeline = {
      id: "p-rev",
      state: "running",
      stages: [
        { id: "build", kind: "run", next: "review" },
        { id: "review", kind: "review-loop", next: null },
      ],
      runs: [
        { stageId: "build", attempts: [{ agentPath: "/build", state: "passed" }] },
        { stageId: "review", attempts: [{ agentPath: "/reviewer", flowId: "f-rev", state: "reviewing" }] },
      ],
    } as unknown as Pipeline;
    const index = buildAnchorIndex(["/build"], [{ key: deckKey("f-rev"), flow: f }], []);
    const specs = deriveGroups([f], [pipeline], (key) => index.get(key) ?? null, () => "/build");
    expect(specs.map((spec) => spec.kind)).toEqual(["pipeline"]);
    /* The pipeline halo still encloses the folded reviewer deck. */
    expect(specs[0]!.members).toContain(deckKey("f-rev"));
    expect(specs[0]!.members).toContain("/build");
  });
});
