import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline } from "@/lib/pipelines/types";
import type { SchemeRect } from "@/components/scheme/layout";

import { AgentLinksLayer } from "./nodes";
import type { AgentLink } from "./agentLinks";

const byPath = new Map<string, SchemeRect>([
  ["/a", { x: 0, y: 0, w: 100, h: 60 }],
  ["/b", { x: 300, y: 0, w: 100, h: 60 }],
]);

const pipeline = {
  id: "p1", task: "t", state: "running", stages: [{ id: "a", kind: "run" }, { id: "b", kind: "run" }],
  cursor: { stageId: "b", state: "running" }, runs: [],
} as unknown as Pipeline;

const hubLink: AgentLink = {
  key: "pl", kind: "pipeline", from: "/a", to: "/b", leg: "forward",
  pipeline: { pipeline, fromStageId: "a", toStageId: "b", tone: "active", index: 2, total: 2, hub: true, paused: false },
};

const render = (interactive: boolean, hubInteractive?: boolean) =>
  renderToStaticMarkup(
    <AgentLinksLayer links={[hubLink]} byPath={byPath} interactive={interactive} hubInteractive={hubInteractive} width={400} height={60} />,
  );

test("the pipeline hub stays tappable on the lite map even when the layer is passive (#93 §2.3)", () => {
  /* Map mode passes interactive=false but hubInteractive=true: the hub wrapper
     must not be pointer-events-none, so its tap opens the controls. */
  expect(render(false, true)).not.toContain("pointer-events-none");
});

test("without the hub override a passive layer leaves the hub untappable", () => {
  /* Default hubInteractive = interactive, so the old behavior (passive) holds. */
  expect(render(false)).toContain("pointer-events-none");
});
