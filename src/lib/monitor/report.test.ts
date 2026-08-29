import { expect, test } from "bun:test";

import { seatTickProposalRef } from "./cards";
import { SEAT_TICK_CONTRACT, seatTickProposalMessage, seatTickWakeMessage } from "./report";

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

/* ------------------------------------------------------------------------- *
 * The contract the limit used to eat (#1280).
 *
 * A production-shaped five-item wake runs to just under 2,900 characters and
 * carries every contract clause. Adding a prompt of the full thousand the
 * settings writer accepts landed the joined message on exactly the 4,000-
 * character limit, and the clamp took the closing clause off the end — the one
 * that says not to wait on the operator — with nothing in the message to say
 * anything had gone. The contract is what tells a seat not to schedule itself
 * and what its stop is, so it is reserved and the agenda is what gives way.
 * ------------------------------------------------------------------------- */

const MAX_PROMPT = "check the digest, then the deploy ledger, then the review queue — in that order, every tick. "
  .repeat(11)
  .slice(0, 1000);

function fullAgenda(monitorPrompt?: string) {
  const detail = " and the rest of the sentence a real board card carries".repeat(5);
  return {
    project: PROJECT,
    reasons: [
      { kind: "lane-event" as const, detail: `pipeline pipeline_a1 stage review recorded a verdict${detail}` },
      { kind: "stalled" as const, detail: `pipeline pipeline_b2 has not moved for three hours${detail}` },
      { kind: "interval" as const, detail: "the wake interval elapsed while work is open" },
    ],
    items: [
      { kind: "pipeline" as const, id: "pipeline_a1", label: `ship the exporter — parked at review${detail}` },
      { kind: "pipeline" as const, id: "pipeline_b2", label: `the digest connector — running, stage build${detail}` },
      { kind: "task" as const, id: "task_c3", label: `the card asking for the worktree census${detail}` },
      { kind: "task" as const, id: "task_d4", label: `the deploy ledger surface nobody has read${detail}` },
      { kind: "pipeline" as const, id: "pipeline_e5", label: `the settings lane — waiting on a reviewer${detail}` },
    ],
    deferred: 3,
    signals: [
      { id: "deploy", label: `the last deployment ended rolled-back${detail}` },
      { id: "limits", label: `one account is inside its five-hour limit window${detail}` },
    ],
    ...(monitorPrompt === undefined ? {} : { monitorPrompt }),
  };
}

test("a maximum-length prompt on a full agenda keeps every contract clause, and shortens the agenda instead", () => {
  expect(MAX_PROMPT).toHaveLength(1_000);
  const agenda = seatTickWakeMessage(fullAgenda());
  /* The fixture is genuinely over budget: without the reservation the prompt
     could only be fitted by eating the foot of the message. */
  expect(agenda.length + MAX_PROMPT.length).toBeGreaterThan(4_000);

  const text = seatTickWakeMessage(fullAgenda(MAX_PROMPT));
  expect(text.length).toBeLessThanOrEqual(4_000);
  /* Every clause, including the ones a hand-written list would miss — and the
     last of them is the last thing the seat reads, so nothing was lopped off. */
  for (const clause of SEAT_TICK_CONTRACT) expect(text).toContain(clause);
  expect(text.endsWith(`- ${SEAT_TICK_CONTRACT.at(-1)}`)).toBe(true);
  /* The prompt is reserved whole too: half an instruction is its own hazard. */
  expect(text).toContain(MAX_PROMPT);
  /* And the agenda is what gave way, with the ellipsis that says so. */
  expect(text).toContain("…");
});

test("a long issue list cannot cost the proposal its ref line, its prompt or its contract", () => {
  const text = seatTickProposalMessage({
    project: PROJECT,
    issues: Array.from({ length: 200 }, (_unused, index) => ({
      number: 1_000 + index,
      title: "an issue with a title of roughly the length the backlog actually carries",
      labels: ["design", "monitor"],
      updatedAt: null,
    })),
    signals: [],
    items: 5,
    slot: "20693",
    monitorPrompt: MAX_PROMPT,
  });
  expect(text.length).toBeLessThanOrEqual(4_000);
  /* The ref line is what the next tick reads to recognize the card it already
     asked for; losing it to a long backlog would mint a second proposal. */
  expect(text).toContain(`monitor-ref: ${seatTickProposalRef("20693")}`);
  expect(text).toContain(MAX_PROMPT);
  for (const clause of SEAT_TICK_CONTRACT) expect(text).toContain(clause);
});
