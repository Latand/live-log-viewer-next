import { describe, expect, test } from "bun:test";

import type { StripSurface } from "../agentCapabilities";
import { deriveOrchestratorPanelState, type OrchestratorSeatStatus } from "../orchestrator/seatState";
import type { FileEntry } from "@/lib/types";

import { ROW_STATE_LABEL, SEAT_STATE_TONE, orchestratorRowView, seatCardView, type OrchestratorRowState } from "./orchestratorRowState";

/*
 * The phone seat card's projection of the seat state machine (issue #979;
 * mobile v2 lane 6). Every case starts from a seat-route ANSWER and runs the
 * real derivation, so this asserts the whole path an operator's phone actually
 * takes — a card rendering that no seat body can produce would show up here as
 * an unreachable state, and a seat body the card cannot classify as a missing
 * one.
 */

const seat = (over: Record<string, unknown> = {}) => ({
  project: "atlas",
  seatEpoch: 4,
  conversationId: "conv_orchestrator",
  path: "/orchestrator.jsonl",
  mandate: "You run the Atlas board.",
  promptVersion: 4,
  predecessorConversationId: null,
  state: "active",
  intent: { clientRequestId: "seatreq-0001", mode: "spawn", launchId: "launch-0001", error: null },
  designatedAt: "2100-01-02T11:00:00.000Z",
  activatedAt: "2100-01-02T11:00:02.000Z",
  ...over,
}) as unknown as NonNullable<OrchestratorSeatStatus["seat"]>;

const pending = (over: Record<string, unknown> = {}) =>
  seat({ conversationId: null, state: "pending", activatedAt: null, ...over });

type SeatStatusFixture = Omit<OrchestratorSeatStatus, "viewerMcpRegistered"> & {
  viewerMcpRegistered?: boolean;
};

const conversation: FileEntry = {
  path: "/orchestrator.jsonl", root: "claude-projects", name: "orchestrator.jsonl", project: "atlas",
  title: "Run the Atlas board", engine: "claude", kind: "session", fmt: "claude", parent: null,
  mtime: 10, size: 1, activity: "live", proc: "running", pid: 7, conversationId: "conv_orchestrator",
  model: "opus", pendingQuestion: null, waitingInput: null,
} as FileEntry;

function rowFor(input: {
  status: SeatStatusFixture | null;
  statusFailed?: boolean;
  submitting?: boolean;
  file?: FileEntry | null;
  surface?: StripSurface | null;
}) {
  const file = input.file ?? null;
  const state = deriveOrchestratorPanelState({
    status: input.status ? { viewerMcpRegistered: false, ...input.status } : null,
    statusFailed: input.statusFailed ?? false,
    submitting: input.submitting ?? false,
    submitFailure: null,
    file,
    surface: input.surface ?? (file ? "live-root" : null),
  });
  return orchestratorRowView(state, { conversationReady: Boolean(file) });
}

function cardFor(input: Parameters<typeof rowFor>[0]) {
  const file = input.file ?? null;
  const state = deriveOrchestratorPanelState({
    status: input.status ? { viewerMcpRegistered: false, ...input.status } : null,
    statusFailed: input.statusFailed ?? false,
    submitting: input.submitting ?? false,
    submitFailure: null,
    file,
    surface: input.surface ?? (file ? "live-root" : null),
  });
  return seatCardView(state, { conversationReady: Boolean(file) });
}

