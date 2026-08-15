import { describe, expect, test } from "bun:test";

import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";

import {
  historicalOccurrencesFromRecords,
  scanHistoricalDayFromInventory,
} from "./historical";
import { emptyWorktimeState, upsertOperatorOccurrence } from "./ledger";

const AT = "2026-08-14T09:00:00.000Z";

describe("privacy-minimized historical operator import", () => {
  test("accepts stable API-human provenance at any depth and marks copied fan-out as zero contribution", () => {
    const direct = encodeCodexStructuredUserText("Inspect the fixture", undefined, undefined, {
      id: "api-human-request-7",
      origin: "api-human",
      relation: "direct",
    });
    const copy = encodeCodexStructuredUserText("Inspect the fixture", undefined, undefined, {
      id: "api-human-request-7",
      origin: "api-human",
      relation: "copy",
    });
    const occurrences = historicalOccurrencesFromRecords({
      engine: "codex",
      lineageId: "lineage-root",
      projectCandidates: [{ project: "fixture-project", rank: 3, evidence: "cwd" }],
      records: [
        { timestamp: AT, id: "direct-record", payload: { type: "user_message", message: direct } },
        { timestamp: "2026-08-14T09:00:01.000Z", id: "worker-record", payload: { type: "user_message", message: copy } },
      ],
    });
    const state = emptyWorktimeState(Date.parse(AT));
    for (const occurrence of occurrences) upsertOperatorOccurrence(state, occurrence);

    expect(occurrences).toHaveLength(2);
    expect(Object.values(state.events)).toEqual([
      expect.objectContaining({ provenOperator: true, occurrenceCount: 2, deduplicatedCount: 1 }),
    ]);
  });

  test("uses content plus lineage fallback for typed history and excludes SDK, system, and tool traffic", () => {
    const records = [
      { type: "user", timestamp: AT, promptSource: "typed", message: { role: "user", content: "  Review\n the fixture " } },
      { type: "user", timestamp: "2026-08-14T09:00:20.000Z", origin: { kind: "human" }, message: { role: "user", content: "review THE fixture" } },
      { type: "user", timestamp: "2026-08-14T09:01:00.000Z", promptSource: "sdk", message: { role: "user", content: "agent launch" } },
      { type: "user", timestamp: "2026-08-14T09:02:00.000Z", promptSource: "system", message: { role: "user", content: "scheduler" } },
      { type: "user", timestamp: "2026-08-14T09:03:00.000Z", message: { role: "user", content: [{ type: "tool_result", content: "done" }] } },
    ];
    const occurrences = historicalOccurrencesFromRecords({
      engine: "claude",
      lineageId: "lineage-root",
      projectCandidates: [{ project: "fixture-project", rank: 2, evidence: "durable-project" }],
      records,
    });
    const state = emptyWorktimeState(Date.parse(AT));
    for (const occurrence of occurrences) upsertOperatorOccurrence(state, occurrence);

    expect(occurrences).toHaveLength(2);
    expect(Object.values(state.events)).toHaveLength(1);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("Review");
    expect(serialized).not.toContain("lineage-root");
    expect(serialized).not.toContain("agent launch");
  });

  test("legacy Codex provider ids do not promote copied traffic while arbitrary API-human ids remain valid", () => {
    const marker = encodeCodexStructuredUserText("fixture input");
    const occurrences = historicalOccurrencesFromRecords({
      engine: "codex",
      lineageId: "lineage-root",
      projectCandidates: [],
      records: [
        { timestamp: AT, id: "provider-copy-id", payload: { type: "user_message", message: marker } },
        { timestamp: "2026-08-14T09:01:00.000Z", client_id: "api-human-123", payload: { type: "user_message", message: marker } },
      ],
    });

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ origin: "api-human", relation: "direct" });
  });

  test("a stable native prompt id deduplicates across account-root mirrors", () => {
    const state = emptyWorktimeState(Date.parse(AT));
    for (const lineageId of ["account-root-a", "account-root-b"]) {
      const occurrences = historicalOccurrencesFromRecords({
        engine: "claude",
        lineageId,
        occurrenceNamespace: lineageId,
        projectCandidates: [{ project: "fixture-project", rank: 3, evidence: "cwd" }],
        records: [{
          type: "user",
          uuid: "native-prompt-identity",
          timestamp: AT,
          promptSource: "typed",
          message: { role: "user", content: "privacy-safe fixture" },
        }],
      });
      for (const occurrence of occurrences) upsertOperatorOccurrence(state, occurrence);
    }

    expect(Object.values(state.events)).toEqual([
      expect.objectContaining({ occurrenceCount: 2, deduplicatedCount: 1, provenOperator: true }),
    ]);
  });

  test("globally complete inventory with incomplete derivation reads no transcripts", () => {
    let reads = 0;
    const result = scanHistoricalDayFromInventory("2026-08-14", {
      complete: true,
      files: [{
        path: "/fixture/session.jsonl",
        root: "codex-sessions",
        engine: "codex",
        project: "fixture-project",
        projectUnresolved: undefined,
        projectOwnership: undefined,
        cwd: "/fixture",
        derivationComplete: false,
      }],
    }, { conversations: {}, conversationAliases: {}, lineageEdges: {} }, () => {
      reads += 1;
      return { complete: true, records: [] };
    });

    expect(result).toEqual({ complete: false, reason: "derivation-incomplete", occurrences: [] });
    expect(reads).toBe(0);
  });

  test("an incomplete transcript read discards all partial evidence", () => {
    const base = {
      root: "claude-projects" as const,
      engine: "claude" as const,
      project: "fixture-project",
      projectUnresolved: undefined,
      projectOwnership: undefined,
      cwd: "/fixture",
      derivationComplete: true,
    };
    const result = scanHistoricalDayFromInventory("2026-08-14", {
      complete: true,
      files: [
        { ...base, path: "/fixture/complete.jsonl" },
        { ...base, path: "/fixture/incomplete.jsonl" },
      ],
    }, { conversations: {}, conversationAliases: {}, lineageEdges: {} }, (entry) => (
      entry.path.endsWith("incomplete.jsonl")
        ? { complete: false, records: [] }
        : { complete: true, records: [{ type: "user", timestamp: AT, promptSource: "typed", message: { content: "private fixture" } }] }
    ));

    expect(result).toEqual({ complete: false, reason: "transcript-tail-incomplete", occurrences: [] });
  });
});
