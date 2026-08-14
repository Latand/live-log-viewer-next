import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { contextWindowPolicyFor, ROTATION_THRESHOLD_FRACTION } from "./contextPolicy";
import {
  contextReading,
  lastReportedContextTokens,
  readOrchestratorTranscriptFacts,
  rotationRecommendation,
  STRONGLY_RECOMMEND_ROTATION,
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

const OPUS = contextWindowPolicyFor("claude", "claude-opus-4-8");

test("Fable at 129k tokens uses 13% of its registry window and needs no rotation", () => {
  const policy = contextWindowPolicyFor("claude", "fable-5");
  const currentFacts = facts({ reportedContextTokens: 129_000 });
  const context = contextReading({ policy, facts: currentFacts });
  const recommendation = rotationRecommendation({ context, facts: currentFacts, activity: "live", policy });

  expect(policy).toEqual({
    windowTokens: 1_000_000,
    rotationThresholdTokens: 500_000,
    policy: "registry:fable-5:1m",
  });
  expect(context.percent).toBe(13);
  expect(recommendation).toMatchObject({ recommended: false, level: "none", advisory: null });
});

/* ── The named policy: explicit, configurable, one place ─────────────────── */

test("the reference case is explicit policy: Opus-class window 1,000,000 tokens, threshold 500,000", () => {
  expect(OPUS).toEqual({ windowTokens: 1_000_000, rotationThresholdTokens: 500_000, policy: "registry:opus-4-8:1m" });
  /* The threshold is the fraction applied to the window, so a new model entry
     needs only its window and inherits a meaningful threshold. */
  expect(OPUS!.rotationThresholdTokens).toBe(OPUS!.windowTokens * ROTATION_THRESHOLD_FRACTION);
});

test("Sonnet 5 keeps its 1M registry window", () => {
  expect(contextWindowPolicyFor("claude", "sonnet-5")).toEqual({
    windowTokens: 1_000_000,
    rotationThresholdTokens: 500_000,
    policy: "registry:sonnet-5:1m",
  });
});

test("Haiku 4.5 keeps its 200k registry window", () => {
  expect(contextWindowPolicyFor("claude", "haiku-4-5")).toEqual({
    windowTokens: 200_000,
    rotationThresholdTokens: 100_000,
    policy: "registry:haiku-4-5:200k",
  });
});

test("an unconfigured model gets NO invented window", () => {
  expect(contextWindowPolicyFor("claude", "claude-newthing-9")).toBeNull();
  expect(contextWindowPolicyFor("codex", "gpt-5.6-sol")).toBeNull();
  expect(contextWindowPolicyFor(null, null)).toBeNull();
});

/* ── Usage reading: provider-reported beats derived, estimates labelled ──── */

test("provider-reported usage wins and is NOT labelled an estimate, even with a huge transcript on disk", () => {
  const file = transcript([
    { type: "assistant", message: { usage: { input_tokens: 1_000, cache_read_input_tokens: 500 } } },
    { type: "assistant", message: { usage: { input_tokens: 40_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000 } } },
  ]);
  const tokens = lastReportedContextTokens(file, fs.statSync(file).size);
  /* The NEWEST usage record, summed across live + cached context. */
  expect(tokens).toBe(142_000);

  const reading = contextReading({ policy: OPUS, facts: facts({ reportedContextTokens: tokens, transcriptBytes: 50_000_000 }) });
  expect(reading).toEqual({
    tokens: 142_000,
    limit: 1_000_000,
    percent: 14,
    estimated: false,
    basis: "provider-reported usage from the transcript's newest turn",
    policy: "registry:opus-4-8:1m",
  });
});

test("codex token-usage info rows are read too", () => {
  const file = transcript([
    { payload: { info: { last_token_usage: { input_tokens: 30_000, cached_input_tokens: 20_000 } } } },
  ]);
  expect(lastReportedContextTokens(file, fs.statSync(file).size)).toBe(50_000);
});

test("with no provider usage the reading is a byte-derived guess, CLEARLY labelled an estimate", () => {
  const reading = contextReading({ policy: OPUS, facts: facts({ transcriptBytes: 400_000 }) });
  expect(reading.tokens).toBe(100_000);
  expect(reading.percent).toBe(10);
  expect(reading.estimated).toBe(true);
  expect(reading.basis).toContain("ESTIMATE");
});

test("an unknown window states no limit rather than guessing one, and still reports the usage it can prove", () => {
  const reading = contextReading({ policy: null, facts: facts({ reportedContextTokens: 300_000 }) });
  expect(reading.tokens).toBe(300_000);
  expect(reading.limit).toBeNull();
  expect(reading.percent).toBeNull();
  expect(reading.policy).toBeNull();
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
  const reading = contextReading({ policy: OPUS, facts: gathered });
  expect(reading.tokens).toBeNull();
  expect(reading.estimated).toBe(true);
});

/* ── The threshold changes WORDS and nothing else ────────────────────────── */

const recommendationFor = (tokens: number, policyModel = "opus-4-8") => {
  const policy = contextWindowPolicyFor("claude", policyModel);
  const context = contextReading({ policy, facts: facts({ reportedContextTokens: tokens }) });
  return rotationRecommendation({ context, facts: facts({ reportedContextTokens: tokens }), activity: "live", policy });
};

test("usage below the threshold produces NO rotation recommendation", () => {
  const recommendation = recommendationFor(499_999);
  expect(recommendation.recommended).toBe(false);
  expect(recommendation.level).toBe("none");
  expect(recommendation.advisory).toBeNull();
  expect(recommendation.reasons).toEqual([]);
});

test("usage at EXACTLY the threshold, and above it, is a prominent STRONGLY_RECOMMEND_ROTATION", () => {
  for (const tokens of [500_000, 700_000]) {
    const recommendation = recommendationFor(tokens);
    expect(recommendation.recommended).toBe(true);
    expect(recommendation.level).toBe("strongly_recommend");
    expect(recommendation.advisory).toBe(STRONGLY_RECOMMEND_ROTATION);
    expect(recommendation.reasons[0]).toContain("500,000");
    expect(recommendation.reasons[0]).toContain("registry:opus-4-8:1m: 50% of a 1,000,000-token window");
    expect(recommendation.threshold).toEqual({
      windowTokens: 1_000_000,
      thresholdTokens: 500_000,
      fraction: ROTATION_THRESHOLD_FRACTION,
      policy: "registry:opus-4-8:1m",
    });
  }
});

test("the SAME usage that is safe on Opus strongly recommends on a 200k-window model — per-model thresholds", () => {
  expect(recommendationFor(150_000, "opus-4-8").level).toBe("none");
  const smaller = recommendationFor(150_000, "haiku-4-5");
  expect(smaller.level).toBe("strongly_recommend");
  expect(smaller.threshold).toMatchObject({ windowTokens: 200_000, thresholdTokens: 100_000 });
});

test("an unknown window withholds the threshold recommendation and says the threshold is unknown", () => {
  const policy = contextWindowPolicyFor("claude", "claude-newthing-9");
  const context = contextReading({ policy, facts: facts({ reportedContextTokens: 900_000 }) });
  const recommendation = rotationRecommendation({ context, facts: facts({ reportedContextTokens: 900_000 }), activity: "live", policy });
  expect(policy).toBeNull();
  expect(recommendation.level).toBe("none");
  expect(recommendation.advisory).toBeNull();
  expect(recommendation.threshold).toBeNull();
  expect(recommendation.thresholdUnknown).toBe(true);
});

test("an ESTIMATED usage over the threshold still recommends, and the reason says it is an estimate", () => {
  const policy = contextWindowPolicyFor("claude", "opus-4-8");
  /* 2.4 MB of transcript ≈ 600k estimated tokens — over the 500k threshold. */
  const estimated = facts({ transcriptBytes: 2_400_000 });
  const context = contextReading({ policy, facts: estimated });
  const recommendation = rotationRecommendation({ context, facts: estimated, activity: "live", policy });
  expect(recommendation.level).toBe("strongly_recommend");
  expect(recommendation.reasons[0]).toContain("(estimate)");
});

test("the recommendation is structurally incapable of acting: plain data, bounded reasons", () => {
  const recommendation = recommendationFor(900_000);
  expect(recommendation.reasons.length).toBeLessThanOrEqual(4);
  /* Only words and numbers — no callbacks, no targets, no side effects. */
  expect(Object.keys(recommendation).sort()).toEqual(["advisory", "level", "reasons", "recommended", "threshold", "thresholdUnknown"]);
  expect(JSON.parse(JSON.stringify(recommendation))).toEqual(recommendation);
});

test("secondary wear signals still produce an ordinary (non-strong) recommendation", () => {
  const policy = contextWindowPolicyFor("claude", "opus-4-8");
  const worn = facts({ compactionCount: 3, reportedContextTokens: 10_000 });
  const context = contextReading({ policy, facts: worn });
  const recommendation = rotationRecommendation({ context, facts: worn, activity: "live", policy });
  expect(recommendation.recommended).toBe(true);
  expect(recommendation.level).toBe("recommend");
  expect(recommendation.advisory).toBeNull();
});

test("a healthy incumbent gets no recommendation at all", () => {
  const policy = contextWindowPolicyFor("claude", "opus-4-8");
  const healthy = facts({ transcriptBytes: 100_000 });
  const context = contextReading({ policy, facts: healthy });
  expect(rotationRecommendation({ context, facts: healthy, activity: "live", policy }))
    .toMatchObject({ recommended: false, level: "none", advisory: null, reasons: [] });
});
