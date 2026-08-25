import { describe, expect, test } from "bun:test";

import { assertHealthyResourceDiagnostic } from "./npm-package-smoke.mjs";

describe("npm package resource-worker diagnostic", () => {
  test("accepts a complete resource collection", () => {
    expect(() => assertHealthyResourceDiagnostic(JSON.stringify({
      status: "complete",
      phases: { readFiles: 1 },
    }))).not.toThrow();
  });

  test.each([
    ["missing", undefined],
    ["failed", JSON.stringify({
      status: "failed",
      degradedReason: "collector-crash",
      failure: { cause: "worker-exit" },
    })],
    ["degraded", JSON.stringify({
      status: "complete",
      degradedReason: "collector-crash",
    })],
  ])("rejects a %s resource-worker diagnostic", (_name, diagnostic) => {
    expect(() => assertHealthyResourceDiagnostic(diagnostic)).toThrow("resource worker diagnostic");
  });
});
