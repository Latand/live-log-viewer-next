import fs from "node:fs";
import path from "node:path";

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
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("title = a semantic task name");
});

test("the canonical direct-spawn example includes the mandatory semantic title", () => {
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/live-log-viewer-orchestration/SKILL.md"), "utf8");
  expect(skill).toContain('"title":"<semantic task title>"');
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
