/**
 * Issue #1213 — the composer delivery phases, told apart.
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
  deliveryWaitText,
} from "./deliveryWait";
import { translate } from "@/lib/i18n";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const AT = "2026-08-27T10:00:00.000Z";
const at = (offsetMs: number) => Date.parse(AT) + offsetMs;
/** The host the operator was talking to: alive, and inside a turn. Only this
    evidence lets a wait be described as a turn boundary. */
const BUSY = { host: "hosted", turn: "running" } as const;

test("an attempt on the request path is transmitting, and says how long it has been", () => {
  expect(deliveryWaitFor({ status: "pending", ...BUSY, admittedAt: AT, attempts: 1, nowMs: at(1_500) }))
    .toEqual({ phase: "transmitting", waitedMs: 1_500, attempts: 1, cause: "turn" });
});

test("an attempt the queue is handing over is its own phase, and cannot be abandoned", () => {
  /* The delivery queue writes `delivering` BEFORE it calls `host.send`, so this
     is a message already on its way to the agent. It must never reach the
     `uncertain` terminal, whose whole contract is that failing the operation
     retires the effect: doing that mid-hand-over delivers the message AND a
     replacement. The server refuses it for the same reason. */
  expect(deliveryWaitFor({ status: "delivering", ...BUSY, admittedAt: AT, attempts: 2, nowMs: at(4_000) }))
    .toEqual({ phase: "handing-over", waitedMs: 4_000, attempts: 2, cause: "turn" });
  expect(deliveryWaitFor({
    status: "delivering",
    ...BUSY,
    admittedAt: AT,
    attempts: 2,
    nowMs: at(DELIVERY_UNCERTAIN_MS + 60_000),
  })?.phase).toBe("handing-over");
  expect(deliveryWaitFor({ status: "applying", ...BUSY, admittedAt: AT, attempts: 1, nowMs: at(1_000) })?.phase)
    .toBe("handing-over");
});

test("a hand-over is silent while it is momentary and names itself once it is not", () => {
  const brief = deliveryWaitFor({ status: "delivering", ...BUSY, admittedAt: AT, attempts: 1, nowMs: at(4_000) })!;
  expect(deliveryWaitText(t, brief)).toBeNull();
  const long = deliveryWaitFor({
    status: "delivering",
    ...BUSY,
    admittedAt: AT,
    attempts: 1,
    nowMs: at(DELIVERY_UNCERTAIN_MS + 60_000),
  })!;
  expect(deliveryWaitText(t, long)).toBe(t("runtime.receipt.handingOverFor", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
});

test("an admitted-but-undelivered message is waiting for a turn boundary, not transmitting", () => {
  /* `queued` is exactly the state the structured delivery queue parks a send
     in while the host is inside a turn: it never transitions to `delivering`
     until `health.status === "idle"`. Saying "delivering" here is the lie. */
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, attempts: 1, nowMs: at(12_000) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 12_000, attempts: 1, cause: "turn" });
});

test("a send whose admission was never confirmed says that, and never claims a turn boundary", () => {
  /* The composer's own local row (`composer-unconfirmed:<key>`): the journal
     writes `uncertain` only for compact, so the only send receipt carrying it
     is the one the composer mints when it could not confirm admission at all.
     "Waiting for the agent to finish its turn" would assert the admission that
     is precisely what is unknown. */
  const wait = deliveryWaitFor({ status: "uncertain", ...BUSY, admittedAt: AT, attempts: 2, nowMs: at(60_000) })!;
  expect(wait).toEqual({ phase: "unconfirmed-admission", waitedMs: 60_000, attempts: 2, cause: "turn" });
  expect(deliveryWaitText(t, wait)).toBe(t("runtime.receipt.admissionUnconfirmed", {
    waited: t("runtime.receipt.waitedMin", { n: 1 }),
  }));
  /* And it stays its own phase past the bound: the operator's exit there is the
     composer's own draft, not a journal operation that may not exist. */
  expect(deliveryWaitFor({
    status: "uncertain",
    ...BUSY,
    admittedAt: AT,
    attempts: 2,
    nowMs: at(DELIVERY_UNCERTAIN_MS + 60_000),
  })?.phase).toBe("unconfirmed-admission");
});

test("the 21-minute delivery is still legitimately waiting at 20 minutes minus a tick", () => {
  const wait = deliveryWaitFor({
    status: "queued",
    ...BUSY,
    admittedAt: AT,
    attempts: 2,
    nowMs: at(DELIVERY_UNCERTAIN_MS - 1),
  });
  expect(wait?.phase).toBe("awaiting-turn");
});

test("an abandonable delivery unconfirmed past the bound is uncertain", () => {
  for (const status of ["pending", "queued"] as const) {
    expect(deliveryWaitFor({ status, ...BUSY, admittedAt: AT, attempts: 2, nowMs: at(DELIVERY_UNCERTAIN_MS) }))
      .toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, attempts: 2, cause: "turn" });
  }
});

test("a settled receipt has no wait to report — the existing terminal rendering owns it", () => {
  for (const status of ["delivered", "applied", "answered", "interrupted", "failed", "rejected"] as const) {
    expect(deliveryWaitFor({ status, ...BUSY, admittedAt: AT, attempts: 3, nowMs: at(DELIVERY_UNCERTAIN_MS) })).toBeNull();
  }
});

