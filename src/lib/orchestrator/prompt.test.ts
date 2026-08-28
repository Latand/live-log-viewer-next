import fs from "node:fs";
import path from "node:path";

import { expect, test } from "bun:test";

import { FOCUS_TARGET_KINDS } from "@/lib/attention/targets";
import { BRIDGE_REPORT_CLASSES } from "@/lib/bridge/types";

import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SPAWN_CONFIG,
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE,
  ORCHESTRATOR_VIEWER_CLOCK_HEADING,
  orchestratorMandateForDelivery,
} from "./prompt";

test("the manager draft defaults to Claude Opus 5 on low effort through the role preset", () => {
  /* OrchestratorPanel seeds its shared launch controls from this live preset. */
  expect(ORCHESTRATOR_SPAWN_CONFIG).toMatchObject({ engine: "claude", model: "opus", effort: "low", role: "orchestrator" });
});

test("system prompt carries the start-by-default pipeline contract", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Start-by-default pipeline contract");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("autoStart: true");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("put the work in motion without a confirmation step or draft");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("autoStart: false");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("explicitly asks for a draft or to review the plan first in that request");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("press Start on the board");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("NEVER auto-start");
});

/* #982 — pipeline requests used to carry different authority depending on whether
   they arrived in the manager's own conversation or through the gateway. Under PRD
   #976 decision 7 both channels are equal, including an explicit request for a draft. */
