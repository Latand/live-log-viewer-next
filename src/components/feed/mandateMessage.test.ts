import { expect, test } from "bun:test";

import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "@/lib/orchestrator/prompt";

import { isOrchestratorMandateText, mandateMessage } from "./mandateMessage";

/**
 * The classification behind the mandate card (#1166). The seat delivers the
 * mandate as an ordinary message, so the feed used to render 8 KB of scaffold
 * as the operator's own bubble. Every delivered mandate — default, bespoke,
 * spawn-mode first prompt, adoption message — carries the initial-status
 * directive `orchestratorMandateForDelivery` guarantees, and that is what this
 * module recognizes.
 */

/** Exactly what the seat command hands to delivery. */
const delivered = (mandate: string): string =>
  mandate.includes(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)
    ? mandate
    : `${mandate}\n\n${ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE}`;

const HANDOFF = [
  "## Handoff from your predecessor (rotation)",
  "",
  "You are replacing orchestrator conversation conv-A for project demo.",
  "",
  "No open board tasks are recorded for this project.",
].join("\n");

test("the delivered default mandate is recognized; ordinary operator text is not", () => {
  expect(isOrchestratorMandateText(delivered(ORCHESTRATOR_SYSTEM_PROMPT))).toBe(true);
  expect(isOrchestratorMandateText("run the failing test again and paste the output")).toBe(false);
  /* A row that merely names the mandate is still the operator talking. */
  expect(isOrchestratorMandateText("your mandate says you own the board — re-read it")).toBe(false);
});

test("a bespoke mandate is recognized through the directive delivery appends to it", () => {
  const bespoke = "You run the conveyor for this project. Ship issue #7 first.";
  expect(isOrchestratorMandateText(bespoke)).toBe(false);
  expect(isOrchestratorMandateText(delivered(bespoke))).toBe(true);
});

test("the approved default is labelled with its own prompt version, with no seat in scope", () => {
  const message = mandateMessage(delivered(ORCHESTRATOR_SYSTEM_PROMPT));
  expect(message.label).toEqual({ kind: "version", version: ORCHESTRATOR_PROMPT_VERSION });
  expect(message.handoff).toBeNull();
  expect(message.lines).toBe(delivered(ORCHESTRATOR_SYSTEM_PROMPT).split("\n").length);
  expect(message.chars).toBe(delivered(ORCHESTRATOR_SYSTEM_PROMPT).length);
});

test("the seat's own prompt version outranks the text, so a stale default reads as its version", () => {
  const stale = delivered("An older approved mandate that this build no longer carries.");
  expect(mandateMessage(stale, 7).label).toEqual({ kind: "version", version: 7 });
});

test("a seat that recorded no prompt version labels its mandate custom", () => {
  const bespoke = delivered("You run the conveyor for this project. Ship issue #7 first.");
  expect(mandateMessage(bespoke, null).label).toEqual({ kind: "custom" });
});

test("an unrecognized mandate with no seat in scope claims nothing", () => {
  const bespoke = delivered("You run the conveyor for this project. Ship issue #7 first.");
  expect(mandateMessage(bespoke).label).toEqual({ kind: "unknown" });
});

test("a rotation handoff becomes its own section, and never leaks into the mandate", () => {
  const message = mandateMessage(delivered(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${HANDOFF}`), ORCHESTRATOR_PROMPT_VERSION);
  expect(message.handoff).toContain("## Handoff from your predecessor");
  expect(message.handoff).toContain("conv-A");
  expect(message.mandate).toContain("You are the viewer's built-in Manager");
  expect(message.mandate).not.toContain("## Handoff from your predecessor");
  /* The counts describe the whole delivered message, sections included. */
  expect(message.chars).toBeGreaterThan(message.mandate.length);
});

test("the compact rotation history section splits the same way", () => {
  const history = "## Rotation history\n\n- seat 3 → seat 4 on 2026-08-20";
  const message = mandateMessage(delivered(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${history}`));
  expect(message.handoff).toBe(history);
  expect(message.mandate).not.toContain("## Rotation history");
});

test("the directive delivery appends after a bespoke handoff stays with the mandate", () => {
  /* A bespoke rotation: the handoff is appended to the mandate, and only then
     does delivery append the directive — so it lands AFTER the handoff in the
     wire text while belonging to the mandate. */
  const text = delivered(`Ship issue #7 first.\n\n${HANDOFF}`);
  const message = mandateMessage(text, null);
  expect(message.mandate).toContain("Ship issue #7 first.");
  expect(message.mandate).toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  expect(message.handoff).toContain("## Handoff from your predecessor");
  expect(message.handoff).not.toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
});
