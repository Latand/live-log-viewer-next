import { describe, expect, test } from "bun:test";

import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import type { OrchestratorIncumbent } from "./incumbent";
import {
  classifySeatFailure,
  deriveOrchestratorPanelState,
  deriveRotateDraftState,
  newSeatRequestId,
  parseSeatStatus,
  ROTATION_CONTEXT_PERCENT,
  seatRequestSettled,
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

const base = { statusFailed: false, submitting: false, submitFailure: null, file: null, surface: null };

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
      .toEqual({ kind: "creating", launchId: "launch-9", clientRequestId: "req-22222222", designatedAt: pending.designatedAt });
  });

  test("a pending intent nothing is driving carries its own key, so the panel can finish it instead of spinning", () => {
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-55555555", mode: "spawn", launchId: "launch-x", error: null } });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ pending }) });
    expect(state).toMatchObject({ kind: "creating", clientRequestId: "req-55555555" });
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
      submitFailure: { kind: "ambiguous", error: "the reply never arrived", clientRequestId: "req-99999999" },
    });
    expect(state).toEqual({ kind: "intent-error", error: "the reply never arrived", retry: "same", designatedAt: "" });
  });

  test("an active seat is live, and its liveness follows the CAPABILITY SURFACE, not just activity", () => {
    const live = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "live-root" });
    expect(live).toMatchObject({ kind: "live", conversationId: "conversation_orchestrator", liveness: "live", rotation: null, transition: null });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "structured" }))
      .toMatchObject({ kind: "live", liveness: "live" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: null }))
      .toMatchObject({ kind: "live", liveness: "resolving" });
    /* The plane is authoritative and has not resolved the host: neither claim. */
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "unresolved" }))
      .toMatchObject({ kind: "live", liveness: "resolving" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file({ activity: "stalled" }), surface: "live-root" }))
      .toMatchObject({ kind: "live", liveness: "stalled" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "dead" }))
      .toMatchObject({ kind: "live", liveness: "dead" });
  });

  test("a finished but resumable seat is NOT live — on either engine, and never a duplicate spawn", () => {
    /* The matrix classifies a completed Claude session and a completed Codex
       thread alike: `resume`, meaning THIS conversation continues. The panel
       used to call both «live» because neither is stalled. */
    const claude = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ root: "claude-projects", engine: "claude", kind: "session", proc: null, activity: "idle" as FileEntry["activity"] }),
      surface: "resume",
    });
    expect(claude).toMatchObject({ kind: "live", liveness: "resumable" });

    const codex = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ root: "codex-sessions", engine: "codex", proc: "killed" as FileEntry["proc"] }),
      surface: "resume",
    });
    expect(codex).toMatchObject({ kind: "live", liveness: "resumable" });
    /* Resumable in place is not a reason to rotate — only a gone host is. */
    expect(codex).toMatchObject({ rotation: null });

    /* Finished and NOT resumable, or retired behind a successor: nothing to
       pick back up, so it reads as gone rather than as running. */
    for (const surface of ["inert", "superseded"] as const) {
      expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface }))
        .toMatchObject({ kind: "live", liveness: "dead", rotation: { reasons: ["dead"] } });
    }
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

    const dead = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "dead" });
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

describe("the server's own rotation recommendation is what the panel says (#978)", () => {
  const incumbent = (overrides: Partial<OrchestratorIncumbent> = {}): OrchestratorIncumbent => ({
    project: "atlas",
    designated: true,
    conversationId: "conversation_orchestrator",
    predecessorConversationId: null,
    engine: "claude",
    model: "opus",
    effort: null,
    accountId: "work",
    cwd: "/repos/atlas",
    context: { tokens: 620_000, limit: 1_000_000, percent: 62, estimated: false, basis: "provider-reported usage" },
    transcriptFacts: { bytes: 1024, messageCount: 10, toolCount: 4, compactionCount: 0 },
    rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
    ...overrides,
  });
  const live = (over: Partial<Parameters<typeof deriveOrchestratorPanelState>[0]>) =>
    deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "live-root", ...over });

  test("its reasons ride along verbatim, with the percentage it measured", () => {
    const state = live({
      incumbent: incumbent({
        rotation: {
          recommended: true,
          level: "strongly_recommend",
          reasons: ["context usage 620,000 tokens has reached the rotation threshold of 500,000 tokens (claude-opus-1m: 50% of a 1,000,000-token window)"],
          thresholdUnknown: false,
        },
      }),
    });
    expect(state).toMatchObject({
      kind: "live",
      rotation: { level: "strongly_recommend", contextPercent: 62, reasons: ["context"], source: "server" },
    });
    expect((state as { rotation: { notes?: readonly string[] } }).rotation.notes?.[0]).toContain("rotation threshold");
  });

  test("a recommendation the coded reasons cannot express still shows, carried by the server's words", () => {
    const state = live({
      incumbent: incumbent({
        rotation: { recommended: true, level: "recommend", reasons: ["3 compaction(s) recorded in the transcript, threshold 2"], thresholdUnknown: false },
      }),
    });
    expect(state).toMatchObject({ kind: "live", rotation: { level: "recommend", reasons: [], source: "server" } });
  });

  test("the server standing the advisory down beats a client guess about the same seat", () => {
    /* The board's own context read says 62% — over slice A's flat threshold —
       but the model's real window makes that well under the policy line. */
    const over = file({ ctx: { usedTokens: 620_000, windowTokens: 1_000_000, pct: 62, source: "transcript", confidence: "high", observedAt: "" } as unknown as FileEntry["ctx"] });
    expect(live({ file: over })).toMatchObject({ rotation: { level: "strongly_recommend", source: "client" } });
    expect(live({ file: over, incumbent: incumbent() })).toMatchObject({ rotation: null });
  });

  test("a gone host is ADDED to the server's reading, never subtracted from it", () => {
    expect(live({ surface: "dead", incumbent: incumbent() }))
      .toMatchObject({ rotation: { level: "recommend", reasons: ["dead"], source: "server" } });
  });

  test("a reading about a vacant seat is ignored — the client derivation still holds the state up", () => {
    const vacantReading = incumbent({ designated: false, rotation: null });
    expect(live({ surface: "dead", incumbent: vacantReading }))
      .toMatchObject({ rotation: { level: "recommend", reasons: ["dead"], source: "client" } });
  });
});

