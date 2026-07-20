import { expect, test } from "bun:test";

import { toolEvent } from "./__fixtures__/readableTools";
import { formatDuration, groupNestedCalls, isFollowUpCall } from "./toolBlocks";

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

test("formatDuration scales from ms to seconds to minutes", () => {
  expect(formatDuration(240)).toBe("240ms");
  expect(formatDuration(2500)).toBe("2.5s");
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(62_000)).toBe("1m 2s");
  expect(formatDuration(-5)).toBe("");
});
