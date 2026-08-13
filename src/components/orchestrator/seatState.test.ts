import { describe, expect, test } from "bun:test";

import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import {
  classifySeatFailure,
  deriveOrchestratorPanelState,
  newSeatRequestId,
  parseSeatStatus,
  ROTATION_CONTEXT_PERCENT,
  type OrchestratorSeatStatus,
} from "./seatState";

function seat(overrides: Partial<OrchestratorSeat> = {}): OrchestratorSeat {
  return {
    project: "atlas",
    seatEpoch: 4,
    conversationId: "conversation_orchestrator",
    path: "/transcripts/orchestrator.jsonl",
    mandate: "run the board",
    promptVersion: 3,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "req-11111111", mode: "spawn", launchId: "launch-1", error: null },
    designatedAt: "2026-08-13T09:00:00.000Z",
    activatedAt: "2026-08-13T09:00:02.000Z",
    ...overrides,
  };
}

function status(overrides: Partial<OrchestratorSeatStatus> = {}): OrchestratorSeatStatus {
  return { seat: null, pending: null, exists: true, ...overrides };
}

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/transcripts/orchestrator.jsonl",
    root: "claude-projects",
    name: "orchestrator.jsonl",
    project: "atlas",
    title: "Orchestrator",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_760_000_000,
    size: 10,
    activity: "live",
    proc: null,
    pid: null,
    model: "opus",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation_orchestrator",
    ...overrides,
  } as FileEntry;
}

const base = { statusFailed: false, submitting: false, submitFailure: null, file: null, hostDead: false };

describe("the panel names every state in the map (#977)", () => {
  test("no answer yet is loading, and a failed read says so instead of inviting a second orchestrator", () => {
    expect(deriveOrchestratorPanelState({ ...base, status: null }).kind).toBe("loading");
    expect(deriveOrchestratorPanelState({ ...base, status: null, statusFailed: true }).kind).toBe("unavailable");
  });

  test("no seat is the draft; a seat whose transcript is gone returns to the draft, marked vacated", () => {
    expect(deriveOrchestratorPanelState({ ...base, status: status() })).toEqual({ kind: "draft", vacated: false });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat(), exists: false }) }))
      .toEqual({ kind: "draft", vacated: true });
  });

  test("a POST on the wire and a durable pending intent are both creating", () => {
    expect(deriveOrchestratorPanelState({ ...base, status: status(), submitting: true }).kind).toBe("creating");
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-22222222", mode: "spawn", launchId: "launch-9", error: null } });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ pending }) }))
      .toEqual({ kind: "creating", launchId: "launch-9", designatedAt: pending.designatedAt });
  });

  test("a stored terminal error is the intent-error state, with a fresh-key retry", () => {
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-33333333", mode: "spawn", launchId: null, error: "spawn was rejected with HTTP status 400" } });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ pending }) });
    expect(state).toEqual({
      kind: "intent-error",
      error: "spawn was rejected with HTTP status 400",
      retry: "fresh",
      designatedAt: pending.designatedAt,
    });
  });

  test("a lost reply is an intent-error whose retry replays the SAME key", () => {
    const state = deriveOrchestratorPanelState({
      ...base,
      status: status(),
      submitFailure: { kind: "ambiguous", error: "the reply never arrived" },
    });
    expect(state).toEqual({ kind: "intent-error", error: "the reply never arrived", retry: "same", designatedAt: "" });
  });

  test("an active seat is live, and its liveness follows the conversation", () => {
    const live = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file() });
    expect(live).toMatchObject({ kind: "live", conversationId: "conversation_orchestrator", liveness: "live", rotation: null, transition: null });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: null }))
      .toMatchObject({ kind: "live", liveness: "resolving" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file({ activity: "stalled" }) }))
      .toMatchObject({ kind: "live", liveness: "stalled" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), hostDead: true }))
      .toMatchObject({ kind: "live", liveness: "dead" });
  });

  test("rotation is recommended at the server's own threshold, and for a gone host", () => {
    const under = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ ctx: { usedTokens: 10, windowTokens: 100, pct: ROTATION_CONTEXT_PERCENT - 1, source: "transcript", confidence: "high", observedAt: "" } as unknown as FileEntry["ctx"] }),
    });
    expect(under).toMatchObject({ kind: "live", rotation: null });

    const at = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ ctx: { usedTokens: 60, windowTokens: 100, pct: ROTATION_CONTEXT_PERCENT, source: "transcript", confidence: "high", observedAt: "" } as unknown as FileEntry["ctx"] }),
    });
    expect(at).toMatchObject({ kind: "live", rotation: { level: "strongly_recommend", contextPercent: ROTATION_CONTEXT_PERCENT, reasons: ["context"] } });

    const dead = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), hostDead: true });
    expect(dead).toMatchObject({ kind: "live", rotation: { level: "recommend", reasons: ["dead"] } });
  });

  test("a failed transition over a live incumbent is shown ALONGSIDE it, never instead of it", () => {
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-44444444", mode: "spawn", launchId: null, error: "spawn did not report an accepted launch" } });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat(), pending }), file: file() });
    expect(state).toMatchObject({
      kind: "live",
      transition: { kind: "error", error: "spawn did not report an accepted launch" },
    });
  });
});

describe("seat status parsing", () => {
  test("a malformed body reads as no seat rather than throwing", () => {
    expect(parseSeatStatus(null)).toEqual({ seat: null, pending: null, exists: true });
    expect(parseSeatStatus({ seat: { project: 7 }, pending: [], exists: false }))
      .toEqual({ seat: null, pending: null, exists: false });
  });

  test("a well-formed seat keeps the fields the panel renders from", () => {
    const parsed = parseSeatStatus({ seat: seat(), pending: null, exists: true });
    expect(parsed.seat?.conversationId).toBe("conversation_orchestrator");
    expect(parsed.seat?.intent.clientRequestId).toBe("req-11111111");
  });
});

describe("confirm outcomes decide whether the next attempt reuses its key", () => {
  test("a refusal is terminal — the corrected mandate needs a new key", () => {
    expect(classifySeatFailure(400, { error: "mandate is required" })).toEqual({ kind: "terminal", error: "mandate is required" });
    expect(classifySeatFailure(409, { error: "already designated", code: "already_designated" }))
      .toEqual({ kind: "terminal", error: "already designated" });
  });

  test("an in-flight transition owned by another request is neither — the poll reports it", () => {
    expect(classifySeatFailure(409, { error: "in progress", code: "seat_intent_in_progress" })).toBeNull();
  });

  test("a 5xx leaves worker existence unknown, so the retry replays the same key", () => {
    expect(classifySeatFailure(502, { error: "mandate delivery failed" })).toEqual({ kind: "ambiguous", error: "mandate delivery failed" });
    expect(classifySeatFailure(500, null)).toEqual({ kind: "ambiguous", error: "the seat route answered HTTP 500" });
  });
});

test("a minted request id satisfies the seat route's own gate", () => {
  for (let index = 0; index < 20; index += 1) {
    expect(newSeatRequestId()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  }
});
