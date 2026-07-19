import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SchemeEdge } from "./layout";
import { EdgesLayer } from "./nodes";
import { createSubagentBadgeAnchorRegistry } from "./subagentBadgeAnchors";

const edge: SchemeEdge = {
  to: "/child",
  sourceConversationId: "parent",
  targetConversationId: "child",
  x1: 140,
  y1: 980,
  x2: 460,
  y2: 1110,
  color: "green",
  live: true,
};

test("structural edges start at a registered subagent circle and preserve the card fallback", () => {
  const registry = createSubagentBadgeAnchorRegistry();
  registry.replace("parent", new Map([["child", { x: 716, y: 255 }]]));

  const anchored = renderToStaticMarkup(<EdgesLayer edges={[edge]} badgeAnchors={registry} width={1200} height={1400} />);
  expect(anchored).toContain('d="M 716 255 C');
  expect(anchored).toContain('cx="716" cy="255"');

  const fallback = renderToStaticMarkup(
    <EdgesLayer edges={[edge]} badgeAnchors={createSubagentBadgeAnchorRegistry()} width={1200} height={1400} />,
  );
  expect(fallback).toContain('d="M 140 980 C');
  expect(fallback).toContain('cx="140" cy="980"');
});
