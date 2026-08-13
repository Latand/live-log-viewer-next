import { expect, test } from "bun:test";

import { BRIDGE_REPORT_CLASSES } from "@/lib/bridge/types";

import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SPAWN_CONFIG, ORCHESTRATOR_SYSTEM_PROMPT } from "./prompt";

test("the manager spawns as Claude Opus 5 on low effort through the role preset", () => {
  expect(ORCHESTRATOR_SPAWN_CONFIG).toMatchObject({ engine: "claude", model: "opus", effort: "low", role: "orchestrator" });
});

test("system prompt carries the draft-only pipeline contract", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("NEVER auto-start pipelines");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("autoStart: false");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("presses Start himself");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("explicitly asked to start it in the same request");
});

test("system prompt encodes the conveyor loop and its bars", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("GitHub issue -> worktree lane -> implementer agent -> review flow -> merge bar");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("merge only on an APPROVE verdict");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("REVIEW_READY:");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("src = YOUR transcript path");
});

/* #982 / PRD #976 decision 7 — the operator talks to whoever they want, the manager
   included. Mandate v4 replaced #691's "You do not talk to the user" section with two
   channels: direct chat in the manager's own conversation, and bridge reports for the
   voice gateway. The tests below pin both halves of that contract so the prohibition
   cannot creep back in silently — in the replaced section or anywhere else. */

test("direct operator chat is sanctioned as a first-class channel", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Two channels to the operator");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("The operator talks to whoever they want, you included");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("answer them there");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("That channel is sanctioned and first-class");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("gateway");
});

test("no prohibition on addressing the operator survives anywhere in the mandate", () => {
  for (const prohibition of [
    "You do not talk to the user",
    "Never address the user",
    "never ask them a question directly",
    "you have no user-facing channel",
    "not as chat",
    "only through your reports",
  ]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain(prohibition);
  }
});

test("bridge reports survive as the second channel, for the operator away from the chat", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Bridge reports — the second channel (manager -> gateway)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("carries what must reach the operator while they are elsewhere");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Append one report per meaningful outcome, with a stable key");
});

/* Seats record the mandate version they were spawned on; `get_orchestrator` reports
   this constant as defaultPromptVersion, so a v3 seat reads as stale without a diff. */
test("the default mandate is at version 4", () => {
  expect(ORCHESTRATOR_PROMPT_VERSION).toBe(4);
});

test("the prompt names every bridge report class and no others", () => {
  for (const reportClass of BRIDGE_REPORT_CLASSES) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(reportClass);
  }
});

test("the prompt states the report body bounds so the gateway is never handed raw output", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("2 KB");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("no raw tool output");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("no full board dumps");
});

test("the prompt carries the directive trailer contract in the exact wire form", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("[bridge ref=<seq>]");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never read one into unrelated prose");
});

/* #795 (superseding contract) — the designated agent decides the deploy and
   executes it directly. The prompt must say where the authority comes from
   (the server-attributed seat), that the SHA is resolved internally, and that
   nothing is ever routed back through the user for approval. */
test("the prompt encodes the designated-agent deploy contract and its refusals", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("YOU decide when to deploy, and you execute it yourself");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Your authority is your designated seat, attributed server-side");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a seat acts only for its own project");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Resolve origin/main to a full 40-hex commit SHA yourself");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never route it through the user");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Deployments serialize");
});

test("the prompt forbids any user-facing confirmation step outright", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("ever asks the user to confirm, approve, repeat, or say a commit hash");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("There is no confirmation step for the user, anywhere");
});

test("the prompt tells the manager to re-derive board state rather than accumulate it", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Re-derive board state per turn");
});
