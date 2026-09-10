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
  cursor: { stageId: "b", state: "running", input: null, activatedBy: null }, runs: [],
} as unknown as Pipeline;

const hubLink: AgentLink = {
  key: "pl", kind: "pipeline", from: "/a", to: "/b", leg: "forward",
  pipeline: { pipeline, fromStageId: "a", toStageId: "b", tone: "active", index: 2, total: 2, hub: true, paused: false },
};

const render = (interactive: boolean, hubInteractive?: boolean) =>
  renderToStaticMarkup(
    <AgentLinksLayer links={[hubLink]} byPath={byPath} interactive={interactive} hubInteractive={hubInteractive} width={400} height={60} />,
  );

/**
 * The hub's own wrapper class, not the whole layer's markup.
 *
 * This used to be a substring test over everything the layer rendered, which
 * only worked while nothing else in it was pointer-transparent. The decorative
 * rails SVG is now `pointer-events-none` — an `aria-hidden` overlay must not
 * swallow the clicks meant for the band controls underneath it (#1614) — so a
 * whole-markup search no longer says anything about the hub. The contract
 * (#93 §2.3) is unchanged and is now asserted where it actually lives.
 */
const hubWrapperClass = (markup: string): string => {
  const wrapper = /<div class="([^"]*z-\[5\][^"]*)"/.exec(markup);
  expect(wrapper, "the hub wrapper is rendered").not.toBeNull();
  return wrapper![1]!;
};

test("the pipeline hub stays tappable on the lite map even when the layer is passive (#93 §2.3)", () => {
  /* Map mode passes interactive=false but hubInteractive=true: the hub wrapper
     must not be pointer-events-none, so its tap opens the controls. */
  expect(hubWrapperClass(render(false, true))).not.toContain("pointer-events-none");
});

test("without the hub override a passive layer leaves the hub untappable", () => {
  /* Default hubInteractive = interactive, so the old behavior (passive) holds. */
  expect(hubWrapperClass(render(false))).toContain("pointer-events-none");
});

test("the decorative rails never take pointer input, whether the layer is interactive or not (#1614)", () => {
  /* The rails are `aria-hidden`. An `<svg>` root is a replaced element whose
     whole box is hit-testable at the default `pointer-events: auto`, so a
     full-canvas decorative overlay would intercept every click meant for the
     band chrome beneath it. */
  for (const markup of [render(true), render(false, true)]) {
    const svg = /<svg[^>]*class="([^"]*)"[^>]*aria-hidden/.exec(markup);
    expect(svg, "the rails svg is rendered").not.toBeNull();
    expect(svg![1]!).toContain("pointer-events-none");
  }
});

test("a pipeline rail routes around an unrelated card between two stages (#136 finding 2)", () => {
  const from: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
  const to: SchemeRect = { x: 2000, y: 0, w: 600, h: 680 };
  /* An unrelated card straddling the straight rail (which runs at y≈354). */
  const mid: SchemeRect = { x: 1000, y: 0, w: 600, h: 680 };
  const bp = new Map<string, SchemeRect>([["/a", from], ["/b", to]]);
  const STRAIGHT = 'd="M 600 354 L 2000 354"';

  /* With nothing in the way the rail is the direct segment. */
  const clear = renderToStaticMarkup(
    <AgentLinksLayer links={[hubLink]} byPath={bp} obstacles={[from, to]} interactive width={2600} height={680} />,
  );
  expect(clear).toContain(STRAIGHT);

  /* With the card between the stages the rail is rerouted — no longer straight. */
  const routed = renderToStaticMarkup(
    <AgentLinksLayer links={[hubLink]} byPath={bp} obstacles={[from, mid, to]} interactive width={2600} height={680} />,
  );
  expect(routed).not.toContain(STRAIGHT);
});
