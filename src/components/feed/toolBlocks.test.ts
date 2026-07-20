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
    toolEvent({ id: "e1", tool: "exec_command", runtimeSessionId: "8479" }),
    toolEvent({ id: "w1", tool: "wait", runtimeSessionId: "8479" }),
    toolEvent({ id: "s1", tool: "write_stdin", runtimeSessionId: "8479" }),
    toolEvent({ id: "e2", tool: "Bash" }),
    toolEvent({ id: "r1", tool: "Read", family: "read" }),
  ];
  const blocks = groupNestedCalls(calls);
  expect(blocks.map((b) => b.parent.id)).toEqual(["e1", "e2", "r1"]);
  expect(blocks[0].children.map((c) => c.id)).toEqual(["w1", "s1"]);
  expect(blocks[1].children).toHaveLength(0);
});

test("a leading follow-up with no parent stands as its own block", () => {
  const blocks = groupNestedCalls([
    toolEvent({ id: "w1", tool: "wait", runtimeSessionId: "8479" }),
    toolEvent({ id: "w2", tool: "wait", runtimeSessionId: "8479" }),
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].parent.id).toBe("w1");
  expect(blocks[0].children.map((c) => c.id)).toEqual(["w2"]);
});

test("a follow-up never attaches to a neighboring command from another session", () => {
  const blocks = groupNestedCalls([
    toolEvent({ id: "e1", tool: "exec_command", runtimeSessionId: "111" }),
    toolEvent({ id: "e2", tool: "exec_command", runtimeSessionId: "222" }),
    toolEvent({ id: "w1", tool: "wait", runtimeSessionId: "111" }),
  ]);
  expect(blocks.map((block) => block.parent.id)).toEqual(["e1", "e2"]);
  expect(blocks[0].children.map((child) => child.id)).toEqual(["w1"]);
  expect(blocks[1].children).toHaveLength(0);
});

test("formatDuration scales from ms to seconds to minutes", () => {
  expect(formatDuration(240)).toBe("240ms");
  expect(formatDuration(2500)).toBe("2.5s");
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(62_000)).toBe("1m 2s");
  expect(formatDuration(-5)).toBe("");
});
