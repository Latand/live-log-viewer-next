import { expect, test } from "bun:test";

import { createSubagentBadgeAnchorRegistry } from "./subagentBadgeAnchors";

test("an older identical registration cannot remove the current badge anchor", () => {
  const registry = createSubagentBadgeAnchorRegistry();
  const anchors = new Map([["child", { x: 12, y: 34 }]]);
  const releaseFirst = registry.replace("parent", anchors);
  const releaseCurrent = registry.replace("parent", anchors);

  releaseFirst();
  expect(registry.anchorFor("parent", "child")).toEqual({ x: 12, y: 34 });

  releaseCurrent();
  expect(registry.anchorFor("parent", "child")).toBeNull();
});
