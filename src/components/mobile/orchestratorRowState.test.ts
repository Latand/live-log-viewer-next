import { describe, expect, test } from "bun:test";

import type { StripSurface } from "../agentCapabilities";
import { deriveOrchestratorPanelState, type OrchestratorSeatStatus } from "../orchestrator/seatState";
import type { FileEntry } from "@/lib/types";

import { ROW_STATE_LABEL, ROW_TONE, orchestratorRowView, type OrchestratorRowState } from "./orchestratorRowState";

/*
 * The phone row's projection of the seat state machine (issue #979). Every case
 * starts from a seat-route ANSWER and runs the real derivation, so this asserts
 * the whole path an operator's phone actually takes — a row rendering that no
 * seat body can produce would show up here as an unreachable state, and a seat
 * body the row cannot classify as a missing one.
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

describe("the pinned row mirrors every seat state", () => {
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

describe("every designed row state has a face and a word", () => {
  const states: OrchestratorRowState[] = [
    "loading", "unavailable", "draft", "creating", "intent-error", "live", "stalled", "resumable", "dead", "resolving",
  ];

  test("tone and label cover the union exactly", () => {
    expect(Object.keys(ROW_TONE).sort()).toEqual([...states].sort());
    expect(Object.keys(ROW_STATE_LABEL).sort()).toEqual([...states].sort());
  });

  test("the tones that mean «deal with me» are distinct from the quiet ones", () => {
    expect(ROW_TONE["intent-error"].chip).toContain("danger");
    expect(ROW_TONE.dead.chip).toContain("danger");
    expect(ROW_TONE.stalled.chip).toContain("warning");
    expect(ROW_TONE.live.chip).toContain("success");
    /* Nothing but a hosted conversation may claim the live tone. */
    expect(ROW_TONE.resumable.chip).not.toContain("success");
    expect(ROW_TONE.resolving.chip).not.toContain("success");
  });
});
