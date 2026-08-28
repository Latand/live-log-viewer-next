import { expect, test } from "bun:test";

import { proposalRef, seatTickProposalMessage, seatTickWakeMessage } from "./message";

const PROJECT = "viewer";

test("a wake says why, lists the items, and carries the contract every clause of which answers a real failure", () => {
  const text = seatTickWakeMessage({
    project: PROJECT,
    reasons: [{ kind: "stalled", detail: "pipeline pipeline_a1 stage review is parked" }],
    items: [{ kind: "pipeline", id: "pipeline_a1", label: "ship the exporter — parked" }],
    deferred: 2,
    signals: [{ id: "deploy", label: "the last deployment ended rolled-back" }],
  });
  expect(text).toContain("Seat tick — viewer.");
  expect(text).toContain("stalled: pipeline pipeline_a1 stage review is parked");
  expect(text).toContain("[pipeline] pipeline_a1 — ship the exporter — parked");
  expect(text).toContain("2 more item(s) held back for the next wake");
  expect(text).toContain("the last deployment ended rolled-back");
  expect(text).toContain("Act on the listed items only");
  expect(text).toContain("mark its task blocked with the reason");
  expect(text).toContain("Do not schedule yourself");
  expect(text).toContain("Do not wait on the operator inside this turn");
});

test("a wake with nothing deferred and no signals says neither", () => {
  const text = seatTickWakeMessage({
    project: PROJECT,
    reasons: [{ kind: "interval", detail: "the wake interval elapsed while work is open" }],
    items: [],
    deferred: 0,
    signals: [],
  });
  expect(text).not.toContain("held back");
  expect(text).not.toContain("Signals:");
});

test("the proposal brief asks for one ranked card and forbids opening issues or lanes from it", () => {
  const text = seatTickProposalMessage({
    project: PROJECT,
    issues: [{ number: 1245, title: "the native seat tick", labels: ["design", "monitor"], updatedAt: null }],
    signals: [],
    items: 5,
    slot: "20693",
  });
  expect(text).toContain("#1245 the native seat tick [design, monitor]");
  expect(text).toContain("ONE ranked list of at most 5 actions");
  expect(text).toContain("single board card in inbox");
  expect(text).toContain(`monitor-ref: ${proposalRef("20693")}`);
  expect(text).toContain("Open no GitHub issue and start no pipeline from this");
});

test("an unreadable gh leaves the slot working from the board rather than failing the wake", () => {
  const text = seatTickProposalMessage({ project: PROJECT, issues: [], signals: [], items: 5, slot: "1" });
  expect(text).toContain("(none readable; rank from the board and the signals below)");
});

/* `monitorRefIn` reads `[A-Za-z0-9_-]{4,64}` — a colon in the ref would make the
   marker unreadable, and the next tick would mint a second proposal card. */
test("the proposal ref stays inside what the card marker can read back", () => {
  expect(proposalRef("20693")).toMatch(/^[A-Za-z0-9_-]{4,64}$/);
});
