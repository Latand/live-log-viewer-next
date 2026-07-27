import { expect, test } from "bun:test";

import { BRIDGE_REPORT_CLASSES } from "@/lib/bridge/types";

import { ORCHESTRATOR_SPAWN_CONFIG, ORCHESTRATOR_SYSTEM_PROMPT } from "./prompt";

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

/* #691 — the half of the load-bearing constraint that only a prompt can carry: the
   manager has no user-facing channel, so it must not try to use one. */

test("the manager is told it does not talk to the user", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("You do not talk to the user");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Never address the user");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("gateway");
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
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("[bridge ref=<seq> nonce=<nonce> sha=<sha>]");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never read an answer into unrelated prose");
});

test("the prompt encodes the deploy round trip and its refusals", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("40-hex SHA");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("confirm: \"deploy\"");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("One confirmation authorizes one SHA once");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("silence past expiry");
});

test("the prompt tells the manager to re-derive board state rather than accumulate it", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Re-derive board state per turn");
});