describe("the rotate draft renders the same two states the create draft does (#978)", () => {
  test("with nothing wrong it is just the form", () => {
    expect(deriveRotateDraftState({ status: status({ seat: seat() }), submitFailure: null }))
      .toEqual({ kind: "draft", vacated: false });
  });

  test("a rotation the server refused is shown with retry, and the retry needs a fresh key", () => {
    const pending = seat({
      state: "pending",
      conversationId: null,
      intent: { clientRequestId: "req-99999999", mode: "spawn", launchId: null, error: "spawn was rejected with HTTP status 500" },
    });
    expect(deriveRotateDraftState({ status: status({ seat: seat(), pending }), submitFailure: null }))
      .toMatchObject({ kind: "intent-error", error: "spawn was rejected with HTTP status 500", retry: "fresh" });
  });

  test("a lost reply is shown as unknown, and its retry replays the SAME key", () => {
    const failure = { kind: "ambiguous" as const, error: "the reply never arrived", clientRequestId: "req-88888888" };
    expect(deriveRotateDraftState({ status: status({ seat: seat() }), submitFailure: failure }))
      .toMatchObject({ kind: "intent-error", retry: "same" });
  });

  test("once the read shows where that rotation landed, the banner retires with it", () => {
    const key = "req-88888888";
    const successor = seat({ conversationId: "conversation_successor", intent: { clientRequestId: key, mode: "spawn", launchId: "launch-2", error: null } });
    expect(deriveRotateDraftState({ status: status({ seat: successor }), submitFailure: { kind: "ambiguous", error: "lost", clientRequestId: key } }))
      .toEqual({ kind: "draft", vacated: false });
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
  const key = "req-77777777";

  test("a refusal is terminal — the corrected mandate needs a new key", () => {
    expect(classifySeatFailure(400, { error: "mandate is required" }, key))
      .toEqual({ kind: "terminal", error: "mandate is required", clientRequestId: key });
    expect(classifySeatFailure(409, { error: "already designated", code: "already_designated" }, key))
      .toEqual({ kind: "terminal", error: "already designated", clientRequestId: key });
  });

  test("an in-flight transition owned by another request is neither — the poll reports it", () => {
    expect(classifySeatFailure(409, { error: "in progress", code: "seat_intent_in_progress" }, key)).toBeNull();
  });

  test("a 5xx leaves worker existence unknown, so the retry replays the same key", () => {
    expect(classifySeatFailure(502, { error: "mandate delivery failed" }, key))
      .toEqual({ kind: "ambiguous", error: "mandate delivery failed", clientRequestId: key });
    expect(classifySeatFailure(500, null, key))
      .toEqual({ kind: "ambiguous", error: "the seat route answered HTTP 500", clientRequestId: key });
  });
});

describe("a kept key is released once the server says where it landed (#977 round 2)", () => {
  const key = "req-66666666";

  test("unknown stays unknown: a key the read cannot place may still be in flight", () => {
    expect(seatRequestSettled(null, key)).toBe(false);
    expect(seatRequestSettled(status(), key)).toBe(false);
    /* Someone else's designation says nothing about this one. */
    expect(seatRequestSettled(status({ seat: seat() }), key)).toBe(false);
    expect(seatRequestSettled(status({ pending: seat({ state: "pending" }) }), key)).toBe(false);
  });

  test("a pending intent under this key is settled only once it carries a terminal error", () => {
    const pending = (error: string | null) => seat({
      state: "pending",
      conversationId: null,
      intent: { clientRequestId: key, mode: "spawn", launchId: null, error },
    });
    expect(seatRequestSettled(status({ pending: pending(null) }), key)).toBe(false);
    expect(seatRequestSettled(status({ pending: pending("spawn was rejected") }), key)).toBe(true);
  });

  test("reaching an active seat settles it — including after that conversation is closed", () => {
    const active = seat({ intent: { clientRequestId: key, mode: "spawn", launchId: "launch-1", error: null } });
    expect(seatRequestSettled(status({ seat: active }), key)).toBe(true);
    /* The vacancy the NEXT draft creates into: replaying this key there would be
       answered with the completed intent and create nothing at all. */
    expect(seatRequestSettled(status({ seat: active, exists: false }), key)).toBe(true);
  });

  test("a lost-reply banner retires when the read shows that submission landed", () => {
    const active = seat({ intent: { clientRequestId: key, mode: "spawn", launchId: "launch-1", error: null } });
    const failure = { kind: "ambiguous" as const, error: "the reply never arrived", clientRequestId: key };
    /* Before the read catches up it is the panel's whole state… */
    expect(deriveOrchestratorPanelState({ ...base, status: status(), submitFailure: failure }))
      .toMatchObject({ kind: "intent-error", retry: "same" });
    /* …and once the seat it created is visible, it stops riding along. */
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: active }), file: file(), surface: "live-root", submitFailure: failure }))
      .toMatchObject({ kind: "live", transition: null });
  });
});

test("a minted request id satisfies the seat route's own gate", () => {
  for (let index = 0; index < 20; index += 1) {
    expect(newSeatRequestId()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  }
});
