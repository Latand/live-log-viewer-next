import { expect, test } from "bun:test";

import { ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE, ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateForDelivery } from "@/lib/orchestrator/prompt";

import { mandateMessage } from "./mandateMessage";

/**
 * How the mandate card reads a delivered mandate (#1166). WHICH row is a
 * mandate is delivery evidence — see `deliveredMessageOccurrences.test.ts` —
 * so this module answers only what the card shows about a row already known to
 * be one: the size it stands in for, and where the rotation handoff starts.
 */

const HANDOFF = [
  "## Handoff from your predecessor (rotation)",
  "",
  "You are replacing orchestrator conversation conv-A for project demo.",
  "",
  "No open board tasks are recorded for this project.",
].join("\n");

test("a mandate with no rotation is one section, counted whole", () => {
  const message = mandateMessage(ORCHESTRATOR_SYSTEM_PROMPT);
  expect(message.handoff).toBeNull();
  expect(message.mandate).toContain("You are the viewer's built-in Manager");
  expect(message.lines).toBe(ORCHESTRATOR_SYSTEM_PROMPT.split("\n").length);
});

test("a rotation handoff becomes its own section, and never leaks into the mandate", () => {
  const message = mandateMessage(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${HANDOFF}`);
  expect(message.handoff).toContain("## Handoff from your predecessor");
  expect(message.handoff).toContain("conv-A");
  expect(message.mandate).toContain("You are the viewer's built-in Manager");
  expect(message.mandate).not.toContain("## Handoff from your predecessor");
  /* The count describes the whole delivered message, sections included. */
  expect(message.lines).toBeGreaterThan(message.mandate.split("\n").length);
});

test("the compact rotation history section splits the same way", () => {
  const history = "## Rotation history\n\n- seat 3 to seat 4 on 2026-08-20";
  const message = mandateMessage(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${history}`);
  expect(message.handoff).toBe(history);
  expect(message.mandate).not.toContain("## Rotation history");
});

test("the same words quoted inside a mandate never split it", () => {
  /* Not at the start of a line, so it is prose about a handoff, not one. */
  const quoting = "Read the section titled ## Handoff from your predecessor before you answer.";
  expect(mandateMessage(quoting).handoff).toBeNull();
  expect(mandateMessage(quoting).mandate).toBe(quoting);
});

test("a bespoke rotation keeps the appended status directive in the mandate, not in the handoff", () => {
  /* The shape delivery actually produces for an operator-edited rotation:
     the caller's own text, then the handoff, and THEN the initial-status
     directive, which delivery appends to any mandate that does not already
     carry it. The last section is the mandate's, on the far side of the
     handoff. */
  const bespoke = "You run the conveyor for atlas. Ship issue #7 first.";
  const delivered = orchestratorMandateForDelivery(`${bespoke}\n\n${HANDOFF}`);
  const message = mandateMessage(delivered);

  expect(message.handoff).toBe(HANDOFF);
  expect(message.handoff).not.toContain("## Initial visible status");
  expect(message.mandate).toContain(bespoke);
  expect(message.mandate).toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  expect(message.lines).toBe(delivered.split("\n").length);
});

test("handoffs stacked by successive rotations stay one disclosure", () => {
  /* Each rotation appends its handoff to the mandate it inherited, so an
     unrotated-away lineage arrives as consecutive sections. */
  const second = HANDOFF.replace("conv-A", "conv-B");
  const message = mandateMessage(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${HANDOFF}\n\n${second}`);

  expect(message.handoff).toContain("conv-A");
  expect(message.handoff).toContain("conv-B");
  expect(message.mandate).toBe(ORCHESTRATOR_SYSTEM_PROMPT.trim());
});
