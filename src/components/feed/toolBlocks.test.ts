import { expect, test } from "bun:test";

import { emptyPoll, toolEvent } from "./__fixtures__/readableTools";
import { coalesceFollowUps, formatDuration, groupNestedCalls, isCollapsiblePoll, isFollowUpCall } from "./toolBlocks";

test("wait and write_stdin are follow-ups; a plain exec is not", () => {
  expect(isFollowUpCall(toolEvent({ tool: "wait" }))).toBe(true);
  expect(isFollowUpCall(toolEvent({ tool: "write_stdin" }))).toBe(true);
  expect(isFollowUpCall(toolEvent({ tool: "Bash" }))).toBe(false);
  expect(isFollowUpCall(toolEvent({ tool: "exec_command" }))).toBe(false);
});

test("follow-ups nest under the preceding exec while peers stay separate blocks", () => {
  const calls = [
    toolEvent({ id: "e1", tool: "exec_command" }),
    toolEvent({ id: "w1", tool: "wait" }),
    toolEvent({ id: "s1", tool: "write_stdin" }),
    toolEvent({ id: "e2", tool: "Bash" }),
    toolEvent({ id: "r1", tool: "Read", family: "read" }),
  ];
  const blocks = groupNestedCalls(calls);
  expect(blocks.map((b) => b.parent.id)).toEqual(["e1", "e2", "r1"]);
  expect(blocks[0].children.map((c) => c.id)).toEqual(["w1", "s1"]);
  expect(blocks[1].children).toHaveLength(0);
});

test("a leading follow-up with no parent stands as its own block", () => {
  const blocks = groupNestedCalls([toolEvent({ id: "w1", tool: "wait" }), toolEvent({ id: "w2", tool: "wait" })]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].parent.id).toBe("w1");
  expect(blocks[0].children.map((c) => c.id)).toEqual(["w2"]);
});

test("interleaved sessions: each follow-up nests under the exec that owns its session", () => {
  /* Two execs open two sessions, then their follow-ups arrive out of order.
     Positional last-block nesting would wrongly hand session 1's wait to exec 2;
     each follow-up must fold under the exec that actually owns its session. */
  const calls = [
    toolEvent({ id: "eA", tool: "exec_command", session: "1" }),
    toolEvent({ id: "eB", tool: "exec_command", session: "2" }),
    toolEvent({ id: "wA", tool: "wait", session: "1" }),
    toolEvent({ id: "sB", tool: "write_stdin", session: "2" }),
    toolEvent({ id: "wB", tool: "wait", session: "2" }),
  ];
  const blocks = groupNestedCalls(calls);
  expect(blocks.map((b) => b.parent.id)).toEqual(["eA", "eB"]);
  expect(blocks[0].children.map((c) => c.id)).toEqual(["wA"]);
  expect(blocks[1].children.map((c) => c.id)).toEqual(["sB", "wB"]);
});

test("a follow-up whose session matches no exec stays standalone", () => {
  const calls = [
    toolEvent({ id: "eA", tool: "exec_command", session: "1" }),
    toolEvent({ id: "wOrphan", tool: "wait", session: "9" }),
    toolEvent({ id: "wA", tool: "wait", session: "1" }),
  ];
  const blocks = groupNestedCalls(calls);
  // The orphaned wait is its own block; the matching wait still folds under eA.
  expect(blocks.map((b) => b.parent.id)).toEqual(["eA", "wOrphan"]);
  expect(blocks[0].children.map((c) => c.id)).toEqual(["wA"]);
  expect(blocks[1].children).toHaveLength(0);
});

test("only a bare empty poll is collapsible — keystrokes, output, and errors are not", () => {
  // A wait/empty write_stdin with no captured output collapses.
  expect(isCollapsiblePoll(emptyPoll("p1"))).toBe(true);
  expect(isCollapsiblePoll(toolEvent({ tool: "write_stdin", poll: true, outputPreview: "" }))).toBe(true);
  // A poll that surfaced output stays a full readable row.
  expect(isCollapsiblePoll(emptyPoll("p2", { outputPreview: "ready" }))).toBe(false);
  // A keystroke write_stdin is never a poll.
  expect(isCollapsiblePoll(toolEvent({ tool: "write_stdin", poll: false, outputPreview: "" }))).toBe(false);
  // A failed poll keeps its own row so the failure is never hidden.
  expect(isCollapsiblePoll(emptyPoll("p3", { status: "err", statusLabel: "exit 1" }))).toBe(false);
  // A poll that carries a stderr stream is not collapsed.
  expect(isCollapsiblePoll(emptyPoll("p4", { stderr: "boom" }))).toBe(false);
  // A plain exec is never a poll.
  expect(isCollapsiblePoll(toolEvent({ tool: "Bash" }))).toBe(false);
});

test("consecutive empty polls coalesce into one counted run with summed elapsed", () => {
  const children = [emptyPoll("p1"), emptyPoll("p2"), emptyPoll("p3")];
  const out = coalesceFollowUps(children);
  expect(out).toHaveLength(1);
  expect(out[0].kind).toBe("polls");
  if (out[0].kind !== "polls") throw new Error("expected a polls run");
  expect(out[0].events).toHaveLength(3);
  expect(out[0].session).toBe("8479");
  // Each fixture poll carries a 5s wall-time; the run sums them.
  expect(out[0].elapsedMs).toBe(15000);
});

test("keystrokes and output-bearing waits break the poll run and stay their own rows", () => {
  const children = [
    emptyPoll("p1"),
    emptyPoll("p2"),
    toolEvent({ id: "k1", tool: "write_stdin", poll: false, summary: "stdin → 8479 · y⏎" }),
    emptyPoll("p3"),
    emptyPoll("p4", { outputPreview: "ready" }),
    emptyPoll("p5"),
  ];
  const out = coalesceFollowUps(children);
  // run(p1,p2) · call(k1) · run(p3) · call(p4 with output) · run(p5)
  expect(out.map((c) => c.kind)).toEqual(["polls", "call", "polls", "call", "polls"]);
  if (out[0].kind !== "polls") throw new Error("expected a polls run");
  expect(out[0].events.map((e) => e.id)).toEqual(["p1", "p2"]);
});

test("a single empty poll still collapses — a run of one, so its empty body never renders", () => {
  const out = coalesceFollowUps([emptyPoll("solo")]);
  expect(out).toHaveLength(1);
  expect(out[0].kind).toBe("polls");
});

test("formatDuration scales from ms to seconds to minutes", () => {
  expect(formatDuration(240)).toBe("240ms");
  expect(formatDuration(2500)).toBe("2.5s");
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(62_000)).toBe("1m 2s");
  expect(formatDuration(-5)).toBe("");
});
