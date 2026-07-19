import { describe, expect, test } from "bun:test";

import type { Flow, Round } from "@/lib/flows/types";

import {
  deckCollapsed,
  deckDisclosureMarker,
  deckDisclosureTerminal,
  readDeckDisclosureOverride,
  reviewDeckCollapseKey,
  writeDeckDisclosureOverride,
} from "./reviewDeckDisclosure";

/* The disclosure model of #289 + #325: lifecycle default + marker-invalidated
   tri-state override, shared by RoundDeck and the worker-stack group row. */

function memStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function round(n: number, verdict: Round["verdict"], error: string | null = null): Round {
  return {
    n,
    reviewerPath: `/reviewer-${n}`,
    reviewerConversationId: `conversation-r${n}`,
    findingsPath: null,
    triggeredBy: "button",
    readyNote: null,
    verdict,
    findingsCount: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    reviewedAt: null,
    relayedAt: null,
    error,
  };
}

const flowWith = (rounds: Round[], state: Flow["state"] = "reviewing") => ({ rounds, state }) as Flow;

describe("deck disclosure model", () => {
  test("markers change on both lifecycle transitions: verdict on the same round, and a fresh round", () => {
    const open = deckDisclosureMarker(flowWith([round(1, null)]));
    const approved = deckDisclosureMarker(flowWith([round(1, "APPROVE")]));
    const aborted = deckDisclosureMarker(flowWith([round(1, null, "no verdict")]));
    const nextRound = deckDisclosureMarker(flowWith([round(1, "APPROVE"), round(2, null)]));
    expect(new Set([open, approved, aborted, nextRound]).size).toBe(4);
    expect(deckDisclosureMarker(flowWith([]))).toBe("empty");
  });

  test("lifecycle defaults: expanded while actionable, collapsed once terminal", () => {
    expect(deckDisclosureTerminal({ state: "reviewing" })).toBe(false);
    expect(deckDisclosureTerminal({ state: "fixing" })).toBe(false);
    expect(deckDisclosureTerminal({ state: "done_comment" })).toBe(true);
    expect(deckDisclosureTerminal({ state: "approved" })).toBe(true);
    expect(deckDisclosureTerminal({ state: "closed" })).toBe(true);
    expect(deckCollapsed(null, "m", false)).toBe(false);
    expect(deckCollapsed(null, "m", true)).toBe(true);
  });

  test("a still-valid override wins; a stale one falls back to the lifecycle default", () => {
    const override = { v: "expanded" as const, at: "m1" };
    expect(deckCollapsed(override, "m1", true)).toBe(false);
    expect(deckCollapsed(override, "m2", true)).toBe(true);
    const collapsedOverride = { v: "collapsed" as const, at: "m1" };
    expect(deckCollapsed(collapsedOverride, "m1", false)).toBe(true);
    expect(deckCollapsed(collapsedOverride, "m2", false)).toBe(false);
  });

  test("storage round-trip, legacy '1' migration, and corrupt-value tolerance", () => {
    const storage = memStorage();
    expect(readDeckDisclosureOverride(storage, "f1")).toBeNull();
    writeDeckDisclosureOverride(storage, "f1", "collapsed", "m1");
    expect(readDeckDisclosureOverride(storage, "f1")).toEqual({ v: "collapsed", at: "m1" });

    /* Legacy boolean pin: collapsed with no marker — matches every state,
       exactly its pre-#289 durability. */
    storage.setItem(reviewDeckCollapseKey("legacy"), "1");
    const legacy = readDeckDisclosureOverride(storage, "legacy");
    expect(legacy).toEqual({ v: "collapsed", at: null });
    expect(deckCollapsed(legacy, "anything", false)).toBe(true);

    storage.setItem(reviewDeckCollapseKey("junk"), "{not json");
    expect(readDeckDisclosureOverride(storage, "junk")).toBeNull();
    storage.setItem(reviewDeckCollapseKey("wrong"), JSON.stringify({ v: "sideways" }));
    expect(readDeckDisclosureOverride(storage, "wrong")).toBeNull();
  });
});
