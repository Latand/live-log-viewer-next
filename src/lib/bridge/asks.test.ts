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
const OTHER_PROJECT = "repo-project-b";
const NOW = new Date("2026-08-26T12:00:00.000Z");

function report(overrides: Partial<BridgeReportV1> & { seq: number }): BridgeReportV1 {
  return {
    id: `rpt_${overrides.seq}`,
    key: `lane-${overrides.seq}-decide`,
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
  test("a blocked or question report opens one ask against its seat, keyed by the caller's key", () => {
    const asks = openBridgeAsks(
      log([report({ seq: 4, key: "lane-4-blocked", class: "blocked", body: "cannot proceed: pick a base" })]),
      { now: NOW },
    );
    expect([...asks.keys()]).toEqual([SEAT]);
    /* #1168 asks for the REPORT KEY, verbatim — not the hash the log derives
       from it, which cannot be spelled back out. */
    expect(asks.get(SEAT)).toEqual({ id: "lane-4-blocked", at: NOW.toISOString() });
  });

  test("a row written before the log kept keys still asks, under its derived id", () => {
    const legacy = report({ seq: 4, class: "blocked" });
    delete legacy.key;
    expect(openBridgeAsks(log([legacy]), { now: NOW }).get(SEAT)?.id).toBe("rpt_4");
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
        report({ seq: 1, key: "manager-ask" }),
        report({ seq: 9, key: "builder-ask", origin: { kind: "agent", conversationId: "conversation_builder", role: "builder" } }),
      ]),
      { now: NOW },
    );
    expect(asks.get(SEAT)?.id).toBe("manager-ask");
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
        report({ seq: 2, key: "old-ask", body: "first question" }),
        report({ seq: 5, key: "new-ask", body: "second question" }),
      ]),
      { now: NOW },
    );
    expect(asks.size).toBe(1);
    expect(asks.get(SEAT)?.id).toBe("new-ask");
  });

  test("the manager moving on clears the ask: any newer report of its own is its last word", () => {
    /* The seat said `blocked`, then said something else. It is no longer
       sitting on the old decision, and the queue must not keep claiming it is
       just because no directive ever quoted the seq. */
    for (const reportClass of ["status", "completed", "failed", "review_verdict"] as const) {
      const asks = openBridgeAsks(
        log([
          report({ seq: 2, key: "old-ask", class: "blocked" }),
          report({ seq: 5, key: "moved-on", class: reportClass }),
        ]),
        { now: NOW },
      );
      expect(asks.size).toBe(0);
    }
    /* …and a WORKER's later status does not speak for the seat. */
    expect(openBridgeAsks(
      log([
        report({ seq: 2, key: "old-ask", class: "blocked" }),
        report({ seq: 5, key: "worker-status", class: "status", origin: { kind: "agent", conversationId: "conversation_builder", role: "builder" } }),
      ]),
      { now: NOW },
    ).get(SEAT)?.id).toBe("old-ask");
  });

  test("a superseded ask stays cleared even when the newer one was answered", () => {
    const asks = openBridgeAsks(
      log([report({ seq: 2, key: "old-ask" }), report({ seq: 5, key: "new-ask" })], [5]),
      { now: NOW },
    );
    expect(asks.size).toBe(0);
  });

  test("projects keep their own ask", () => {
    const asks = openBridgeAsks(
      log([
        report({ seq: 1, key: "ask-a" }),
        report({ seq: 2, key: "ask-b", project: OTHER_PROJECT, targetSeatConversationId: OTHER_SEAT }),
      ]),
      { now: NOW },
    );
    expect(asks.get(SEAT)?.id).toBe("ask-a");
    expect(asks.get(OTHER_SEAT)?.id).toBe("ask-b");
  });

  test("a rotation retires the predecessor's ask the moment its successor speaks", () => {
    /* A project has exactly one designated orchestrator at a time, so the
       project's last word settles which seat is still asking. Without this the
       retired seat keeps a decision request on a card nobody is behind. */
    const rotated = log([
      report({ seq: 3, key: "predecessor-ask", class: "blocked" }),
      report({ seq: 8, key: "successor-status", class: "status", targetSeatConversationId: OTHER_SEAT }),
    ]);
    expect(openBridgeAsks(rotated, { now: NOW }).size).toBe(0);

    /* …and the successor's own decision request lands on the successor's card. */
    const asking = openBridgeAsks(
      log([
        report({ seq: 3, key: "predecessor-ask", class: "blocked" }),
        report({ seq: 8, key: "successor-ask", class: "question", targetSeatConversationId: OTHER_SEAT }),
      ]),
      { now: NOW },
    );
    expect([...asking.keys()]).toEqual([OTHER_SEAT]);
    expect(asking.get(OTHER_SEAT)?.id).toBe("successor-ask");
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
    const asks = openBridgeAsks(log([report({ seq: 1, key: "aliased-ask", targetSeatConversationId: "conversation_manager_old" })]), {
      now: NOW,
      canonicalConversationId: (id) => (id === "conversation_manager_old" ? SEAT : id),
    });
    expect(asks.get(SEAT)?.id).toBe("aliased-ask");
  });

  test("the ask carries the queue's two facts and no report prose", () => {
    const ask = openBridgeAsks(log([report({ seq: 1, key: "bounded", body: "a long decision request\nsecond line" })]), { now: NOW }).get(SEAT)!;
    expect(Object.keys(ask).sort()).toEqual(["at", "id"]);
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
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW }));
    expect(files[0]!.bridgeAsk?.id).toBe("seat-ask");
    expect(files[1]!.bridgeAsk).toBeUndefined();
    expect(files[2]!.bridgeAsk).toBeUndefined();
  });

  test("a retired round never gets the ask back after the projection demoted it", () => {
    /* Terminal supersedence and migration both blank a conversation's live
       attention fields earlier in the files projection because the successor
       carries the live card. An ask stamped afterwards would be the one signal
       that outlived that demotion and would re-raise a dead round. */
    const files = [
      entry({
        path: "/retired.jsonl",
        conversationId: SEAT,
        supersededBy: { conversationId: "conversation_manager_next", path: "/next.jsonl", at: NOW.toISOString(), reason: "rotation" },
      }),
      entry({ path: "/archived.jsonl", conversationId: SEAT, migratedTo: "/successor.jsonl" }),
    ];
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW }));
    expect(files[0]!.bridgeAsk).toBeUndefined();
    expect(files[1]!.bridgeAsk).toBeUndefined();
  });

  test("re-reading the same log stamps the same ask, never a second one", () => {
    const files = [entry({ path: "/seat.jsonl", conversationId: SEAT })];
    const asks = openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW });
    overlayBridgeAsks(files, asks);
    const first = files[0]!.bridgeAsk;
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW }));
    expect(files[0]!.bridgeAsk).toEqual(first!);
  });
});
