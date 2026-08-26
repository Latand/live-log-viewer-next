import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { openBridgeAsks, overlayBridgeAsks } from "./asks";
import { BRIDGE_ASK_TTL_SECONDS, type BridgeReportLogV1, type BridgeReportV1 } from "./types";

/**
 * #1168 — the bridge log read as "who is waiting on the operator right now".
 *
 * The gateway is the only consumer that ever drained this log, so a `blocked`
 * or `question` report reached nobody while it was off. These cases pin the
 * derivation the attention queue consumes: one open ask per orchestrator seat,
 * cleared by an answering directive, by a newer ask, or by the clock.
 */

const SEAT = "conversation_manager_a";
const OTHER_SEAT = "conversation_manager_b";
const PROJECT = "repo-project-a";
const NOW = new Date("2026-08-26T12:00:00.000Z");

function report(overrides: Partial<BridgeReportV1> & { seq: number }): BridgeReportV1 {
  return {
    id: `rpt_${overrides.seq}`,
    at: NOW.toISOString(),
    class: "question",
    project: PROJECT,
    targetSeatConversationId: SEAT,
    body: "which base branch should the lane cut from?",
    ...overrides,
  };
}

function log(reports: BridgeReportV1[], answeredRefs?: number[]): BridgeReportLogV1 {
  return {
    schemaVersion: 1,
    lastSeq: reports.reduce((highest, entry) => Math.max(highest, entry.seq), 0),
    trimmedThroughSeq: 0,
    trimmedThroughByChannel: {},
    reports,
    retired: [],
    ...(answeredRefs ? { answeredRefs } : {}),
  };
}