describe("the seat card mirrors every seat state", () => {
  test("no seat reads as the create draft, and a tap goes to the sheet", () => {
    const row = rowFor({ status: { seat: null, pending: null, exists: true } });
    expect(row.state).toBe("draft");
    expect(row.tap).toBe("sheet");
    expect(row.attention).toBe(false);
  });

  test("a closed seat conversation returns the row to the draft rather than a phantom incumbent", () => {
    const row = rowFor({ status: { seat: seat(), pending: null, exists: false } });
    expect(row.state).toBe("draft");
    expect(row.tap).toBe("sheet");
  });

  test("a pending designation reads as creating", () => {
    const row = rowFor({ status: { seat: null, pending: pending(), exists: true } });
    expect(row.state).toBe("creating");
    expect(row.tap).toBe("sheet");
    expect(row.attention).toBe(false);
  });

  test("a terminal error on the pending intent reads as intent-error and asks for the operator", () => {
    const row = rowFor({
      status: { seat: null, pending: pending({ intent: { clientRequestId: "seatreq-0002", mode: "spawn", launchId: null, error: "cwd could not be resolved" } }), exists: true },
    });
    expect(row.state).toBe("intent-error");
    expect(row.tap).toBe("sheet");
    expect(row.attention).toBe(true);
  });

  test("an unreadable seat says so instead of showing an empty draft that invites a second orchestrator", () => {
    const row = rowFor({ status: null, statusFailed: true });
    expect(row.state).toBe("unavailable");
    expect(row.tap).toBe("sheet");
    expect(row.attention).toBe(true);
  });

  test("the first read shows the loading row, never the draft", () => {
    const row = rowFor({ status: null });
    expect(row.state).toBe("loading");
    expect(row.tap).toBe("sheet");
  });

  test("a hosted seat with its transcript on the phone taps into the conversation", () => {
    const row = rowFor({ status: { seat: seat(), pending: null, exists: true }, file: conversation });
    expect(row.state).toBe("live");
    expect(row.tap).toBe("conversation");
    expect(row.attention).toBe(false);
  });

  test("a quiet host reads as stalled and still opens the conversation", () => {
    const row = rowFor({
      status: { seat: seat(), pending: null, exists: true },
      file: { ...conversation, activity: "stalled" } as FileEntry,
    });
    expect(row.state).toBe("stalled");
    expect(row.tap).toBe("conversation");
  });

  test("a finished orchestrator reads as resumable — the composer picks it back up in place", () => {
    const row = rowFor({ status: { seat: seat(), pending: null, exists: true }, file: conversation, surface: "resume" });
    expect(row.state).toBe("resumable");
    expect(row.tap).toBe("conversation");
    expect(row.attention).toBe(false);
  });

  test("a gone host reads as dead and asks for the operator", () => {
    const row = rowFor({ status: { seat: seat(), pending: null, exists: true }, file: conversation, surface: "dead" });
    expect(row.state).toBe("dead");
    expect(row.tap).toBe("conversation");
    expect(row.attention).toBe(true);
  });

  test("a seated orchestrator whose transcript has not reached this phone answers a tap with the sheet", () => {
    const row = rowFor({ status: { seat: seat(), pending: null, exists: true } });
    expect(row.state).toBe("resolving");
    /* The sheet is what can say «designated, transcript not here yet» and offer
       the board link; a tap that pins nothing would be a dead control. */
    expect(row.tap).toBe("sheet");
  });
});

describe("what rides alongside a live incumbent", () => {
  test("a rotation advisory shows on the row without moving where a tap lands", () => {
    const row = rowFor({
      status: { seat: seat(), pending: null, exists: true },
      file: { ...conversation, ctx: { pct: 71 } } as unknown as FileEntry,
    });
    expect(row.rotation).toBe("strongly_recommend");
    expect(row.state).toBe("live");
    expect(row.tap).toBe("conversation");
  });

  test("a failed transition raises attention but never takes the conversation away", () => {
    const row = rowFor({
      status: {
        seat: seat(),
        pending: pending({ intent: { clientRequestId: "seatreq-0003", mode: "spawn", launchId: null, error: "the successor never started" } }),
        exists: true,
      },
      file: conversation,
    });
    expect(row.transition).toBe("error");
    expect(row.attention).toBe(true);
    /* The whole point of the separate marker control: the row's own tap still
       opens the chat the operator is talking in. */
    expect(row.tap).toBe("conversation");
  });

  test("a designation settling over a live incumbent reads as a pending transition", () => {
    const row = rowFor({ status: { seat: seat(), pending: pending({ conversationId: null }), exists: true }, file: conversation });
    expect(row.transition).toBe("creating");
    expect(row.attention).toBe(false);
    expect(row.tap).toBe("conversation");
  });
});

