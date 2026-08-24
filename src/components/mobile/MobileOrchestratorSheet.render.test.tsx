import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import { translate } from "@/lib/i18n";
import { ORCHESTRATOR_PROMPT_VERSION } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

import type { OrchestratorPanelState } from "../orchestrator/seatState";
import { MobileOrchestratorSheet } from "./MobileOrchestratorSheet";

const designatedAt = "2026-08-24T09:00:00.000Z";
const firstTurnAt = Date.parse("2026-08-24T09:00:01.000Z");
const firstStatusAt = Date.parse("2026-08-24T09:00:03.000Z");

const seat: OrchestratorSeat = {
  project: "atlas",
  seatEpoch: 4,
  conversationId: "conversation_orchestrator",
  path: "/transcripts/orchestrator.jsonl",
  mandate: "run the board",
  promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  predecessorConversationId: null,
  state: "active",
  intent: { clientRequestId: "req-11111111", mode: "spawn", launchId: "launch-1", error: null },
  designatedAt,
  activatedAt: "2026-08-24T09:00:02.000Z",
};

const state: Extract<OrchestratorPanelState, { kind: "live" }> = {
  kind: "live",
  seat,
  conversationId: seat.conversationId!,
  liveness: "stalled",
  rotation: null,
  transition: null,
};

function stalledFile(overrides: Partial<FileEntry> = {}): FileEntry {
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
    activity: "stalled",
    proc: "running",
    pid: 42,
    model: "opus",
    conversationId: seat.conversationId,
    pendingQuestion: null,
    waitingInput: null,
    lastTurn: { startedAt: firstTurnAt, endedAt: null },
    lastAssistantMessageAt: null,
    ...overrides,
  } as FileEntry;
}

const quietCopy = translate("en", "orchPanel.stalled");

function quietBannerCount(file: FileEntry): number {
  const html = renderToStaticMarkup(
    <MobileOrchestratorSheet
      project="atlas"
      projectName="Atlas"
      state={state}
      file={file}
      pendingMandate=""
      submitting={false}
      onConfirm={() => undefined}
      onRecheck={() => undefined}
      onOpenConversation={() => undefined}
      onClose={() => undefined}
    />,
  );
  return html.split(quietCopy).length - 1;
}

test("the mobile sheet hides the quiet banner while the first mandate turn is in flight", () => {
  expect(quietBannerCount(stalledFile())).toBe(0);
});

test("the mobile sheet keeps the quiet banner hidden after acknowledgement in the current turn", () => {
  expect(quietBannerCount(stalledFile({ lastAssistantMessageAt: firstStatusAt }))).toBe(0);
});

test("the mobile sheet shows the quiet banner for a later stalled turn", () => {
  expect(quietBannerCount(stalledFile({
    lastTurn: { startedAt: Date.parse("2026-08-24T09:30:00.000Z"), endedAt: null },
    lastAssistantMessageAt: firstStatusAt,
  }))).toBe(1);
});

test("the mobile sheet preserves the quiet warning when assistant history is unknown", () => {
  expect(quietBannerCount(stalledFile({ lastAssistantMessageAt: undefined }))).toBe(1);
});
