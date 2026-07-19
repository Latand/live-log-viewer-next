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

test("a pass verdict with findings returns an explicit contradiction", () => {
  expect(parseStageVerdict([
    "VERDICT: REQUEST_CHANGES",
    "",
    "- [P1] Preserve the failed review",
    "",
    "```json",
    '{"status":"pass","findings":["Preserve the failed review"]}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: status "pass" cannot include findings',
    output: "VERDICT: REQUEST_CHANGES\n\n- [P1] Preserve the failed review",
  });
});

test("a prose request-changes marker cannot disagree with the JSON verdict", () => {
  expect(parseStageVerdict([
    "VERDICT: REQUEST_CHANGES",
    "",
    "Review found a blocking regression.",
    "",
    "```json",
    '{"status":"pass","confidence":0.9}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "REQUEST_CHANGES" disagrees with JSON status "pass"',
    output: "VERDICT: REQUEST_CHANGES\n\nReview found a blocking regression.",
  });
});

test("a prose approve marker cannot disagree with the JSON verdict", () => {
  expect(parseStageVerdict([
    "VERDICT: APPROVE",
    "",
    "```json",
    '{"status":"fail","findings":["verification failed"]}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "APPROVE" disagrees with JSON status "fail"',
    output: "VERDICT: APPROVE",
  });
});

test("a no-findings marker cannot disagree with the JSON verdict", () => {
  expect(parseStageVerdict([
    "NO FINDINGS",
    "",
    "```json",
    '{"status":"fail","findings":["verification failed"]}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "NO FINDINGS" disagrees with JSON status "fail"',
    output: "NO FINDINGS",
  });
});

test("a clean no-findings pass remains valid", () => {
  expect(parseStageVerdict([
    "NO FINDINGS",
    "",
    "```json",
    '{"status":"pass","findings":[],"confidence":1}',
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", findings: [], confidence: 1 },
    output: "NO FINDINGS",
  });
});

test("fenced and quoted marker examples do not contradict a clean pass", () => {
  const prose = [
    "The reviewed prompt includes this failure example:",
    "",
    "```text",
    "VERDICT: REQUEST_CHANGES",
    "```",
    "",
    "~~~text",
    "~~~json",
    "VERDICT: REQUEST_CHANGES",
    "~~~",
    "",
    "> VERDICT: REQUEST_CHANGES",
    "",
    "NO FINDINGS",
  ].join("\n");
  expect(parseStageVerdict([
    prose,
    "",
    "```json",
    '{"status":"pass","findings":[],"confidence":1}',
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "pass", findings: [], confidence: 1 },
    output: prose,
  });
});

test("a matching fail verdict preserves every finding", () => {
  expect(parseStageVerdict([
    "VERDICT: REQUEST_CHANGES",
    "",
    "```json",
    '{"status":"fail","findings":["first regression","second regression"]}',
    "```",
  ].join("\n"))).toEqual({
    verdict: { status: "fail", findings: ["first regression", "second regression"] },
    output: "VERDICT: REQUEST_CHANGES",
  });
});

test("prose marker validation covers content beyond the stored output cap", () => {
  const boundedOutput = "x".repeat(32_000);
  expect(parseStageVerdict([
    boundedOutput,
    "VERDICT: REQUEST_CHANGES",
    "",
    "```json",
    '{"status":"pass"}',
    "```",
  ].join("\n"))).toEqual({
    failureReason: 'contradictory stage verdict: prose marker "REQUEST_CHANGES" disagrees with JSON status "pass"',
    output: boundedOutput,
  });
});
