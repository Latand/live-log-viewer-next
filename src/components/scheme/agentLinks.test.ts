import { describe, expect, test } from "bun:test";

import type { Flow, FlowState, Round } from "@/lib/flows/types";

import { buildAnchorIndex, currentRound, deckKey, deriveFlowLinks, flowLinkKey, flowLinkPhase } from "./agentLinks";

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
