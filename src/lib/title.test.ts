import { expect, test } from "bun:test";

import { derivedSpawnTitle, isGenericSessionTitle, semanticTitle } from "./title";

test("spawn titles derive from the role and a sixty-character first prompt line", () => {
  const firstLine = "Implement the durable conversation identity migration with exact evidence";

  expect(derivedSpawnTitle("builder", `${firstLine}\nIgnore this second line`)).toBe(
    `builder · ${firstLine.slice(0, 59).trimEnd()}…`,
  );
});

test("legacy engine placeholders have no semantic title value", () => {
  for (const placeholder of ["Codex session", "Claude session", "Codex", "Claude"]) {
    expect(isGenericSessionTitle(placeholder)).toBeTrue();
    expect(semanticTitle(placeholder)).toBeNull();
  }
  expect(semanticTitle("Implement registry identity")).toBe("Implement registry identity");
});
