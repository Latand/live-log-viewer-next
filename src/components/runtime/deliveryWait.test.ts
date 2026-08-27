/**
 * Issue #1213 — the composer delivery phases, told apart.
 *
 * The operator's evidence: four deliveries into one busy structured host took
 * 2 min, 12 s, 21 min and 4 min; the fifth never arrived. All five rendered the
 * same spinner. This model is the one authority that separates "on the wire"
 * from "waiting for a turn boundary" from "we can no longer say it is coming".
 */
import { expect, test } from "bun:test";

import { DELIVERY_UNCERTAIN_MS, deliveryWaitFor, deliveryWaitText } from "./deliveryWait";
import { translate } from "@/lib/i18n";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const AT = "2026-08-27T10:00:00.000Z";
const at = (offsetMs: number) => Date.parse(AT) + offsetMs;
/** The host the operator was talking to: alive, and inside a turn. Only this
    evidence lets a wait be described as a turn boundary. */
const BUSY = { host: "hosted", turn: "running" } as const;
/** One label-unit past the bound. Derived from the bound so raising the bound
    cannot leave a stale minute count asserted next to it. */
const PAST_BOUND_MS = DELIVERY_UNCERTAIN_MS + 60_000;
const PAST_BOUND_MIN = Math.round(PAST_BOUND_MS / 60_000);
/** The longest wait in #1213's own table that ENDED IN A DELIVERY. */
const LONGEST_ARRIVED_MS = 21 * 60_000;

test("an attempt on the request path is transmitting, and says how long it has been", () => {
  expect(deliveryWaitFor({ status: "pending", ...BUSY, admittedAt: AT, nowMs: at(1_500) }))
    .toEqual({ phase: "transmitting", waitedMs: 1_500, cause: "turn" });
});

test("an attempt the queue is handing over is its own phase, never the uncertain terminal", () => {
  /* The delivery queue writes `delivering` BEFORE it calls `host.send`, so this
     is a message already on its way to the agent, and the queue always writes
     an outcome for it. Calling it undelivered would be false; it names its own
     age instead. */
  expect(deliveryWaitFor({ status: "delivering", ...BUSY, admittedAt: AT, nowMs: at(4_000) }))
    .toEqual({ phase: "handing-over", waitedMs: 4_000, cause: "turn" });
  expect(deliveryWaitFor({
    status: "delivering",
    ...BUSY,
    admittedAt: AT,
    nowMs: at(PAST_BOUND_MS),
  })?.phase).toBe("handing-over");
  expect(deliveryWaitFor({ status: "applying", ...BUSY, admittedAt: AT, nowMs: at(1_000) })?.phase)
    .toBe("handing-over");
});

test("a hand-over is silent while it is momentary and names itself once it is not", () => {
  const brief = deliveryWaitFor({ status: "delivering", ...BUSY, admittedAt: AT, nowMs: at(4_000) })!;
  expect(deliveryWaitText(t, brief)).toBeNull();
  const long = deliveryWaitFor({
    status: "delivering",
    ...BUSY,
    admittedAt: AT,
    nowMs: at(PAST_BOUND_MS),
  })!;
  expect(deliveryWaitText(t, long)).toBe(t("runtime.receipt.handingOverFor", {
    waited: t("runtime.receipt.waitedMin", { n: PAST_BOUND_MIN }),
  }));
});

test("an admitted-but-undelivered message is waiting for a turn boundary, not transmitting", () => {
  /* `queued` is exactly the state the structured delivery queue parks a send
     in while the host is inside a turn: it never transitions to `delivering`
     until `health.status === "idle"`. Saying "delivering" here is the lie. */
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, nowMs: at(12_000) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 12_000, cause: "turn" });
});

test("a send whose admission was never confirmed says that, and never claims a turn boundary", () => {
  /* The composer's own local row (`composer-unconfirmed:<key>`): the journal
     writes `uncertain` only for compact, so the only send receipt carrying it
     is the one the composer mints when it could not confirm admission at all.
     "Waiting for the agent to finish its turn" would assert the admission that
     is precisely what is unknown. */
  const wait = deliveryWaitFor({ status: "uncertain", ...BUSY, admittedAt: AT, nowMs: at(60_000) })!;
  expect(wait).toEqual({ phase: "unconfirmed-admission", waitedMs: 60_000, cause: "turn" });
  expect(deliveryWaitText(t, wait)).toBe(t("runtime.receipt.admissionUnconfirmed", {
    waited: t("runtime.receipt.waitedMin", { n: 1 }),
  }));
  /* And it stays its own phase past the bound: an admission nobody confirmed is
     a different fact from a message that was admitted and never handed over. */
  expect(deliveryWaitFor({
    status: "uncertain",
    ...BUSY,
    admittedAt: AT,
    nowMs: at(PAST_BOUND_MS),
  })?.phase).toBe("unconfirmed-admission");
});

