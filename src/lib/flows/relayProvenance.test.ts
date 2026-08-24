import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import { relayClientMessageId } from "./engine";
import { relayPrompt } from "./prompts";
import { flowRelayedMessageOccurrences } from "./relayProvenance";
import type { Flow, Round } from "./types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-relay-provenance-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const IMPLEMENTER_PATH = "/sessions/implementer-transcript.jsonl";
const FINDINGS = "P1 — the held command drops its origin across the migration window.\n";
const DELIVERED_AT = "2026-08-24T09:00:00.000Z";

function flowWith(rounds: Array<Partial<Round>>, implementerPath = IMPLEMENTER_PATH): Flow {
  return { id: "flow-provenance", implementerPath, rounds } as unknown as Flow;
}

function settledRound(findingsPath: string, deliveredPath = IMPLEMENTER_PATH, n = 1): Partial<Round> {
  return {
    n,
    reviewerBindingId: `binding-${n}`,
    findingsPath,
    relayDelivery: { path: deliveredPath, deliveredAt: DELIVERED_AT },
  };
}

test("a settled relay round joins its reconstructed text digest, settlement time, and relay identity as reviewer traffic", () => {
  const findingsPath = path.join(sandbox, "round-1-findings.md");
  fs.writeFileSync(findingsPath, FINDINGS);
  const round = settledRound(findingsPath);
  const flow = flowWith([round]);
  const occurrences = flowRelayedMessageOccurrences(IMPLEMENTER_PATH, { flows: () => [flow] });
  expect(occurrences).toEqual([{
    textDigest: messageTextDigest(relayPrompt(round as Round, FINDINGS)),
    deliveredAt: DELIVERED_AT,
    origin: "agent",
    senderRole: "reviewer",
    clientMessageId: relayClientMessageId(flow, round as Round),
  }]);
});

test("each settled round carries the identity its own structured relay reserved, computed from that round alone", () => {
  const findingsPath = path.join(sandbox, "round-identity-findings.md");
  fs.writeFileSync(findingsPath, FINDINGS);
  const first = settledRound(findingsPath, IMPLEMENTER_PATH, 1);
  /* A definitive relay failure advanced this round's delivery attempt before
     the retry settled: the identity that settled is the retried one. */
  const second: Partial<Round> = { ...settledRound(findingsPath, IMPLEMENTER_PATH, 2), relayDeliveryAttempt: 1 };
  const flow = flowWith([first, second]);
  const ids = flowRelayedMessageOccurrences(IMPLEMENTER_PATH, { flows: () => [flow] })
    .map((occurrence) => occurrence.clientMessageId);
  expect(ids).toEqual([relayClientMessageId(flow, first as Round), relayClientMessageId(flow, second as Round)]);
  expect(new Set(ids).size).toBe(2);
  /* The engine settles the live relay under the current round's identity. */
  expect(ids[1]).toBe(relayClientMessageId(flow));
  for (const id of ids) expect(id).toMatch(/^flow_relay_[a-f0-9]{32}$/);
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
