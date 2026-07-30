import { expect, test } from "bun:test";

import { canonicalClientProject, remapProjectSet } from "./clientAliases";

test("browser project state follows server-published repository aliases", () => {
  const target = "repo-0123456789abcdef0123456789abcdef";
  const aliases = {
    "legacy-project": "intermediate-project",
    "intermediate-project": target,
  };

  expect(canonicalClientProject("legacy-project", aliases)).toBe(target);
  expect(remapProjectSet(new Set(["legacy-project", target]), aliases)).toEqual(new Set([target]));
});

test("a malformed alias cycle preserves the original browser key", () => {
  expect(canonicalClientProject("legacy-a", {
    "legacy-a": "legacy-b",
    "legacy-b": "legacy-a",
  })).toBe("legacy-a");
});