test("a message already inside the agent's turn has no wait either", () => {
  /* `turn-started`/`steered` are not terminal receipts, but they PROVE the
     message reached the agent. Offering an exit from them would abandon a
     delivery that already happened. */
  for (const status of ["turn-started", "steered"] as const) {
    expect(deliveryWaitFor({ status, ...BUSY, admittedAt: AT, attempts: 1, nowMs: at(DELIVERY_UNCERTAIN_MS) })).toBeNull();
  }
});

test("an unparseable or future admission stamp never manufactures a wait", () => {
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: "not a date", attempts: 1, nowMs: at(0) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 0, attempts: 1, cause: "turn" });
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, attempts: 1, nowMs: at(-5_000) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 0, attempts: 1, cause: "turn" });
});

test("the attention threshold sits below the uncertain bound and above ordinary latency", () => {
  /* From the operator's own table: 2 min, 12 s, 21 min and 4 min all landed.
     A threshold under four minutes would call two healthy deliveries blocked. */
  expect(DELIVERY_WAIT_ATTENTION_MS).toBeGreaterThan(4 * 60_000);
  expect(DELIVERY_WAIT_ATTENTION_MS).toBeLessThan(DELIVERY_UNCERTAIN_MS);
});

test("attempts never read below one — a wait implies an attempt was made", () => {
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, attempts: 0, nowMs: at(1_000) })?.attempts).toBe(1);
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, attempts: -3, nowMs: at(1_000) })?.attempts).toBe(1);
});

test("a delivery stranded by a host that went away does not claim to wait on a turn", () => {
  /* The rollback case: a deployment that terminates every structured host
     leaves each in-flight send parked with nothing hosting the conversation.
     There is no turn to finish, so saying so would be false in exactly the
     incident this state is most common in. The host's OWN axis says it — and it
     says it even when the receipt's reason is null, which is what a journal
     same-status transition leaves behind. */
  for (const host of ["dead", "unhosted"] as const) {
    expect(deliveryWaitFor({ status: "queued", host, turn: "unknown", admittedAt: AT, attempts: 2, nowMs: at(90_000) }))
      .toEqual({ phase: "awaiting-host", waitedMs: 90_000, attempts: 2, cause: "host" });
  }
  expect(deliveryWaitFor({
    status: "queued",
    host: "dead",
    turn: "running",
    reason: null,
    admittedAt: AT,
    attempts: 2,
    nowMs: at(90_000),
  })?.phase).toBe("awaiting-host");
});

test("a host that never comes back reaches the uncertain terminal carrying its own cause", () => {
  /* The cause survives the phase change, because the uncertain row is the ONE
     place the operator is told why the message never arrived — and "the agent
     stayed inside a turn" is false when nothing was hosting it at all. */
  expect(deliveryWaitFor({
    status: "queued",
    host: "dead",
    turn: "unknown",
    admittedAt: AT,
    attempts: 2,
    nowMs: at(DELIVERY_UNCERTAIN_MS),
  })).toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, attempts: 2, cause: "host" });
});

test("a wait nobody can explain says so instead of inventing a turn", () => {
  /* The defect the receipt's reason cannot fix: the journal keeps a same-status
     transition as a no-op, so a message already `queued` when its host died
     keeps a null reason, and the queue's own dead-host branch writes a raw
     engine error rather than the `dead-host` token. With no host axis behind
     this surface, "waiting for the agent to finish its turn" asserts a turn
     nobody established — including in the terminal row, where it becomes the
     explanation the operator acts on. */
  const parked = deliveryWaitFor({ status: "queued", reason: null, admittedAt: AT, attempts: 1, nowMs: at(90_000) })!;
  expect(parked).toEqual({ phase: "awaiting-handover", waitedMs: 90_000, attempts: 1, cause: "unknown" });
  expect(deliveryWaitText(t, parked)).toBe(t("runtime.receipt.awaitingHandoverFor", {
    waited: t("runtime.receipt.waitedMin", { n: 2 }),
  }));
  expect(deliveryWaitFor({
    status: "queued",
    reason: "thread read timed out",
    admittedAt: AT,
    attempts: 1,
    nowMs: at(DELIVERY_UNCERTAIN_MS),
  })).toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, attempts: 1, cause: "unknown" });
});

test("a hosted agent that is not in a turn is not described as waiting for one", () => {
  /* An idle host with a parked send is a drain that has not run yet — momentary
     and real, but not a turn boundary. Naming a turn here would be the same
     invention, one state further along. */
  expect(deliveryWaitFor({
    status: "queued",
    host: "hosted",
    turn: "idle",
    admittedAt: AT,
    attempts: 1,
    nowMs: at(3_000),
  })).toEqual({ phase: "awaiting-handover", waitedMs: 3_000, attempts: 1, cause: "unknown" });
});

test("a dead-host reason still answers when no host axis reached this surface", () => {
  /* Weak evidence, but evidence: a legacy surface with no structured session
     behind it has only the receipt to read, and a `dead-host` token there is
     the host saying so at the moment it was written. */
  for (const reason of ["dead-host", "host-dead", "no-host", "unhosted", "host-unavailable"]) {
    expect(deliveryWaitFor({ status: "queued", reason, admittedAt: AT, attempts: 2, nowMs: at(90_000) })?.phase)
      .toBe("awaiting-host");
  }
});

test("an agent mid-turn is a turn-boundary wait whatever its reason says", () => {
  for (const reason of [null, undefined, "busy-turn", "delivery-auto-retry", "interrupt-requested"]) {
    expect(deliveryWaitFor({ status: "queued", ...BUSY, reason, admittedAt: AT, attempts: 1, nowMs: at(1_000) })?.phase)
      .toBe("awaiting-turn");
  }
});
