import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import {
  applyEvent,
  deriveSessionState,
  hasBlockingAttention,
  installSnapshot,
  runtimeActivity,
  mintIdempotencyKey,
  openAttentions,
  receiptIsTerminal,
  type RuntimeAttention,
  type RuntimeEnvelope,
  type RuntimeReceipt,
  type RuntimeSession,
  type RuntimeSnapshot,
  type RuntimeStore,
} from "./runtimeModel";

/* ------------------------------ fixtures ------------------------------ */

function session(overrides: Partial<RuntimeSession> & { conversationId: string }): RuntimeSession {
  return {
    sessionKey: { engine: "codex", sessionId: overrides.conversationId },
    hostKind: "codex-app-server",
    host: "hosted",
    turn: "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: "acct",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/tmp",
    artifactPath: null,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null,
    drift: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 100,
    retentionFloorSeq: 10,
    runtime: { hostEpoch: 7, health: "ready" },
    filesRevision: 5,
    sessions: [session({ conversationId: "conv_a", revision: 3 })],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    ...overrides,
  };
}

let seq = 1000;
function env<P>(kind: string, scope: { type: string; id: string }, revision: number, payload: P): RuntimeEnvelope<P> {
  seq += 1;
  return {
    schemaVersion: 1,
    seq,
    eventId: `evt_${seq}`,
    scope: scope as RuntimeEnvelope["scope"],
    revision,
    kind,
    payload,
  };
}

function attention(overrides: Partial<RuntimeAttention> & { id: string; conversationId: string }): RuntimeAttention {
  return {
    kind: "approval",
    state: "open",
    unowned: false,
    createdAt: "2026-07-10T00:00:00.000Z",
    request: { command: "rm -rf build" },
    ...overrides,
  };
}

function apply(store: RuntimeStore, e: RuntimeEnvelope): RuntimeStore {
  const result = applyEvent(store, e);
  if (result.outcome !== "applied") throw new Error(`expected applied, got ${result.outcome}`);
  return result.store;
}

/* ------------------------------ snapshot ------------------------------ */

describe("installSnapshot", () => {
  test("seeds cursor, scope heads, and every projected collection", () => {
    const flow = { id: "flow_1", state: "reviewing" } as unknown as Flow;
    const store = installSnapshot(
      snapshot({
        recentOperations: [receipt({ operationId: "op_1", conversationId: "conv_a", status: "delivered", revision: 2 })],
        flows: [{ revision: 4, value: flow }],
      }),
    );
    expect(store.cursor).toBe(100);
    expect(store.retentionFloorSeq).toBe(10);
    expect(store.filesRevision).toBe(5);
    expect(store.hostEpoch).toBe(7);
    expect(store.scopeHeads["session:conv_a"]).toBe(3);
    expect(store.scopeHeads["operation:op_1"]).toBe(2);
    expect(store.scopeHeads["flow:flow_1"]).toBe(4);
    expect(store.flows["flow_1"]?.state).toBe("reviewing");
  });

  test("installs deployment status and advances it from the event stream", () => {
    const deployment: ViewerDeploymentStatus = {
      deploymentId: "deploy_1", idempotencyKey: "key_1", requestedRevision: "origin/main", revision: "a".repeat(40),
      phase: "building", terminal: false, candidate: null, previous: null, health: [], error: null,
      owner: { pid: 10, startIdentity: "10:1" }, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z", revisionNumber: 2,
    };
    const store = installSnapshot(snapshot({ deployments: [deployment] }));
    expect(store.scopeHeads["deployment:deploy_1"]).toBe(2);
    const next = apply(store, env("deployment.state", { type: "deployment", id: "deploy_1" }, 3, { ...deployment, phase: "candidate-health", revisionNumber: 3 }));
    expect(next.deployments.deploy_1?.phase).toBe("candidate-health");
  });
});