describe("openBridgeAsks", () => {
  test("a blocked or question report opens one ask against its seat", () => {
    const asks = openBridgeAsks(log([report({ seq: 4, class: "blocked", body: "cannot proceed: pick a base" })]), { now: NOW });
    expect([...asks.keys()]).toEqual([SEAT]);
    expect(asks.get(SEAT)).toEqual({
      id: "rpt_4",
      seq: 4,
      class: "blocked",
      at: NOW.toISOString(),
      summary: "cannot proceed: pick a base",
    });
  });

  test("classes that are not a decision request open nothing", () => {
    for (const reportClass of ["status", "completed", "failed", "review_verdict"] as const) {
      expect(openBridgeAsks(log([report({ seq: 1, class: reportClass })]), { now: NOW }).size).toBe(0);
    }
  });

  test("only the manager's own voice opens an ask on the manager's card", () => {
    /* Legacy rows carry no origin at all and were manager-only by the gate of
       their era, so they still ask. */
    expect(openBridgeAsks(log([report({ seq: 1 })]), { now: NOW }).size).toBe(1);
    expect(openBridgeAsks(log([report({ seq: 1, origin: { kind: "manager", conversationId: SEAT, role: null } })]), { now: NOW }).size).toBe(1);
    /* `bridge_report` is callable from every session: a worker or the gateway
       filing `blocked` must not raise it against the seat's card. */
    for (const origin of [
      { kind: "agent" as const, conversationId: "conversation_builder", role: "builder" },
      { kind: "gateway" as const, conversationId: "conversation_voice", role: null },
      { kind: "unidentified" as const, conversationId: null, role: null },
    ]) {
      expect(openBridgeAsks(log([report({ seq: 2, origin })]), { now: NOW }).size).toBe(0);
    }
  });

  test("a non-manager row does not supersede the manager's standing ask either", () => {
    const asks = openBridgeAsks(
      log([
        report({ seq: 1, id: "rpt_manager" }),
        report({ seq: 9, id: "rpt_builder", origin: { kind: "agent", conversationId: "conversation_builder", role: "builder" } }),
      ]),
      { now: NOW },
    );
    expect(asks.get(SEAT)?.id).toBe("rpt_manager");
  });

  test("an unrouted or quarantined row never opens an ask", () => {
    expect(openBridgeAsks(log([report({ seq: 1, targetSeatConversationId: null })]), { now: NOW }).size).toBe(0);
    expect(openBridgeAsks(log([report({ seq: 2, project: null })]), { now: NOW }).size).toBe(0);
  });

  test("a directive that answered the seq clears the ask", () => {
    const entries = [report({ seq: 7 })];
    expect(openBridgeAsks(log(entries), { now: NOW }).size).toBe(1);
    expect(openBridgeAsks(log(entries, [7]), { now: NOW }).size).toBe(0);
    /* Another report's seq is not this one's answer. */
    expect(openBridgeAsks(log(entries, [6, 8]), { now: NOW }).size).toBe(1);
  });

  test("a newer ask supersedes the earlier one on the same seat", () => {
    const asks = openBridgeAsks(
      log([
        report({ seq: 2, id: "rpt_old", body: "first question" }),
        report({ seq: 5, id: "rpt_new", body: "second question" }),
      ]),
      { now: NOW },
    );
    expect(asks.size).toBe(1);
    expect(asks.get(SEAT)?.id).toBe("rpt_new");
  });

  test("a superseded ask stays cleared even when the newer one was answered", () => {
    const asks = openBridgeAsks(
      log([report({ seq: 2, id: "rpt_old" }), report({ seq: 5, id: "rpt_new" })], [5]),
      { now: NOW },
    );
    expect(asks.size).toBe(0);
  });

  test("seats keep their own ask", () => {
    const asks = openBridgeAsks(
      log([
        report({ seq: 1, id: "rpt_a" }),
        report({ seq: 2, id: "rpt_b", targetSeatConversationId: OTHER_SEAT }),
      ]),
      { now: NOW },
    );
    expect(asks.get(SEAT)?.id).toBe("rpt_a");
    expect(asks.get(OTHER_SEAT)?.id).toBe("rpt_b");
  });

  test("the ask expires on the TTL boundary, not before it", () => {
    const inside = new Date(NOW.getTime() - BRIDGE_ASK_TTL_SECONDS * 1000).toISOString();
    expect(openBridgeAsks(log([report({ seq: 1, at: inside })]), { now: NOW }).size).toBe(1);
    const outside = new Date(NOW.getTime() - BRIDGE_ASK_TTL_SECONDS * 1000 - 1).toISOString();
    expect(openBridgeAsks(log([report({ seq: 1, at: outside })]), { now: NOW }).size).toBe(0);
  });

  test("an unparseable report time opens nothing rather than an ageless ask", () => {
    expect(openBridgeAsks(log([report({ seq: 1, at: "whenever" })]), { now: NOW }).size).toBe(0);
  });

  test("a seat renamed by a conversation alias still resolves", () => {
    const asks = openBridgeAsks(log([report({ seq: 1, targetSeatConversationId: "conversation_manager_old" })]), {
      now: NOW,
      canonicalConversationId: (id) => (id === "conversation_manager_old" ? SEAT : id),
    });
    expect(asks.get(SEAT)?.id).toBe("rpt_1");
  });

  test("the summary is the report's first line, bounded", () => {
    const asks = openBridgeAsks(
      log([report({ seq: 1, body: `  ${"decide ".repeat(40)}\nsecond line` })]),
      { now: NOW },
    );
    const summary = asks.get(SEAT)!.summary;
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary).toStartWith("decide decide");
    expect(summary).not.toContain("second line");
  });
});

describe("overlayBridgeAsks", () => {
  function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
    return {
      root: "claude-projects",
      name: overrides.path,
      project: PROJECT,
      title: overrides.path,
      engine: "claude",
      kind: "session",
      fmt: "claude",
      parent: null,
      mtime: 0,
      size: 0,
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
      ...overrides,
    };
  }

  test("the ask lands on the seat's own entry and nowhere else", () => {
    const files = [
      entry({ path: "/seat.jsonl", conversationId: SEAT }),
      entry({ path: "/worker.jsonl", conversationId: "conversation_worker" }),
      entry({ path: "/unregistered.jsonl" }),
    ];
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3 })]), { now: NOW }));
    expect(files[0]!.bridgeAsk?.id).toBe("rpt_3");
    expect(files[1]!.bridgeAsk).toBeUndefined();
    expect(files[2]!.bridgeAsk).toBeUndefined();
  });

  test("re-reading the same log stamps the same ask, never a second one", () => {
    const files = [entry({ path: "/seat.jsonl", conversationId: SEAT })];
    const asks = openBridgeAsks(log([report({ seq: 3 })]), { now: NOW });
    overlayBridgeAsks(files, asks);
    const first = files[0]!.bridgeAsk;
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3 })]), { now: NOW }));
    expect(files[0]!.bridgeAsk).toEqual(first!);
  });
});
