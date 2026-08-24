import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import { relayPrompt } from "./prompts";
import { flowRelayedMessageOccurrences } from "./relayProvenance";
import type { Flow, Round } from "./types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-relay-provenance-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const IMPLEMENTER_PATH = "/sessions/implementer-transcript.jsonl";
const FINDINGS = "P1 — the held command drops its origin across the migration window.\n";
const DELIVERED_AT = "2026-08-24T09:00:00.000Z";

function flowWith(rounds: Array<Partial<Round>>, implementerPath = IMPLEMENTER_PATH): Flow {
  return { implementerPath, rounds } as unknown as Flow;
}

function settledRound(findingsPath: string, deliveredPath = IMPLEMENTER_PATH): Partial<Round> {
  return {
    findingsPath,
    relayDelivery: { path: deliveredPath, deliveredAt: DELIVERED_AT },
  };
}

test("a settled relay round joins its reconstructed text digest and settlement time as reviewer traffic", () => {
  const findingsPath = path.join(sandbox, "round-1-findings.md");
  fs.writeFileSync(findingsPath, FINDINGS);
  const round = settledRound(findingsPath);
  const occurrences = flowRelayedMessageOccurrences(IMPLEMENTER_PATH, { flows: () => [flowWith([round])] });
  expect(occurrences).toEqual([{
    textDigest: messageTextDigest(relayPrompt(round as Round, FINDINGS)),
    deliveredAt: DELIVERED_AT,
    origin: "agent",
    senderRole: "reviewer",
  }]);
});

test("the flow's current implementer path still matches a relay delivered to a predecessor path", () => {
  const findingsPath = path.join(sandbox, "round-2-findings.md");
  fs.writeFileSync(findingsPath, FINDINGS);
  const round = settledRound(findingsPath, "/sessions/predecessor-transcript.jsonl");
  const occurrences = flowRelayedMessageOccurrences(IMPLEMENTER_PATH, { flows: () => [flowWith([round])] });
  expect(occurrences).toHaveLength(1);
});

test("unsettled rounds, unparseable settlement times, pruned artifacts, and other transcripts contribute nothing", () => {
  const findingsPath = path.join(sandbox, "round-3-findings.md");
  fs.writeFileSync(findingsPath, FINDINGS);
  const unsettled: Partial<Round> = { findingsPath, relayDelivery: null };
  const corruptTime: Partial<Round> = { findingsPath, relayDelivery: { path: IMPLEMENTER_PATH, deliveredAt: "when?" } };
  const pruned = settledRound(path.join(sandbox, "missing-findings.md"));
  const occurrences = flowRelayedMessageOccurrences(IMPLEMENTER_PATH, {
    flows: () => [
      flowWith([unsettled, corruptTime, pruned]),
      flowWith([settledRound(findingsPath, "/sessions/another-transcript.jsonl")], "/sessions/another-transcript.jsonl"),
    ],
  });
  expect(occurrences).toEqual([]);
});

test("a failing flow store degrades to absence, never an error", () => {
  expect(flowRelayedMessageOccurrences(IMPLEMENTER_PATH, {
    flows: () => { throw new Error("store unavailable"); },
  })).toEqual([]);
});
