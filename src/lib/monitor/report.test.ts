import { expect, test } from "bun:test";

import { seatTickProposalRef } from "./cards";
import { seatTickProposalMessage, seatTickWakeMessage } from "./report";

/**
 * The seat tick's two briefs (#1245), rendered by the module that already
 * renders the monitor's own report.
 */

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
  /* #1275: the brief that forbids self-scheduling has to name the lever on the
     schedule the Viewer arms instead, or the seat has one half of a rule. */
  expect(text).toContain("seat_tick_settings");
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
  expect(text).toContain(`monitor-ref: ${seatTickProposalRef("20693")}`);
  expect(text).toContain("Open no GitHub issue and start no pipeline from this");
});

test("an unreadable gh leaves the slot working from the board rather than failing the wake", () => {
  const text = seatTickProposalMessage({ project: PROJECT, issues: [], signals: [], items: 5, slot: "1" });
  expect(text).toContain("(none readable; rank from the board and the signals below)");
});

/* `monitorRefIn` reads `[A-Za-z0-9_-]{4,64}` — a colon in the ref would make the
   marker unreadable, and the next tick would mint a second proposal card. */
test("the proposal ref stays inside what the card marker can read back", () => {
  expect(seatTickProposalRef("20693")).toMatch(/^[A-Za-z0-9_-]{4,64}$/);
});

/* ------------------------------------------------------------------------- *
 * The project's own monitor prompt (#1280).
 * ------------------------------------------------------------------------- */

const HEADING = "Standing monitor note for this project";

function wake(prompt?: string | null): string {
  return seatTickWakeMessage({
    project: PROJECT,
    reasons: [{ kind: "interval", detail: "the wake interval elapsed while work is open" }],
    items: [{ kind: "pipeline", id: "pipeline_a1", label: "ship the exporter — running" }],
    deferred: 0,
    signals: [{ id: "deploy", label: "the last deployment ended rolled-back" }],
    ...(prompt === undefined ? {} : { monitorPrompt: prompt }),
  });
}

test("a wake carries the project's own monitor prompt beside what the tick derived, above an untouched contract", () => {
  const text = wake("before anything else, check whether the nightly digest actually sent");
  expect(text).toContain(HEADING);
  expect(text).toContain("before anything else, check whether the nightly digest actually sent");
  /* Appended, never a substitution: the reasons, the items, the signals and
     every clause of the contract are still exactly where they were. */
  expect(text).toContain("interval: the wake interval elapsed while work is open");
  expect(text).toContain("[pipeline] pipeline_a1 — ship the exporter — running");
  expect(text).toContain("the last deployment ended rolled-back");
  expect(text).toContain("Act on the listed items only");
  expect(text).toContain("Do not schedule yourself");
  expect(text).toContain("Do not wait on the operator inside this turn");
  /* And the contract has the last word, so a prompt cannot read as the thing
     that governs what the turn may do. */
  expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf("Contract:"));
});

test("a project with no prompt gets exactly the wake it got before the field existed", () => {
  const before = wake();
  expect(before).not.toContain(HEADING);
  /* Absent, empty and explicitly cleared are one behaviour: the unchanged
     message, byte for byte. */
  expect(wake(null)).toBe(before);
  expect(wake("")).toBe(before);
});

test("the proposal slot carries the prompt too, and without one is unchanged", () => {
  const proposal = (prompt?: string | null) => seatTickProposalMessage({
    project: PROJECT,
    issues: [],
    signals: [],
    items: 5,
    slot: "20693",
    ...(prompt === undefined ? {} : { monitorPrompt: prompt }),
  });
  const text = proposal("rank the deploy-blocking issues first; I keep missing them");
  expect(text).toContain(HEADING);
  expect(text).toContain("rank the deploy-blocking issues first; I keep missing them");
  expect(text).toContain("ONE ranked list of at most 5 actions");
  expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf("Contract:"));
  expect(proposal()).not.toContain(HEADING);
  expect(proposal(null)).toBe(proposal());
});
