import { expect, test } from "bun:test";

import { OVERVIEW } from "./projectModel";
import { initialProjectFromState } from "./Viewer";

test("initialProjectFromState reads a direct project hash before polling", () => {
  expect(initialProjectFromState("#p=stikon-dispatcher", null)).toBe("stikon-dispatcher");
  expect(initialProjectFromState("#p=space%20project", null)).toBe("space project");
});

test("initialProjectFromState falls back to saved project only without a project hash", () => {
  expect(initialProjectFromState("", "CelestiaCompose")).toBe("CelestiaCompose");
  expect(initialProjectFromState("#f=/tmp/session.jsonl", "CelestiaCompose")).toBe("CelestiaCompose");
  expect(initialProjectFromState("", null)).toBe(OVERVIEW);
});
