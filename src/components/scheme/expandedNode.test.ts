import { expect, test } from "bun:test";

import { resolveExpandedNode } from "./expandedNode";

const node = (path: string, predecessorPath?: string) => ({ file: { path, predecessorPath } });

test("resolves a present node directly by path", () => {
  const a = node("/a.jsonl");
  const b = node("/b.jsonl");
  expect(resolveExpandedNode([a, b], "/b.jsonl")).toBe(b);
  expect(resolveExpandedNode([a, b], null)).toBeNull();
  expect(resolveExpandedNode([a, b], "/missing.jsonl")).toBeNull();
});

test("after a succession removes the predecessor, resolves the successor via predecessorPath", () => {
  // The predecessor "/gen1" is gone; the successor carries predecessorPath.
  const successor = node("/gen2.jsonl", "/gen1.jsonl");
  const other = node("/x.jsonl");
  expect(resolveExpandedNode([successor, other], "/gen1.jsonl")).toBe(successor);
  // And still resolves directly once `expanded` is synced to the new path.
  expect(resolveExpandedNode([successor, other], "/gen2.jsonl")).toBe(successor);
});

test("prefers a direct path match over a predecessor link", () => {
  // Mid-succession both may be present briefly; the live predecessor wins.
  const predecessor = node("/gen1.jsonl");
  const successor = node("/gen2.jsonl", "/gen1.jsonl");
  expect(resolveExpandedNode([successor, predecessor], "/gen1.jsonl")).toBe(predecessor);
});
