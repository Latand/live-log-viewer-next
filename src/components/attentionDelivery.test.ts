/**
 * Issue #1213 — a delivery nobody can hand over is a block on the operator.
 *
 * The operator was waiting on a message that never arrived, and no surface said
 * so: the composer spun, and the queue that exists to tell them where they are
 * blocked had no entry for it. These tests pin the entry, its threshold, and
 * the fact that it never displaces a signal that was already there.
 */
import { expect, test } from "bun:test";

import type { FileEntry, StuckDelivery } from "@/lib/types";

import { translate } from "@/lib/i18n";

import { attentionExpiries, attentionId, buildAttentionQueue } from "./attention";
import { decisionLine } from "./attention/decision";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const NOW = 1_800_000_000;
const WAITING_SINCE = new Date((NOW - 9 * 60) * 1000).toISOString();

function stuck(overrides: Partial<StuckDelivery> = {}): StuckDelivery {
  return { since: WAITING_SINCE, attempts: 2, state: "delivery-uncertain", ...overrides };
}

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 60,
    size: 10,
    activity: "live",
    proc: "running",
    pid: 1,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

test("#1213 a delivery waiting past the threshold puts its conversation in the queue", () => {
  const file = entry({ path: "/stuck.jsonl", stuckDelivery: stuck() });
  expect(attentionId(file, NOW)).toBe("/stuck.jsonl:delivery:1799999460");
  const [item] = buildAttentionQueue([file], NOW);
  /* The operator cannot proceed until this message arrives or is given up on —
     the same class of block as an unanswered prompt. */
  expect(item?.tier).toBe("blocked");
  expect(item?.since).toBe(NOW - 9 * 60);
});

test("#1213 a delivery inside the threshold is ordinary latency and enqueues nothing", () => {
  const file = entry({
    path: "/fresh.jsonl",
    stuckDelivery: stuck({ since: new Date((NOW - 60) * 1000).toISOString() }),
  });
  expect(attentionId(file, NOW)).toBeNull();
  expect(buildAttentionQueue([file], NOW)).toEqual([]);
});

test("#1213 a settled or unreadable delivery annotation never enqueues", () => {
  for (const annotation of [
    stuck({ state: "delivered" }),
    stuck({ state: "failed" }),
    stuck({ since: "not a date" }),
  ]) {
    expect(attentionId(entry({ path: "/settled.jsonl", stuckDelivery: annotation }), NOW)).toBeNull();
  }
});

test("#1213 a stuck delivery never displaces a signal that was already there", () => {
  /* The queue's identities are the dedupe keys of the toast and push pipelines.
     A conversation that was already blocked keeps the id it had. */
  const rateLimited = entry({
    path: "/blocked.jsonl",
    stuckDelivery: stuck(),
    rateLimit: { source: "account", accountId: "account-a", window: "session", resetAt: NOW + 3600 },
  });
  expect(attentionId(rateLimited, NOW)).toBe(`/blocked.jsonl:rate-limited:${NOW + 3600}`);
});

test("#1213 the queue re-derives itself when a waiting delivery crosses the threshold", () => {
  /* Nothing in the log moves while a delivery merely gets older, so the queue's
     own clock has to know when it will change. */
  const file = entry({
    path: "/crossing.jsonl",
    stuckDelivery: stuck({ since: new Date((NOW - 60) * 1000).toISOString() }),
  });
  expect(attentionExpiries([file])).toContain(NOW - 60 + 5 * 60);
});

test("#1213 the line every surface prints names the delivery, not a wait the agent is in", () => {
  /* One signal, one description (#1167). The agent here is fine — live and
     mid-turn — and announcing «interrupted or awaiting permission» over it
     sends the operator to look at the wrong thing entirely. */
  const file = entry({ path: "/words.jsonl", stuckDelivery: stuck() });
  expect(decisionLine(t, "en", file, NOW)).toBe(t("attention.decisionDelivery"));
  expect(decisionLine(t, "en", file, NOW)).not.toBe(t("status.stalled"));
});

test("#1213 a stalled agent that also owes a delivery keeps its stalled words and tier", () => {
  /* `attentionId` ranks stalled above delivery, so the row IS the stalled one
     and every surface must say so — including its tier and its sort key. */
  const file = entry({
    path: "/stalled.jsonl",
    activity: "stalled",
    proc: "running",
    stuckDelivery: stuck(),
  });
  expect(attentionId(file, NOW)).toBe(`/stalled.jsonl:stalled:${NOW - 60}`);
  expect(decisionLine(t, "en", file, NOW)).toBe(t("status.stalled"));
  const [item] = buildAttentionQueue([file], NOW);
  expect(item?.tier).toBe("stalled");
  expect(item?.since).toBe(NOW - 60);
});

test("#1213 an abandoned session that owes a delivery is a delivery row, in the blocked tier", () => {
  /* The stalled signal needs a live process; without one the row exists ONLY
     because a message is owed, and its tier, its age and its words all have to
     come from that. */
  const file = entry({
    path: "/abandoned.jsonl",
    activity: "stalled",
    proc: "done",
    stuckDelivery: stuck(),
  });
  expect(attentionId(file, NOW)).toBe("/abandoned.jsonl:delivery:1799999460");
  expect(decisionLine(t, "en", file, NOW)).toBe(t("attention.decisionDelivery"));
  const [item] = buildAttentionQueue([file], NOW);
  expect(item?.tier).toBe("blocked");
  expect(item?.since).toBe(NOW - 9 * 60);
});

test("#1213 a conversation with nothing owed still says nothing at all", () => {
  expect(decisionLine(t, "en", entry({ path: "/quiet.jsonl" }), NOW)).toBeNull();
});
