import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GroupsLayer } from "./nodes";
import type { SchemeGroup } from "./layout";

const flowGroup: SchemeGroup = {
  key: "group::flow::f1",
  kind: "flow",
  id: "f1",
  hue: 210,
  members: ["/impl", "deck::f1"],
  label: "Ship the group overlay",
  x: 80,
  y: 60,
  w: 900,
  h: 780,
};

const pipelineGroup: SchemeGroup = {
  key: "group::pipeline::p1",
  kind: "pipeline",
  id: "p1",
  hue: 24,
  members: ["/plan", "/build"],
  label: "Refactor the scheme",
  x: 1200,
  y: 60,
  w: 1400,
  h: 780,
};

const render = (groups: SchemeGroup[], interactive: boolean) =>
  renderToStaticMarkup(<GroupsLayer groups={groups} interactive={interactive} />);

test("each group draws a named, hue-tinted halo region (issue #118)", () => {
  const html = render([flowGroup, pipelineGroup], true);
  /* Both flow and pipeline groups render their name. */
  expect(html).toContain("Ship the group overlay");
  expect(html).toContain("Refactor the scheme");
  /* The halo tint is derived from the group's distinct hue. */
  expect(html).toContain("hsl(210 62% 42%)");
  expect(html).toContain("hsl(24 62% 42%)");
  /* A data hook per kind so the board can be asserted against and styled. */
  expect(html).toContain('data-scheme-group="flow"');
  expect(html).toContain('data-scheme-group="pipeline"');
});

test("the label chip stays readable at map zoom via the inverse-zoom var", () => {
  /* The chip counter-scales with --inv-z so it does not shrink into the board. */
  expect(render([flowGroup], true)).toContain("min(var(--inv-z, 1), 2.6)");
});

test("the label chip is a live control when interactive and inert otherwise", () => {
  /* Interactive: the chip opens the override panel (button enabled, pointer on). */
  const live = render([flowGroup], true);
  expect(live).toContain("pointer-events-auto");
  expect(live).not.toContain("disabled=\"\"");
  /* Passive (hand tool / selection session / lite map): chip disabled, no tap. */
  const passive = render([flowGroup], false);
  expect(passive).toContain("disabled=\"\"");
});

test("no groups renders nothing", () => {
  expect(render([], true)).toBe("");
});
