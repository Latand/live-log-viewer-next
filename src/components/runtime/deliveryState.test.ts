import { readFileSync } from "node:fs";

import { expect, test } from "bun:test";

import {
  DELIVERY_ECHO_MTIME_GRACE_MS,
  DELIVERY_ECHO_TTL_MS,
  DISMISSED_RECEIPTS_LIMIT,
  deliveryAttemptGroups,
  deliveryEchoes,
  deliveryProblem,
  deliveryResolved,
  dismissedReceiptsKey,
  readDismissedReceipts,
  visibleStandaloneReceipts,
  withDismissedReceipts,
  writeDismissedReceipts,
} from "./deliveryState";
import type { ReceiptStatus, RuntimeReceipt } from "./runtimeModel";

const receipt = (overrides: Partial<RuntimeReceipt> & { operationId: string }): RuntimeReceipt => ({
  idempotencyKey: `key-${overrides.operationId}`,
  conversationId: "conv-one",
  kind: "send",
  status: "queued",
  text: "message",
  at: "2026-07-18T10:00:00.000Z",
  revision: 1,
  ...overrides,
});

test("every receipt status maps to exactly one surfacing class", () => {
  const classes: Record<ReceiptStatus, "active" | "resolved" | "problem"> = {
    pending: "active",
    delivering: "active",
    queued: "active",
    uncertain: "active",
    "turn-started": "resolved",
    steered: "resolved",
    delivered: "resolved",
    answered: "resolved",
    interrupted: "resolved",
    rejected: "problem",
    failed: "problem",
  };
  for (const [status, cls] of Object.entries(classes) as [ReceiptStatus, string][]) {
    expect(deliveryResolved(status)).toBe(cls === "resolved");
    expect(deliveryProblem(status)).toBe(cls === "problem");
  }
});

test("resolved successes render no attempt groups — the feed bubble is the receipt", () => {
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-delivered", status: "delivered", text: "one" }),
    receipt({ operationId: "op-answered", status: "answered", text: "two" }),
    receipt({ operationId: "op-steered", kind: "steer", status: "steered", text: "three" }),
    receipt({ operationId: "op-started", status: "turn-started", text: "four" }),
    receipt({ operationId: "op-interrupted", status: "interrupted", text: "five" }),
  ]);
  expect(groups).toEqual([]);
});

test("a successful resend of the same text silences its earlier failures", () => {
  const text = "той самий текст";
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-win", status: "delivered", text, at: "2026-07-18T10:00:02.000Z" }),
    receipt({ operationId: "op-lost-one", status: "rejected", reason: "dead-host", text, at: "2026-07-18T10:00:01.000Z" }),
    receipt({ operationId: "op-lost-two", status: "failed", reason: "dead-host", text, at: "2026-07-18T10:00:00.000Z" }),
    receipt({ operationId: "op-other", status: "failed", reason: "dead-host", text: "інший текст" }),
  ]);
  // The delivered newest attempt hides its whole group; the unrelated failure stays.
  expect(groups).toHaveLength(1);
  expect(groups[0]!.current.operationId).toBe("op-other");
});

test("attempts of one message group under the newest, resolved history drops out", () => {
  const text = "retry me";
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-now", status: "queued", text, at: "2026-07-18T10:00:03.000Z" }),
    receipt({ operationId: "op-old-fail", status: "rejected", reason: "stale-turn", text, at: "2026-07-18T10:00:02.000Z" }),
    receipt({ operationId: "op-old-ok", status: "delivered", text, at: "2026-07-18T10:00:01.000Z" }),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.current.operationId).toBe("op-now");
  expect(groups[0]!.attempts.map((attempt) => attempt.operationId)).toEqual(["op-now", "op-old-fail"]);
});

test("dismissal hides settled problems but never a still-moving attempt", () => {
  const failed = receipt({ operationId: "op-failed", status: "failed", reason: "dead-host", text: "a" });
  const active = receipt({ operationId: "op-active", status: "queued", text: "b" });
  const dismissed = new Set(["op-failed", "op-active"]);
  const groups = deliveryAttemptGroups([failed, active], dismissed);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.current.operationId).toBe("op-active");
});

test("standalone receipts follow the same classes — terminal success never renders", () => {
  const visible = visibleStandaloneReceipts([
    receipt({ operationId: "op-int-ok", kind: "interrupt", status: "delivered", text: null }),
    receipt({ operationId: "op-int-done", kind: "interrupt", status: "interrupted", text: null }),
    receipt({ operationId: "op-int-pending", kind: "interrupt", status: "pending", text: null }),
    receipt({ operationId: "op-int-failed", kind: "interrupt", status: "failed", reason: "dead-host", text: null }),
    receipt({ operationId: "op-send-no-echo", status: "answered", text: null }),
    // a message WITH text belongs to the grouped stack, not the standalone row
    receipt({ operationId: "op-send-text", status: "failed", reason: "dead-host", text: "grouped" }),
  ]);
  expect(visible.map((entry) => entry.operationId)).toEqual(["op-int-pending", "op-int-failed"]);

  const afterDismiss = visibleStandaloneReceipts(
    [receipt({ operationId: "op-int-failed", kind: "interrupt", status: "failed", text: null })],
    new Set(["op-int-failed"]),
  );
  expect(afterDismiss).toEqual([]);
});