test("the bound sits strictly above the longest wait in #1213 that DID arrive", () => {
  /* The terminal row tells the operator nothing will retry this message and to
     send it again himself. A bound at or below a wait that really does end in a
     delivery turns that sentence into an instruction to double-deliver by hand —
     the exact outcome the Retry control was cut to prevent. #1213's table has a
     success at 21 minutes, so the bound has to be past it. */
  expect(DELIVERY_UNCERTAIN_MS).toBeGreaterThan(LONGEST_ARRIVED_MS);
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, nowMs: at(LONGEST_ARRIVED_MS) })?.phase)
    .toBe("awaiting-turn");
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, nowMs: at(DELIVERY_UNCERTAIN_MS - 1) })?.phase)
    .toBe("awaiting-turn");
});

test("a parked delivery unconfirmed past the bound is uncertain", () => {
  for (const status of ["pending", "queued"] as const) {
    expect(deliveryWaitFor({ status, ...BUSY, admittedAt: AT, nowMs: at(DELIVERY_UNCERTAIN_MS) }))
      .toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, cause: "turn" });
  }
});

test("a settled receipt has no wait to report — the existing terminal rendering owns it", () => {
  for (const status of ["delivered", "applied", "answered", "interrupted", "failed", "rejected"] as const) {
    expect(deliveryWaitFor({ status, ...BUSY, admittedAt: AT, nowMs: at(DELIVERY_UNCERTAIN_MS) })).toBeNull();
  }
});

test("a message already inside the agent's turn has no wait either", () => {
  /* `turn-started`/`steered` are not terminal receipts, but they PROVE the
     message reached the agent: there is no wait left to describe. */
  for (const status of ["turn-started", "steered"] as const) {
    expect(deliveryWaitFor({ status, ...BUSY, admittedAt: AT, nowMs: at(DELIVERY_UNCERTAIN_MS) })).toBeNull();
  }
});

test("an unparseable or future admission stamp never manufactures a wait", () => {
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: "not a date", nowMs: at(0) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 0, cause: "turn" });
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, nowMs: at(-5_000) }))
    .toEqual({ phase: "awaiting-turn", waitedMs: 0, cause: "turn" });
});

test("a delivery stranded by a host that went away does not claim to wait on a turn", () => {
  /* The rollback case: a deployment that terminates every structured host
     leaves each in-flight send parked with nothing hosting the conversation.
     There is no turn to finish, so saying so would be false in exactly the
     incident this state is most common in. The host's OWN axis says it, and it
     outranks a turn axis the dead host left behind. */
  for (const host of ["dead", "unhosted"] as const) {
    expect(deliveryWaitFor({ status: "queued", host, turn: "unknown", admittedAt: AT, nowMs: at(90_000) }))
      .toEqual({ phase: "awaiting-host", waitedMs: 90_000, cause: "host" });
  }
  expect(deliveryWaitFor({
    status: "queued",
    host: "dead",
    turn: "running",
    admittedAt: AT,
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
    nowMs: at(DELIVERY_UNCERTAIN_MS),
  })).toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, cause: "host" });
});

test("a wait nobody can explain says so instead of inventing a turn", () => {
  /* Why the receipt's own reason is never read for this: the journal keeps a
     same-status transition as a no-op, so a message already `queued` when its
     host died keeps whatever reason it had, and the queue's dead-host branch
     writes a raw engine error rather than a token anything can recognize. With
     no host axis behind this surface, "waiting for the agent to finish its
     turn" asserts a turn nobody established — including in the terminal row,
     where it becomes the explanation the operator acts on. */
  const parked = deliveryWaitFor({ status: "queued", admittedAt: AT, nowMs: at(90_000) })!;
  expect(parked).toEqual({ phase: "awaiting-handover", waitedMs: 90_000, cause: "unknown" });
  expect(deliveryWaitText(t, parked)).toBe(t("runtime.receipt.awaitingHandoverFor", {
    waited: t("runtime.receipt.waitedMin", { n: 2 }),
  }));
  expect(deliveryWaitFor({ status: "queued", admittedAt: AT, nowMs: at(DELIVERY_UNCERTAIN_MS) }))
    .toEqual({ phase: "uncertain", waitedMs: DELIVERY_UNCERTAIN_MS, cause: "unknown" });
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
    nowMs: at(3_000),
  })).toEqual({ phase: "awaiting-handover", waitedMs: 3_000, cause: "unknown" });
});

test("an agent mid-turn is a turn-boundary wait", () => {
  expect(deliveryWaitFor({ status: "queued", ...BUSY, admittedAt: AT, nowMs: at(1_000) })?.phase)
    .toBe("awaiting-turn");
  expect(deliveryWaitFor({
    status: "queued",
    host: "hosted",
    turn: "interrupt_requested",
    admittedAt: AT,
    nowMs: at(1_000),
  })?.phase).toBe("awaiting-turn");
});
