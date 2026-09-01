/**
 * Issue #1362 — the composer's failed-delivery notice model.
 *
 * Pure: which settled failures fold into the one compact notice, what the
 * notice says at rest, and what expanding it reveals.
 */
import { expect, test } from "bun:test";

import { translate } from "@/lib/i18n";

import { deliveryAttemptGroups } from "./deliveryState";
import { deliveryNoticeRun, describeReceiptFailure, failureCauseKey } from "./deliveryNotice";
import type { RuntimeReceipt } from "./runtimeModel";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const HOST_DOWN = "structured spawn runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";

function receipt(overrides: Partial<RuntimeReceipt> & { operationId: string }): RuntimeReceipt {
  return {
    idempotencyKey: `key-${overrides.operationId}`,
    conversationId: "conversation_1362",
    kind: "send",
    status: "failed",
    reason: HOST_DOWN,
    text: "fix the failing test",
    at: "2026-08-31T10:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

test("#1362 a verbatim sentence splits into a terse cause and the remediation behind it", () => {
  const described = describeReceiptFailure(t, HOST_DOWN);
  expect(described.cause).toBe(t("receipt.cause.hostUnavailable"));
  expect(described.full).toBe(HOST_DOWN);
  expect(described.detail).toEqual({
    sentence: "structured spawn runtime host is unavailable",
    remediation: "start agent-log-viewer through its CLI and check the CLI log for the host startup failure",
  });
});

test("#1362 a known reason code reads as its human sentence and has nothing further to reveal", () => {
  const described = describeReceiptFailure(t, "dead-host");
  expect(described.cause).toBe(t("receipt.human.deadHost"));
  expect(described.full).toBe(t("receipt.human.deadHost"));
  expect(described.detail).toBeNull();
});

test("#1362 an unknown short reason is the cause itself; an absent reason has no cause", () => {
  expect(describeReceiptFailure(t, "quota-exceeded")).toEqual({ cause: "quota-exceeded", full: "quota-exceeded", detail: null });
  expect(describeReceiptFailure(t, null)).toEqual({ cause: null, full: null, detail: null });
  expect(describeReceiptFailure(t, "   ")).toEqual({ cause: null, full: null, detail: null });
});

test("#1362 the cause key ignores casing, spacing, and which alias named a known code", () => {
  expect(failureCauseKey(HOST_DOWN)).toBe(failureCauseKey(`  Structured spawn RUNTIME host is unavailable;  ${"different remediation"}`));
  expect(failureCauseKey("dead-host")).toBe(failureCauseKey("host-dead"));
  expect(failureCauseKey("dead-host")).not.toBe(failureCauseKey(HOST_DOWN));
});

test("#1362 the run is the newest consecutive same-cause failures; older other causes stay behind it", () => {
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-a2", text: "second ask", at: "2026-08-31T10:00:03.000Z" }),
    receipt({ operationId: "op-a1", text: "first ask", at: "2026-08-31T10:00:02.000Z" }),
    receipt({ operationId: "op-b", text: "older ask", reason: "dead-host", at: "2026-08-31T10:00:01.000Z" }),
    receipt({ operationId: "op-a0", text: "oldest ask", at: "2026-08-31T10:00:00.000Z" }),
  ]);
  const run = deliveryNoticeRun(groups, []);
  expect(run).not.toBeNull();
  expect(run!.current.operationId).toBe("op-a2");
  expect(run!.causeKey).toBe(failureCauseKey(HOST_DOWN));
  expect(run!.attempts.map((attempt) => attempt.operationId)).toEqual(["op-a2", "op-a1"]);
  expect(run!.dismissIds).toEqual(["op-a2", "op-a1"]);
  expect(run!.groupCount).toBe(2);
});

test("#1362 three retries of one message count as three attempts of one group", () => {
  const groups = deliveryAttemptGroups([2, 1, 0].map((second) =>
    receipt({ operationId: `op-retry-${second}`, at: `2026-08-31T10:00:0${second}.000Z` })));
  const run = deliveryNoticeRun(groups, [])!;
  expect(run.groupCount).toBe(1);
  expect(run.attempts).toHaveLength(3);
  expect(run.dismissIds).toEqual(["op-retry-2", "op-retry-1", "op-retry-0"]);
});

test("#1362 a group still moving is not a failure, and no failures means no notice", () => {
  const moving = deliveryAttemptGroups([
    receipt({ operationId: "op-queued", status: "queued", reason: null, at: "2026-08-31T10:00:05.000Z" }),
    receipt({ operationId: "op-stale", status: "rejected", reason: "stale-turn", at: "2026-08-31T10:00:04.000Z" }),
  ]);
  expect(deliveryNoticeRun(moving, [])).toBeNull();
  expect(deliveryNoticeRun([], [])).toBeNull();
});

test("#1362 textless failed sends join the run by time and cause", () => {
  const groups = deliveryAttemptGroups([
    receipt({ operationId: "op-with-text", at: "2026-08-31T10:00:01.000Z" }),
  ]);
  const textless = [
    receipt({ operationId: "op-textless-new", text: null, at: "2026-08-31T10:00:02.000Z" }),
    receipt({ operationId: "op-textless-old", text: null, at: "2026-08-31T10:00:00.000Z" }),
  ];
  const run = deliveryNoticeRun(groups, textless)!;
  expect(run.current.operationId).toBe("op-textless-new");
  expect(run.attempts.map((attempt) => attempt.operationId)).toEqual(["op-textless-new", "op-with-text", "op-textless-old"]);
  expect(run.groupCount).toBe(3);
});
