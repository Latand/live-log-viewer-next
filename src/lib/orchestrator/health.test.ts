import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  contextReading,
  lastReportedContextTokens,
  readOrchestratorTranscriptFacts,
  rotationRecommendation,
  type OrchestratorTranscriptFacts,
} from "./health";

let sandbox = "";
beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orch-health-")); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function transcript(lines: unknown[]): string {
  const file = path.join(sandbox, "transcript.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

const facts = (overrides: Partial<OrchestratorTranscriptFacts> = {}): OrchestratorTranscriptFacts => ({
  transcriptBytes: 1_000,
  messageCount: 10,
  toolCount: 5,
  compactionCount: 0,
  reportedContextTokens: null,
  ...overrides,
});

test("provider-reported usage wins and is NOT labelled an estimate", () => {
  const file = transcript([
    { type: "assistant", message: { usage: { input_tokens: 1_000, cache_read_input_tokens: 500 } } },
    { type: "assistant", message: { usage: { input_tokens: 40_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000 } } },
  ]);
  const tokens = lastReportedContextTokens(file, fs.statSync(file).size);
  /* The NEWEST usage record, summed across live + cached context. */
  expect(tokens).toBe(142_000);

  const reading = contextReading({ engine: "claude", facts: facts({ reportedContextTokens: tokens }) });
  expect(reading).toEqual({
    tokens: 142_000,
    limit: 200_000,
    percent: 71,
    estimated: false,
    basis: "provider-reported usage from the transcript's newest turn",
  });
});

test("codex token-usage info rows are read too", () => {
  const file = transcript([
    { payload: { info: { last_token_usage: { input_tokens: 30_000, cached_input_tokens: 20_000 } } } },
  ]);
  expect(lastReportedContextTokens(file, fs.statSync(file).size)).toBe(50_000);
});

test("with no provider usage the reading is a byte-derived guess, CLEARLY labelled an estimate", () => {
  const reading = contextReading({ engine: "claude", facts: facts({ transcriptBytes: 400_000 }) });
  expect(reading.tokens).toBe(100_000);
  expect(reading.percent).toBe(50);
  expect(reading.estimated).toBe(true);
  expect(reading.basis).toContain("ESTIMATE");
});

test("an unknown engine states no limit rather than guessing one", () => {
  const reading = contextReading({ engine: "codex", facts: facts({ transcriptBytes: 400_000 }) });
  expect(reading.limit).toBeNull();
  expect(reading.percent).toBeNull();
});

test("a missing transcript reports absence, never a fabricated number", () => {
  const gathered = readOrchestratorTranscriptFacts(path.join(sandbox, "gone.jsonl"), null);
  expect(gathered).toEqual({
    transcriptBytes: null,
    messageCount: null,
    toolCount: null,
    compactionCount: null,
    reportedContextTokens: null,
  });
  const reading = contextReading({ engine: "claude", facts: gathered });
  expect(reading.tokens).toBeNull();
  expect(reading.estimated).toBe(true);
});

test("rotation is a RECOMMENDATION with reasons — bounded, and structurally incapable of acting", () => {
  const recommendation = rotationRecommendation({
    context: { tokens: 150_000, limit: 200_000, percent: 75, estimated: true, basis: "ESTIMATE: transcript bytes / 4 — no provider-reported usage found" },
    facts: facts({ compactionCount: 3, transcriptBytes: 9 * 1024 * 1024 }),
    activity: "dead",
  });
  expect(recommendation.recommended).toBe(true);
  expect(recommendation.reasons.length).toBeLessThanOrEqual(4);
  /* An estimated number says so inside the reason itself. */
  expect(recommendation.reasons[0]).toContain("(estimate)");
  /* The shape carries no action, no target, no side effect — only words. */
  expect(Object.keys(recommendation).sort()).toEqual(["reasons", "recommended"]);
});

test("a healthy incumbent gets no recommendation", () => {
  const recommendation = rotationRecommendation({
    context: contextReading({ engine: "claude", facts: facts({ transcriptBytes: 100_000 }) }),
    facts: facts({ transcriptBytes: 100_000 }),
    activity: "live",
  });
  expect(recommendation).toEqual({ recommended: false, reasons: [] });
});