function receipt(overrides: Partial<RuntimeReceipt> & { operationId: string; conversationId: string }): RuntimeReceipt {
  return {
    idempotencyKey: overrides.operationId,
    kind: "send",
    status: "pending",
    at: "2026-07-10T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

/* --------------------- strict revision guard --------------------- */

describe("applyEvent revision guard", () => {
  test("applies exactly currentRevision + 1", () => {
    const store = installSnapshot(snapshot());
    const next = apply(store, env("turn-started", { type: "session", id: "conv_a" }, 4, { conversationId: "conv_a", turnId: "t1" }));
    expect(next.sessions["conv_a"]?.turn).toBe("running");
    expect(next.sessions["conv_a"]?.activeTurnId).toBe("t1");
    expect(next.scopeHeads["session:conv_a"]).toBe(4);
  });

  test("drops a duplicate (lower-or-equal revision) idempotently", () => {
    const store = installSnapshot(snapshot());
    const dup = applyEvent(store, env("turn-started", { type: "session", id: "conv_a" }, 3, { conversationId: "conv_a" }));
    expect(dup.outcome).toBe("duplicate");
  });

  test("drops a duplicate by already-consumed global seq", () => {
    const store = installSnapshot(snapshot());
    const stale: RuntimeEnvelope = { ...env("turn-started", { type: "session", id: "conv_a" }, 4, {}), seq: 50 };
    expect(applyEvent(store, stale).outcome).toBe("duplicate");
  });

  test("signals a gap and does not mutate when a revision is skipped", () => {
    const store = installSnapshot(snapshot());
    const result = applyEvent(store, env("turn-started", { type: "session", id: "conv_a" }, 6, { conversationId: "conv_a" }));
    expect(result.outcome).toBe("gap");
    if (result.outcome === "gap") {
      expect(result.scope).toBe("session:conv_a");
      expect(result.expected).toBe(4);
      expect(result.got).toBe(6);
    }
  });

  test("a brand-new scope must start at revision 1", () => {
    const store = installSnapshot(snapshot());
    const gap = applyEvent(store, env("edge.created", { type: "edge", id: "edge_x" }, 3, {}));
    expect(gap.outcome).toBe("gap");
    const ok = applyEvent(store, env("edge.created", { type: "edge", id: "edge_x" }, 1, edge()));
    expect(ok.outcome).toBe("applied");
  });
});

function edge() {
  return {
    id: "edge_x",
    kind: "spawn",
    parentConversationId: "conv_a",
    childConversationId: "conv_b",
    revision: 1,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

/* --------------------- deterministic convergence --------------------- */

describe("deterministic convergence", () => {
  const events: RuntimeEnvelope[] = [
    env("turn-started", { type: "session", id: "conv_a" }, 4, { conversationId: "conv_a", turnId: "t1" }),
    env("attention", { type: "session", id: "conv_a" }, 5, attention({ id: "att_1", conversationId: "conv_a" })),
    env("attention-resolved", { type: "session", id: "conv_a" }, 6, { attentionId: "att_1", conversationId: "conv_a", state: "resolved" }),
    env("turn-ended", { type: "session", id: "conv_a" }, 7, { conversationId: "conv_a", outcome: "completed" }),
  ];

  test("in-order delivery reaches the settled state", () => {
    let store = installSnapshot(snapshot());
    for (const e of events) store = apply(store, e);
    expect(store.sessions["conv_a"]?.turn).toBe("idle");
    expect(hasBlockingAttention(store, store.sessions["conv_a"]!)).toBe(false);
    expect(store.scopeHeads["session:conv_a"]).toBe(7);
  });

  test("shuffled + duplicated delivery converges to the identical state (gaps buffered then replayed in order)", () => {
    // Simulate a client that resnapshots on gaps: buffer, retry the buffer
    // whenever a scope head advances. The settled state must equal in-order.
    const shuffles: RuntimeEnvelope[][] = [
      [events[3]!, events[1]!, events[0]!, events[2]!, events[0]!],
      [events[2]!, events[3]!, events[0]!, events[1]!, events[1]!],
      [events[0]!, events[0]!, events[1]!, events[3]!, events[2]!],
    ];
    for (const order of shuffles) {
      let store = installSnapshot(snapshot());
      const pending = [...order];
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let i = 0; i < pending.length; i += 1) {
          const result = applyEvent(store, pending[i]!);
          if (result.outcome === "applied") {
            store = result.store;
            pending.splice(i, 1);
            i -= 1;
            progressed = true;
          } else if (result.outcome === "duplicate") {
            pending.splice(i, 1);
            i -= 1;
            progressed = true;
          }
          // gap: leave it buffered, retry after another apply advances the head
        }
      }
      expect(store.sessions["conv_a"]?.turn).toBe("idle");
      expect(store.sessions["conv_a"]?.attentionIds).toEqual([]);
      expect(store.scopeHeads["session:conv_a"]).toBe(7);
    }
  });
});

/* --------------------- attention projection --------------------- */

describe("attention", () => {
  test("open attention lands on the session and unowned sorts first", () => {
    let store = installSnapshot(snapshot());
    store = apply(store, env("attention", { type: "session", id: "conv_a" }, 4, attention({ id: "a1", conversationId: "conv_a" })));
    store = apply(store, env("attention", { type: "session", id: "conv_a" }, 5, attention({ id: "a2", conversationId: "conv_a", unowned: true, createdAt: "2026-07-10T00:01:00.000Z" })));
    const open = openAttentions(store, store.sessions["conv_a"]!);
    expect(open.map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(deriveSessionState(store.sessions["conv_a"]!, true)).toBe("waiting_input");
  });

  test("resolving an attention clears it from the session and marks it resolved", () => {
    let store = installSnapshot(snapshot());
    store = apply(store, env("attention", { type: "session", id: "conv_a" }, 4, attention({ id: "a1", conversationId: "conv_a" })));
    store = apply(store, env("attention-resolved", { type: "session", id: "conv_a" }, 5, { attentionId: "a1", conversationId: "conv_a" }));
    expect(store.sessions["conv_a"]?.attentionIds).toEqual([]);
    expect(store.attentions["a1"]?.state).toBe("resolved");
  });
});

/* --------------------- receipts --------------------- */

describe("receipts", () => {
  test("receipt persists on the operation and the session's recent list, newest-first and idempotent", () => {
    let store = installSnapshot(snapshot());
    store = apply(store, env("receipt", { type: "operation", id: "op_1" }, 1, receipt({ operationId: "op_1", conversationId: "conv_a", status: "queued", text: "ship it" })));
    store = apply(store, env("receipt", { type: "operation", id: "op_1" }, 2, receipt({ operationId: "op_1", conversationId: "conv_a", status: "steered", turnId: "t1", text: "ship it" })));
    expect(store.operations["op_1"]?.status).toBe("steered");
    const recent = store.sessions["conv_a"]?.recentReceipts ?? [];
    expect(recent.length).toBe(1);
    expect(recent[0]?.status).toBe("steered");
    expect(receiptIsTerminal("steered")).toBe(false);
    expect(receiptIsTerminal("delivered")).toBe(true);
  });

  test("receipts recover from a snapshot reload (journaled last-N)", () => {
    const store = installSnapshot(
      snapshot({
        sessions: [session({ conversationId: "conv_a", revision: 3, recentReceipts: [receipt({ operationId: "op_old", conversationId: "conv_a", status: "delivered" })] })],
        recentOperations: [receipt({ operationId: "op_old", conversationId: "conv_a", status: "delivered", revision: 4 })],
      }),
    );
    expect(store.sessions["conv_a"]?.recentReceipts[0]?.operationId).toBe("op_old");
    expect(store.operations["op_old"]?.status).toBe("delivered");
  });
});

/* --------------------- files revision --------------------- */

describe("files.revision", () => {
  test("monotonic bump signals a files fetch; a stale value drops", () => {
    const store = installSnapshot(snapshot());
    const bump = applyEvent(store, env("files.revision", { type: "system", id: "files" }, 0, { filesRevision: 6 }));
    expect(bump.outcome).toBe("applied");
    if (bump.outcome === "applied") {
      expect(bump.filesBumped).toBe(true);
      expect(bump.store.filesRevision).toBe(6);
    }
    const stale = applyEvent(store, env("files.revision", { type: "system", id: "files" }, 0, { filesRevision: 4 }));
    expect(stale.outcome).toBe("duplicate");
  });
});

/* --------------------- flow.state --------------------- */

describe("flow.state", () => {
  test("event-driven flow progression updates the flow projection in place", () => {
    const flow = { id: "flow_1", state: "spawn_pending" } as unknown as Flow;
    let store = installSnapshot(snapshot({ flows: [{ revision: 2, value: flow }] }));
    store = apply(store, env("flow.state", { type: "flow", id: "flow_1" }, 3, { ...flow, state: "reviewing" }));
    expect(store.flows["flow_1"]?.state).toBe("reviewing");
    store = apply(store, env("flow.state", { type: "flow", id: "flow_1" }, 4, { ...flow, state: "approved" }));
    expect(store.flows["flow_1"]?.state).toBe("approved");
    expect(store.scopeHeads["flow:flow_1"]).toBe(4);
  });
});

/* --------------------- state derivation --------------------- */

describe("deriveSessionState precedence", () => {
  test("host axis dominates, then attention, then turn", () => {
    expect(deriveSessionState(session({ conversationId: "c", host: "dead" }), true)).toBe("dead");
    expect(deriveSessionState(session({ conversationId: "c", host: "conflict" }), false)).toBe("conflict");
    expect(deriveSessionState(session({ conversationId: "c", host: "recovering" }), true)).toBe("recovering");
    expect(deriveSessionState(session({ conversationId: "c", host: "unhosted" }), false)).toBe("unhosted");
    expect(deriveSessionState(session({ conversationId: "c", host: "hosted", turn: "running" }), true)).toBe("waiting_input");
    expect(deriveSessionState(session({ conversationId: "c", host: "hosted", turn: "running" }), false)).toBe("working");
    expect(deriveSessionState(session({ conversationId: "c", host: "hosted", turn: "idle" }), false)).toBe("idle");
    expect(deriveSessionState(session({ conversationId: "c", host: "hosted", turn: "unknown" }), false)).toBe("unknown");
  });
});

/* --------------------- board status dot --------------------- */

describe("runtimeActivity", () => {
  test("maps derived state onto the board activity dot", () => {
    expect(runtimeActivity("working")).toBe("live");
    expect(runtimeActivity("waiting_input")).toBe("stalled");
    expect(runtimeActivity("conflict")).toBe("stalled");
    expect(runtimeActivity("idle")).toBe("idle");
    expect(runtimeActivity("dead")).toBe("idle");
    expect(runtimeActivity("recovering")).toBe("recent");
    expect(runtimeActivity("unhosted")).toBe("recent");
    expect(runtimeActivity("unknown")).toBe("recent");
  });
});

/* --------------------- idempotency key --------------------- */

describe("mintIdempotencyKey", () => {
  test("mints unique op-prefixed keys", () => {
    const a = mintIdempotencyKey();
    const b = mintIdempotencyKey();
    expect(a.startsWith("op_")).toBe(true);
    expect(a).not.toBe(b);
  });
});
