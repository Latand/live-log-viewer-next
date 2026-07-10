import { expect, test } from "bun:test";

import { parseStageVerdict, stageVerdictFrom } from "./verdict";

test("stage verdict guard accepts the bounded contract", () => {
  expect(stageVerdictFrom({ status: "pass", findings: ["verified"], confidence: 0.9 })).toEqual({
    status: "pass",
    findings: ["verified"],
    confidence: 0.9,
  });
  expect(stageVerdictFrom({ status: "needs_decision" })).toEqual({ status: "needs_decision" });
});
test("stage verdict guard rejects malformed and expanded shapes", () => {
  expect(stageVerdictFrom({ status: "approve" })).toBeNull();
  expect(stageVerdictFrom({ status: "pass", confidence: 2 })).toBeNull();
  expect(stageVerdictFrom({ status: "pass", extra: true })).toBeNull();
  expect(stageVerdictFrom({ status: "fail", findings: Array.from({ length: 51 }, () => "x") })).toBeNull();
});

test("the final fenced JSON block is completion authority and preserves prose output", () => {
  expect(parseStageVerdict("Implemented the seam.\n\n```json\n{\"status\":\"pass\",\"confidence\":1}\n```" )).toEqual({
    verdict: { status: "pass", confidence: 1 },
    output: "Implemented the seam.",
  });
  expect(parseStageVerdict("```json\n{\"status\":\"pass\"}\n```\ntrailing prose")).toBeNull();
  expect(parseStageVerdict("VERDICT: pass")).toBeNull();
});