test("the explicit draft request treats direct chat and the gateway as equal channels", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("asked in your own conversation or relayed through the gateway");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("both channels carry the same authority");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("same request, relayed through the gateway");
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
   this constant as defaultPromptVersion, so an older seat reads as stale without a diff. */
test("the default mandate is at version 11", () => {
  expect(ORCHESTRATOR_PROMPT_VERSION).toBe(11);
});

/* #1202 — every ask the manager makes should be answerable with a tap, so the
   rule that produces the drafts is part of the mandate, not a convention. */
test("the mandate tells the seat to offer reply drafts whenever it asks or proposes something", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Reply drafts (suggest_replies)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Call suggest_replies after EVERY message of yours that asks the operator something or proposes a course of action");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("2\u20134 short, distinct drafts");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("in the operator's own language");
  /* A draft is an offer: the mandate must never read as the viewer answering. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never a decision");
});

test("the mandate greets a fresh seat and preserves the exact rotation standby status", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Initial visible status");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Your first turn after receiving this mandate");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("FRESH seat with no missions");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Ready in {project}.\nTell me what to ship — I open lanes, spawn implementers and reviewers, and merge on APPROVE. Nothing starts until you ask.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("ROTATION");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("inventory the mandate missions and state your plan");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("all mandate missions are complete; standing by");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("generic continuation nudge");
});

/* #1245 v11 — the Viewer owns the clock. This paragraph is not documentation:
   production measured a seat whose own session cron kept its turn open, so the
   native tick logged 20 consecutive "skipped — the seat's turn is progressing"
   and could never reach it. The two mechanisms deadlock, and the only thing
   that breaks the deadlock is the seat dropping its own schedule first. So the
   mandate has to say that, in that order, and say it to a seat that is already
   holding one. */
test("the mandate hands the clock to the Viewer and forbids a seat scheduling itself", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## The Viewer's clock — you never schedule yourself");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("The Viewer wakes you");
  /* Named tool by tool: "do not self-schedule" alone left CronCreate looking
     like a different thing from ScheduleWakeup, and CronCreate is what the
     measured seat actually used. */
  for (const tool of ["ScheduleWakeup", "CronCreate", "Monitor"]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(tool);
  }
  /* Idle between wakes is the correct state, not a symptom to fix by arming
     something — the belief that produced the self-schedule in the first place. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Between wakes you are idle on purpose");
});

test("the mandate's own arrival is the handover, and it says why waiting cannot work", () => {
  /* The decision this PR had to make and state: an explicit step, because
     "retire the fallback once you observe a native wake" is unsatisfiable while
     the fallback is what prevents the wake. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("cancel it in this turn");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("the arrival of this mandate is the handover, not a later observation");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("CronDelete");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Do not wait to \"see the Viewer's tick work first\"");
  /* The mechanism spelled out, so a seat that reasons about the instruction
     reaches the same conclusion instead of deciding it is over-cautious. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("the Viewer's tick finds you busy and drops its check every time");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Yours goes first");
});

test("the conveyor skill reference is portable across checkouts, and subordinate to the mandate", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("If this checkout carries an llv-conveyor skill, it is your playbook, subordinate to this mandate wherever the two disagree; otherwise the conveyor rules above are the playbook.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("The llv-conveyor skill in this checkout is your playbook");
});

/* #1245 — a mandate that forbids self-scheduling while the playbook it points
   at demands one is worse than neither: the seat has to pick, and the rule
   stops being enforceable. The playbook lives in this repository, so the
   agreement is checkable here rather than left to whoever edits it next. */
test("the checked-in playbook agrees with the mandate about the clock", () => {
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/llv-conveyor/SKILL.md"), "utf8");
  expect(skill).toContain("The Viewer owns the clock");
  expect(skill).toContain("the seat never schedules itself");
  /* The exact instruction that contradicted the mandate: self-pacing on a
     wakeup interval, which is what the measured seat was doing. */
  expect(skill).not.toContain("self-paces with ScheduleWakeup");
  expect(skill).not.toContain("ScheduleWakeup checkpoints");
});

test("mandate delivery keys off directive content and appends it exactly once", () => {
  const custom = "Caller-edited current-version mandate";
  const delivered = orchestratorMandateForDelivery(custom);

  expect(delivered).toStartWith(custom);
  expect(delivered.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
});

/* #1245 — the handover has to reach the seat that is actually holding a
   schedule, and that seat is precisely the one NOT carrying the current
   default: a rotation hands the successor the incumbent's mandate and version,
   and a bespoke mandate never had the paragraph at all. A paragraph that lived
   only inside the versioned default would change the clock's owner without
   telling either of them. */
test("the clock handover reaches a bespoke or older mandate, exactly once", () => {
  const stale = "A v10 seat's own mandate, carried through a rotation.";
  const delivered = orchestratorMandateForDelivery(stale);

  expect(delivered).toStartWith(stale);
  expect(delivered).toContain(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE);
  expect(delivered).toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  expect(delivered.split(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE)).toHaveLength(2);
  /* Idempotent: re-delivery after a host death appends nothing, so a seat
     never reads the handover twice in one mandate. */
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  /* A mandate that already carries the paragraph — the current default, or a
     caller-edited copy of it — is delivered untouched. */
  expect(orchestratorMandateForDelivery(`${ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE}\n\nmy own rules`))
    .toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  expect(orchestratorMandateForDelivery(`${ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE}\n\nmy own rules`)
    .split(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE)).toHaveLength(2);

  /* And a caller who reworded the section under its own heading keeps THEIR
     wording. Appending the canonical copy beside it would deliver two clock
     instructions in one mandate, which is the shape this is fixing. */
  const reworded = `${ORCHESTRATOR_VIEWER_CLOCK_HEADING}\nWake only when the Viewer tells you to.`;
  expect(orchestratorMandateForDelivery(reworded)).not.toContain(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE);
  expect(orchestratorMandateForDelivery(reworded)).toStartWith(reworded);
});

/* The versioned default carries it inline, so a fresh seat reads it in place
   rather than as an appendix — and delivery has nothing to append. */
test("the current default already contains the clock directive", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE);
});

/* #1016 — the seat had the attention tool and never used it: nothing it read said
   when moving the operator was the right thing to do, and the tool published no
   target shape, so the one seat that tried gave up after five guesses. The mandate
   now carries both halves — the occasions, and the shapes to call them with. */
test("the mandate teaches proactive attention steering with the occasions for it", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Steering the operator's attention (request_attention)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("you just spawned or resumed a worker for something they asked for");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a review verdict, merge or deploy lands");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a lane blocks on THEM");
  /* Sparingly and tied to concrete work — the failure mode on the other side is a
     seat that yanks the view on every poll. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Do not move them for polling, routine status");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("One move per real outcome");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("NO_ACTIVE_VIEW");
});

/* Verbatim shapes, so a seat following only the mandate reaches the operator's
   screen on its FIRST call. Each is parsed here as the tool would receive it. */
test("the mandate carries working target shapes for every surface it names", () => {
  for (const shape of [
    '{"kind":"conversation","conversationId":"conversation_..."}',
    '{"kind":"conversation","path":"/.../transcript.jsonl"}',
    '{"kind":"stage","pipelineId":"pipeline_...","stageId":"review"}',
    '{"kind":"pipeline","pipelineId":"pipeline_..."}',
    '{"kind":"flowRound","flowId":"flow_...","round":2}',
    '{"kind":"task","taskId":"task_..."}',
    '{"kind":"draft","draftId":"draft_..."}',
  ]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(shape);
    const target = JSON.parse(shape) as { kind: string };
    /* Each printed shape is a real target of a real kind, discriminated the way
       the tool discriminates it. */
    expect(FOCUS_TARGET_KINDS).toContain(target.kind as never);
  }
  /* The two facts a first call also needs: the draft's extra argument, and that
     intent decides framing versus opening. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("plus a top-level project");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('intent "show" frames and highlights the card; intent "open" also opens it');
});

/* #1026 — a fresh seat composed its first pipeline through seven sequential
   validation errors because nothing it had read named the stage shape. The
   mandate now carries that contract, with the two rules the walk actually
   turned on: runtime overrides live on the stage, and `next` defaults to null
   so an unwired review-loop is unreachable. */
test("the mandate carries the pipeline stage contract a first pipeline needs", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Pipeline stage contract");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('kind: "run" | "review-loop"');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("role: {roleId, params?}");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never inside role");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("DEFAULTS TO null");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("pass-reachable from a run stage");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a draft that pins baseBranch must also pass baseRef");
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