test("a delivered send echoes only until the transcript grows past the delivery moment", () => {
  const now = Date.parse("2026-07-18T10:00:05.000Z");
  const delivered = receipt({ operationId: "op-echo", status: "delivered", text: "щойно надіслане", at: "2026-07-18T10:00:04.000Z" });
  const staleMtime = Date.parse("2026-07-18T09:59:00.000Z");

  expect(deliveryEchoes([delivered], staleMtime, new Set(), now).map((entry) => entry.operationId)).toEqual(["op-echo"]);

  // The bubble landed: the transcript's mtime moved past the delivery moment.
  const grownMtime = Date.parse(delivered.at) + DELIVERY_ECHO_MTIME_GRACE_MS;
  expect(deliveryEchoes([delivered], grownMtime, new Set(), now)).toEqual([]);

  // Hard cap: a transcript that never grows again cannot pin echoes forever.
  expect(deliveryEchoes([delivered], staleMtime, new Set(), Date.parse(delivered.at) + DELIVERY_ECHO_TTL_MS)).toEqual([]);

  // Dismissal clears the echo too.
  expect(deliveryEchoes([delivered], staleMtime, new Set(["op-echo"]), now)).toEqual([]);
});

test("active, problem, and interrupted receipts never echo", () => {
  const now = Date.parse("2026-07-18T10:00:05.000Z");
  const mtime = 0;
  const statuses: ReceiptStatus[] = ["pending", "delivering", "queued", "uncertain", "rejected", "failed", "interrupted"];
  const receipts = statuses.map((status, index) =>
    receipt({ operationId: `op-${status}`, status, text: `${status} text`, at: `2026-07-18T10:00:0${index % 5}.000Z` }));
  expect(deliveryEchoes(receipts, mtime, new Set(), now)).toEqual([]);
});

test("one echo per idempotency key — the newest receipt speaks for the message", () => {
  const now = Date.parse("2026-07-18T10:00:05.000Z");
  const echoes = deliveryEchoes([
    receipt({ operationId: "op-b", idempotencyKey: "key-shared", status: "answered", text: "same", at: "2026-07-18T10:00:04.000Z" }),
    receipt({ operationId: "op-a", idempotencyKey: "key-shared", status: "delivered", text: "same", at: "2026-07-18T10:00:03.000Z" }),
  ], 0, new Set(), now);
  expect(echoes.map((entry) => entry.operationId)).toEqual(["op-b"]);
});

test("dismissed ids append bounded and survive a storage round-trip", () => {
  const many = Array.from({ length: DISMISSED_RECEIPTS_LIMIT + 10 }, (_, index) => `op-${index}`);
  const bounded = withDismissedReceipts([], many);
  expect(bounded).toHaveLength(DISMISSED_RECEIPTS_LIMIT);
  expect(bounded.at(-1)).toBe(`op-${DISMISSED_RECEIPTS_LIMIT + 9}`);
  // Re-dismissing moves the id to the tail instead of duplicating it.
  expect(withDismissedReceipts(["op-1", "op-2"], ["op-1"])).toEqual(["op-2", "op-1"]);

  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  try {
    writeDismissedReceipts("conv-one", ["op-1", "op-2"]);
    expect(readDismissedReceipts("conv-one")).toEqual(["op-1", "op-2"]);
    expect(store.has(dismissedReceiptsKey("conv-one"))).toBe(true);
    writeDismissedReceipts("conv-one", []);
    expect(readDismissedReceipts("conv-one")).toEqual([]);
    store.set(dismissedReceiptsKey("conv-two"), JSON.stringify(["ok", 7, null]));
    expect(readDismissedReceipts("conv-two")).toEqual(["ok"]);
  } finally {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test("the grouping-key NUL separator is escaped in source yet keeps kinds apart at runtime", () => {
  // The separator must live in source as the `\u0000` escape, never a raw
  // byte, so the file stays visible to text tooling (grep, diff, review UIs).
  const source = readFileSync(new URL("./deliveryState.ts", import.meta.url), "utf8");
  expect(source.includes("\\u0000")).toBe(true);
  expect(source.includes("\u0000")).toBe(false);

  // Same text under different kinds must stay two groups — the escape still
  // produces the exact NUL-joined runtime key.
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-send", kind: "send", status: "failed", reason: "dead-host", text: "same", at: "2026-07-18T10:00:01.000Z" }),
    receipt({ operationId: "op-steer", kind: "steer", status: "failed", reason: "dead-host", text: "same", at: "2026-07-18T10:00:00.000Z" }),
  ]);
  expect(groups.map((group) => group.current.operationId)).toEqual(["op-send", "op-steer"]);
});
