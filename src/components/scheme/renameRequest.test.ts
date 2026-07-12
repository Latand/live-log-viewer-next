import { expect, test } from "bun:test";

import { autoEditTokenFor, clearStaleRename, requestRename, type RenameRequest } from "./renameRequest";

test("F2 opens the expanded node, and a plain re-expand after close does not replay", () => {
  let request: RenameRequest = null;

  // F2 on node A → expand A, request A.
  request = requestRename(request, "A");
  expect(autoEditTokenFor(request, "A")).toBe(1);

  // Close the overlay (expanded → null): the consumed request is dropped.
  request = clearStaleRename(request, null);
  expect(request).toBeNull();

  // Plain re-expand of A (no F2): no token, so the editor stays closed and no
  // Collapse blur can persist an unintended rename.
  expect(autoEditTokenFor(request, "A")).toBeUndefined();
});

test("a second F2 on the same node reopens with a fresh token", () => {
  let request: RenameRequest = requestRename(null, "A");
  expect(autoEditTokenFor(request, "A")).toBe(1);
  request = requestRename(request, "A");
  expect(autoEditTokenFor(request, "A")).toBe(2);
});

test("a request for one node never leaks to another expanded node", () => {
  const request = requestRename(null, "A");
  // A different node is expanded → no token for it.
  expect(autoEditTokenFor(request, "B")).toBeUndefined();
  // Switching the expanded node away from A clears the stale request.
  expect(clearStaleRename(request, "B")).toBeNull();
});

test("a matching request survives an unrelated re-render (still expanded)", () => {
  const request = requestRename(null, "A");
  expect(clearStaleRename(request, "A")).toBe(request);
});
