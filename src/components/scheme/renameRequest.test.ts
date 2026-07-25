import { expect, test } from "bun:test";

import { autoEditTokenFor, clearStaleRename, requestRename, titleUnderRename, type RenameRequest } from "./renameRequest";

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

test("an imposed stage title yields to a pending rename, so the F2 editor still mounts (#658)", () => {
  const stageTitle = "Builder · integrate_v3_voice · stage 2/3";
  /* No rename in flight: the expanded stage pane carries its imposed identity
     instead of the prompt-derived transcript title. */
  expect(titleUnderRename(stageTitle, undefined)).toBe(stageTitle);
  /* F2 replayed into this overlay: the override steps aside for exactly as long
     as the token lives, so SessionTitle — the last rename path a stage
     transcript has — is mounted and editable. */
  const request: RenameRequest = requestRename(null, "/integrate");
  expect(titleUnderRename(stageTitle, autoEditTokenFor(request, "/integrate"))).toBeUndefined();
  /* A rename aimed at another node never suppresses this pane's identity. */
  expect(titleUnderRename(stageTitle, autoEditTokenFor(request, "/other"))).toBe(stageTitle);
  /* A non-stage pane has no imposed title either way. */
  expect(titleUnderRename(undefined, undefined)).toBeUndefined();
});
