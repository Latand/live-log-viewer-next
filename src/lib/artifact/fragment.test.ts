import { describe, expect, test } from "bun:test";

import { formatArtifactFragment, parseArtifactFragment } from "./fragment";

describe("parseArtifactFragment", () => {
  test("round-trips absolute and ~-relative paths, spaces and line suffixes included", () => {
    for (const path of [
      "/checkouts/report/figures/diagram.png",
      "~/checkouts/report/figures/diagram.png",
      "/checkouts/a b/render output.pdf",
      "~/checkouts/report/src/main.ts:12",
    ]) {
      expect(parseArtifactFragment(formatArtifactFragment(path))).toBe(path);
    }
  });

  test("the format is one opaque token: the path is fully percent-encoded", () => {
    expect(formatArtifactFragment("/figures/diagram.png")).toBe("#a=%2Ffigures%2Fdiagram.png");
  });

  test("every other fragment key stays someone else's: #f=, #c=, #p= and junk are null", () => {
    for (const foreign of [
      "#f=%2Fcheckouts%2Fsession.jsonl",
      "#c=conversation-1",
      "#p=project",
      "",
      "#a=",
      "#garbage",
      "#af=%2Fx.png",
    ]) {
      expect(parseArtifactFragment(foreign)).toBeNull();
    }
  });

  test("malformed percent-encoding degrades to the raw payload instead of throwing", () => {
    expect(parseArtifactFragment("#a=%E0%A4%A")).toBe("%E0%A4%A");
  });
});
