/**
 * Issue #1213 — the three composer delivery phases, told apart.
 *
 * The operator's evidence: four deliveries into one busy structured host took
 * 2 min, 12 s, 21 min and 4 min; the fifth never arrived. All five rendered the
 * same spinner. This model is the one authority that separates "on the wire"
 * from "waiting for a turn boundary" from "we can no longer say it is coming".
 */
import { expect, test } from "bun:test";

import {
  DELIVERY_UNCERTAIN_MS,
  DELIVERY_WAIT_ATTENTION_MS,
  deliveryWaitFor,
} from "./deliveryWait";

const AT = "2026-08-27T10:00:00.000Z";
const at = (offsetMs: number) => Date.parse(AT) + offsetMs;

test("an attempt on the wire is transmitting, and says how long it has been", () => {
  expect(deliveryWaitFor({ status: "pending", firstAttemptAt: AT, attempts: 1, nowMs: at(1_500) }))
    .toEqual({ phase: "transmitting", waitedMs: 1_500, attempts: 1 });
  expect(deliveryWaitFor({ status: "delivering", firstAttemptAt: AT, attempts: 2, nowMs: at(4_000) }))
    .toEqual({ phase: "transmitting", waitedMs: 4_000, attempts: 2 });
});

test("an admitted-but-undelivered message is waiting for a turn boundary, not transmitting", () => {
  /* `queued` is exactly the state the structured delivery queue parks a send
     in while the host is inside a turn: it never transitions to `delivering`
     until `health.status === "idle"`. Saying "delivering" here is the lie. */
  expect(deliveryWaitFor({ status: "queued", firstAttemptAt: AT, attempts: 1, nowMs: at(12_000) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 12_000, attempts: 1 });
  expect(deliveryWaitFor({ status: "uncertain", firstAttemptAt: AT, attempts: 2, nowMs: at(60_000) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 60_000, attempts: 2 });
});

test("the 21-minute delivery is still legitimately waiting at 20 minutes minus a tick", () => {
  const wait = deliveryWaitFor({
    status: "queued",
    firstAttemptAt: AT,
    attempts: 2,
    nowMs: at(DELIVERY_UNCERTAIN_MS - 1),
  });
  expect(wait?.phase).toBe("awaiting-turn");
});

test("a delivery unconfirmed past the bound is uncertain, whatever it was doing before", () => {
  for (const status of ["pending", "delivering", "queued", "uncertain", "applying"] as const) {
    expect(deliveryWaitFor({ status, firstAttemptAt: AT, attempts: 2, nowMs: at(DELIVERY_UNCERTAIN_MS) }))
      .toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, attempts: 2 });
  }
});

test("a settled receipt has no wait to report — the existing terminal rendering owns it", () => {
  for (const status of ["delivered", "applied", "answered", "interrupted", "failed", "rejected"] as const) {
    expect(deliveryWaitFor({ status, firstAttemptAt: AT, attempts: 3, nowMs: at(DELIVERY_UNCERTAIN_MS) })).toBeNull();
  }
});

test("an unparseable or future first attempt never manufactures a wait", () => {
  expect(deliveryWaitFor({ status: "queued", firstAttemptAt: "not a date", attempts: 1, nowMs: at(0) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 0, attempts: 1 });
  expect(deliveryWaitFor({ status: "queued", firstAttemptAt: AT, attempts: 1, nowMs: at(-5_000) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 0, attempts: 1 });
});

test("the attention threshold sits below the uncertain bound and above ordinary latency", () => {
  /* From the operator's own table: 2 min, 12 s, 21 min and 4 min all landed.
     A threshold under four minutes would call two healthy deliveries blocked. */
  expect(DELIVERY_WAIT_ATTENTION_MS).toBeGreaterThan(4 * 60_000);
  expect(DELIVERY_WAIT_ATTENTION_MS).toBeLessThan(DELIVERY_UNCERTAIN_MS);
});

test("attempts never read below one — a wait implies an attempt was made", () => {
  expect(deliveryWaitFor({ status: "queued", firstAttemptAt: AT, attempts: 0, nowMs: at(1_000) })?.attempts).toBe(1);
  expect(deliveryWaitFor({ status: "queued", firstAttemptAt: AT, attempts: -3, nowMs: at(1_000) })?.attempts).toBe(1);
});

test("a delivery stranded by a host that went away does not claim to wait on a turn", () => {
  /* The rollback case: a deployment that terminates every structured host
     leaves each in-flight send `queued` with a `dead-host` reason. There is no
     turn to finish — nothing is hosting the conversation at all — so saying so
     would be false in exactly the incident this state is most common in. */
  for (const reason of ["dead-host", "host-dead", "no-host", "unhosted", "host-unavailable"]) {
    expect(deliveryWaitFor({ status: "queued", reason, firstAttemptAt: AT, attempts: 2, nowMs: at(90_000) }))
      .toEqual({ phase: "awaiting-host", waitedMs: 90_000, attempts: 2 });
  }
});

test("a host that never comes back reaches the same uncertain terminal as a turn that never ends", () => {
  expect(deliveryWaitFor({
    status: "queued",
    reason: "dead-host",
    firstAttemptAt: AT,
    attempts: 2,
    nowMs: at(DELIVERY_UNCERTAIN_MS),
  })).toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, attempts: 2 });
});

test("an ordinary turn-boundary reason is still a turn-boundary wait", () => {
  for (const reason of [null, undefined, "busy-turn", "delivery-auto-retry", "interrupt-requested"]) {
    expect(deliveryWaitFor({ status: "queued", reason, firstAttemptAt: AT, attempts: 1, nowMs: at(1_000) })?.phase)
      .toBe("awaiting-turn");
  }
});
