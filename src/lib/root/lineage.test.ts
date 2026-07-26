import { expect, test } from "bun:test";

import {
  adoptRootSession,
  continuityMarker,
  emptyRootLineage,
  headSession,
  isRootConversation,
  rootConversationIds,
} from "./lineage";
import { MAX_ROOT_SESSIONS, type RootLineageV1 } from "./types";

const at = (iso: string) => new Date(iso);

function seeded(): RootLineageV1 {
  return adoptRootSession(null, { conversationId: "conversation_a", path: "/tmp/a.jsonl" }, {
    now: at("2026-07-01T10:00:00.000Z"),
    rootId: "root_fixed",
  }).lineage;
}

test("the first session mints the lineage and carries no continuity marker", () => {
  const { lineage, outcome } = adoptRootSession(null, { conversationId: "conversation_a" }, {
    now: at("2026-07-01T10:00:00.000Z"),
    rootId: "root_fixed",
  });

  expect(outcome).toBe("created");
  expect(lineage.rootId).toBe("root_fixed");
  expect(lineage.revision).toBe(1);
  expect(headSession(lineage)).toEqual({
    conversationId: "conversation_a",
    path: null,
    startedAt: "2026-07-01T10:00:00.000Z",
  });
  expect(continuityMarker(lineage)).toBeNull();
});

test("re-reporting the same session changes nothing, and a settling path is recorded once", () => {
  const first = seeded();

  const idle = adoptRootSession(first, { conversationId: "conversation_a", path: "/tmp/a.jsonl" }, { now: at("2026-07-01T10:05:00.000Z") });
  expect(idle.outcome).toBe("current");
  expect(idle.lineage).toBe(first);

  const pending = adoptRootSession(null, { conversationId: "conversation_b" }, { now: at("2026-07-01T10:00:00.000Z"), rootId: "root_fixed" }).lineage;
  const settled = adoptRootSession(pending, { conversationId: "conversation_b", path: "/tmp/b.jsonl" }, { now: at("2026-07-01T10:01:00.000Z") });
  expect(settled.outcome).toBe("settled");
  expect(headSession(settled.lineage)?.path).toBe("/tmp/b.jsonl");
  expect(settled.lineage.revision).toBe(2);
});

test("a rollover keeps the root identity, closes the predecessor and links the successor", () => {
  const before = seeded();

  const after = adoptRootSession(before, { conversationId: "conversation_b", path: "/tmp/b.jsonl" }, {
    now: at("2026-07-01T12:00:00.000Z"),
    reason: "rollover",
  });

  expect(after.outcome).toBe("rolled-over");
  /* The whole point of D5: the durable identity every attention request was
     written against is untouched by the session being replaced. */
  expect(after.lineage.rootId).toBe(before.rootId);
  expect(after.lineage.sessions).toHaveLength(2);
  expect(after.lineage.sessions[0]!.endedAt).toBe("2026-07-01T12:00:00.000Z");
  expect(continuityMarker(after.lineage)).toEqual({
    previousConversationId: "conversation_a",
    previousPath: "/tmp/a.jsonl",
    reason: "rollover",
    at: "2026-07-01T12:00:00.000Z",
  });
});

test("a deliberate fresh start records its own reason", () => {
  const after = adoptRootSession(seeded(), { conversationId: "conversation_b" }, {
    now: at("2026-07-01T12:00:00.000Z"),
    reason: "fresh",
  });

  expect(continuityMarker(after.lineage)?.reason).toBe("fresh");
});

test("the whole rollover chain is addressable, newest first, by id or by path", () => {
  const rolled = adoptRootSession(seeded(), { conversationId: "conversation_b", path: "/tmp/b.jsonl" }, { now: at("2026-07-01T12:00:00.000Z") }).lineage;

  expect(rootConversationIds(rolled)).toEqual(["conversation_b", "conversation_a"]);
  /* D6's board filter has to hold for the dead sessions too, not just the live
     one, or every rollover leaves another root card on the board. */
  expect(isRootConversation(rolled, { conversationId: "conversation_a" })).toBe(true);
  expect(isRootConversation(rolled, { path: "/tmp/b.jsonl" })).toBe(true);
  expect(isRootConversation(rolled, { conversationId: "conversation_worker" })).toBe(false);
  expect(isRootConversation(null, { conversationId: "conversation_a" })).toBe(false);
});

test("a null path never matches a session whose path has not settled", () => {
  const pending = adoptRootSession(null, { conversationId: "conversation_a" }, { now: at("2026-07-01T10:00:00.000Z"), rootId: "root_fixed" }).lineage;

  expect(isRootConversation(pending, { path: null })).toBe(false);
  expect(isRootConversation(pending, { conversationId: null, path: null })).toBe(false);
});

test("the chain trims to its cap from the oldest end and keeps the current session", () => {
  let lineage = emptyRootLineage("root_fixed", at("2026-07-01T00:00:00.000Z"));
  for (let index = 0; index < MAX_ROOT_SESSIONS + 5; index += 1) {
    lineage = adoptRootSession(lineage, { conversationId: `conversation_${index}` }, { now: at("2026-07-01T00:00:00.000Z") }).lineage;
  }

  expect(lineage.sessions).toHaveLength(MAX_ROOT_SESSIONS);
  expect(headSession(lineage)?.conversationId).toBe(`conversation_${MAX_ROOT_SESSIONS + 4}`);
  expect(lineage.rootId).toBe("root_fixed");
});
