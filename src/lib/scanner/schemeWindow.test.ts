import { expect, test } from "bun:test";

import { schemeWindowConfig, selectSchemeWindow } from "./schemeWindow";

const CONFIG = { projectCap: 2, cardsPerProject: 2 };

type Row = { id: string; project: string };

/** Rows named `<project>/<ordinal>`, already in the scanner's ranked order. */
const rows = (...specs: string[]): Row[] => specs.map((spec) => ({ id: spec, project: spec.split("/")[0]! }));

test("the window keeps the newest projects and bounds each to its card count", () => {
  const ranked = rows("a/1", "a/2", "a/3", "b/1", "b/2", "c/1");
  expect(selectSchemeWindow(ranked, (row) => row.project, CONFIG).map((row) => row.id))
    .toEqual(["a/1", "a/2", "b/1", "b/2"]);
});

test("a protected entry outranks both caps and pulls its project into view", () => {
  const ranked = rows("a/1", "a/2", "a/3", "b/1", "b/2", "c/1");
  const selected = selectSchemeWindow(ranked, (row) => row.project, CONFIG, {
    protect: (row) => row.id === "a/3" || row.id === "c/1",
  });
  /* The live rows ride along without spending anyone's card budget: project a
     still shows its two ordinary cards, project b keeps its visible slot, and
     the row from the out-of-window project c is still on the board. */
  expect(selected.map((row) => row.id)).toEqual(["a/1", "a/2", "a/3", "b/1", "b/2", "c/1"]);
});

test("protection cannot be starved by the project cap", () => {
  const ranked = rows("a/1", "b/1", "c/1", "d/1");
  const selected = selectSchemeWindow(ranked, (row) => row.project, CONFIG, {
    protect: (row) => row.project === "c" || row.project === "d",
  });
  expect(selected.map((row) => row.id)).toEqual(["a/1", "b/1", "c/1", "d/1"]);
});

test("the window falls back to its defaults for unset or nonsense limits", () => {
  expect(schemeWindowConfig({})).toEqual({ projectCap: 10, cardsPerProject: 80 });
  expect(schemeWindowConfig({ LLV_SCHEME_PROJECT_CAP: "0", LLV_SCHEME_CARDS_PER_PROJECT: "nope" }))
    .toEqual({ projectCap: 10, cardsPerProject: 80 });
  expect(schemeWindowConfig({ LLV_SCHEME_PROJECT_CAP: "3", LLV_SCHEME_CARDS_PER_PROJECT: "7" }))
    .toEqual({ projectCap: 3, cardsPerProject: 7 });
});