describe("every designed seat state has a badge tone and a word", () => {
  const states: OrchestratorRowState[] = [
    "loading", "unavailable", "draft", "creating", "intent-error", "live", "stalled", "resumable", "dead", "resolving",
  ];

  test("tone and label cover the union exactly", () => {
    expect(Object.keys(SEAT_STATE_TONE).sort()).toEqual([...states].sort());
    expect(Object.keys(ROW_STATE_LABEL).sort()).toEqual([...states].sort());
  });

  test("the tones that mean «deal with me» are distinct from the quiet ones", () => {
    expect(SEAT_STATE_TONE["intent-error"]).toBe("danger");
    expect(SEAT_STATE_TONE.dead).toBe("danger");
    expect(SEAT_STATE_TONE.stalled).toBe("warning");
    expect(SEAT_STATE_TONE.unavailable).toBe("warning");
    expect(SEAT_STATE_TONE.live).toBe("success");
    /* Nothing but a hosted conversation may claim the live tone; a seat that is
       merely quiet is neutral rather than green (README §5). */
    expect(SEAT_STATE_TONE.resumable).toBe("neutral");
    expect(SEAT_STATE_TONE.resolving).toBe("neutral");
    expect(SEAT_STATE_TONE.loading).toBe("neutral");
  });
});

/*
 * The two faces the CARD adds over the row projection (README §4.1): the
 * invitation over a vacancy, and whose state the badge speaks.
 */
describe("the card's shape and the badge it speaks", () => {
  test("a plain vacancy is the invitation, and its tap opens the draft", () => {
    const card = cardFor({ status: { seat: null, pending: null, exists: true } });
    expect(card.shape).toBe("invitation");
    expect(card.tap).toBe("sheet");
    /* The invitation says «no orchestrator», so there is no seat state for a
       badge to speak. */
    expect(card.badge).toBe("state");
  });

  test("a designation that FAILED over a vacancy is not an invitation", () => {
    const card = cardFor({
      status: { seat: null, pending: pending({ intent: { clientRequestId: "seatreq-0004", mode: "spawn", launchId: null, error: "cwd could not be resolved" } }), exists: true },
    });
    /* An empty slot with a friendly line on it would hide the failure the
       operator has to deal with: the card says «failed» and its tap opens the
       draft that retries it. */
    expect(card.shape).toBe("seat");
    expect(card.state).toBe("intent-error");
  });

  test("a live seat whose transcript is here speaks the CONVERSATION's phrase", () => {
    const card = cardFor({ status: { seat: seat(), pending: null, exists: true }, file: conversation });
    expect(card.shape).toBe("seat");
    expect(card.badge).toBe("conversation");
  });

  test("a seat designated but not yet on this device speaks its own state word", () => {
    /* «resolving» has no conversation to take a phrase from, so borrowing one
       would state a working orchestrator this phone cannot see. */
    const card = cardFor({ status: { seat: seat(), pending: null, exists: true } });
    expect(card.state).toBe("resolving");
    expect(card.badge).toBe("state");
  });

  test("every other state keeps the seat shape, so only a vacancy ever invites", () => {
    const shapes = [
      cardFor({ status: null }),
      cardFor({ status: null, statusFailed: true }),
      cardFor({ status: { seat: null, pending: pending(), exists: true } }),
      cardFor({ status: { seat: seat(), pending: null, exists: true }, file: conversation, surface: "dead" }),
    ].map((card) => card.shape);
    expect(shapes).toEqual(["seat", "seat", "seat", "seat"]);
  });
});
