/**
 * Issue #1213 — the bubble the operator was actually looking at.
 *
 * The report's screenshot is this surface: an optimistic user bubble reading
 * «Delivering» with a spinner, for a message that was parked behind a turn that
 * never ended. It said the same word for a delivery that landed in twelve
 * seconds, one that landed in twenty-one minutes, and one that never landed —
 * and it had no test at all.
 *
 * What must NOT appear here: a control. The bubble is the composer's local
 * mirror and owns no journal operation. `retryOutbox` refuses anything but a
 * failed entry, and `cancelOutbox` deletes the local row while the server keeps
 * holding the message — so a Retry or an X on an admitted bubble is a button
 * that lies. The exit lives on the receipt row, which owns the operation.
 */
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { installActEnv } from "@/test-helpers/actEnv";
import { type TFunction, translate } from "@/lib/i18n";

const translator = (locale: "en" | "uk"): TFunction => (key, params) => translate(locale, key, params);

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
});

const { OutboxBubblesView } = await import("@/components/conversation/OutboxBubbles");
const { outboxReceiptPatch } = await import("@/components/conversation/outbox");
type ReceiptStatus = Parameters<typeof outboxReceiptPatch>[1];
const { DELIVERY_UNCERTAIN_MS } = await import("@/components/runtime/deliveryWait");
/** One label-unit past the bound. Derived from the bound so raising the bound
    cannot leave a stale minute count asserted next to it. */
const PAST_BOUND_MS = DELIVERY_UNCERTAIN_MS + 60_000;
const PAST_BOUND_MIN = Math.round(PAST_BOUND_MS / 60_000);
type Entry = Parameters<typeof OutboxBubblesView>[0]["entries"][number];
type Session = NonNullable<Parameters<typeof OutboxBubblesView>[0]["session"]>;

/** The host the operator was talking to: alive, and inside a turn. The bubble
    may only name a turn boundary on the host's own evidence. */
const BUSY: Session = { host: "hosted", turn: "running" };

const SUBMITTED_AT = 1_772_000_000_000;

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "key-1213",
    text: "status of the merge queue",
    images: 0,
    at: SUBMITTED_AT,
    state: "delivering",
    ...overrides,
  } as Entry;
}

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(node));
  return host;
}

const chip = (host: HTMLElement) => host.querySelector("[data-outbox-status]")?.textContent ?? "";
const phase = (host: HTMLElement) => host.querySelector("[data-outbox-entry]")?.getAttribute("data-outbox-wait");

async function bubble(
  overrides: Partial<Entry>,
  nowMs: number,
  locale: "en" | "uk" = "en",
  session: Session | null = BUSY,
) {
  document.body.replaceChildren();
  return render(
    <OutboxBubblesView
      entries={[entry(overrides)]}
      t={translator(locale)}
      nowMs={nowMs}
      onCancel={() => {}}
      onRetry={() => {}}
      session={session}
    />,
  );
}

test("#1213 an attempt on the wire keeps the wording it always had", async () => {
  const host = await bubble({}, SUBMITTED_AT + 4_000);
  expect(phase(host)).toBe("handing-over");
  expect(chip(host)).toBe(translate("en", "outbox.delivering"));
  expect(host.querySelector(".animate-spin")).not.toBeNull();
});

test("#1213 a message parked at a turn boundary says which wait it is in, and its age", async () => {
  for (const locale of ["en", "uk"] as const) {
    const host = await bubble({ awaitingTurn: true }, SUBMITTED_AT + 4 * 60_000, locale);
    expect(phase(host)).toBe("awaiting-turn");
    expect(chip(host)).toBe(translate(locale, "runtime.receipt.awaitingTurnFor", {
      waited: translate(locale, "runtime.receipt.waitedMin", { n: 4 }),
    }));
    /* The lie the operator reported: nothing is being transmitted. */
    expect(host.textContent).not.toContain(translate(locale, "outbox.delivering"));
    expect(host.querySelector(".animate-spin")).toBeNull();
  }
});

test("#1213 past the bound the bubble says it was not delivered, and how long it waited", async () => {
  for (const locale of ["en", "uk"] as const) {
    const host = await bubble({ awaitingTurn: true }, SUBMITTED_AT + PAST_BOUND_MS, locale);
    expect(phase(host)).toBe("uncertain");
    expect(chip(host)).toBe(translate(locale, "runtime.receipt.unconfirmed", {
      waited: translate(locale, "runtime.receipt.waitedMin", { n: PAST_BOUND_MIN }),
    }));
    expect(host.querySelector(".animate-spin")).toBeNull();
  }
});

/**
 * Replay the composer's own receipt→bubble projection over a receipt sequence
 * and render what the operator is looking at after each one.
 *
 * The projection is the real one ({@link outboxReceiptPatch}); only the store
 * and the effect that calls it are stood in for here, so the wording asserted
 * below is the wording the composer produces.
 */
async function drive(statuses: readonly ReceiptStatus[], nowMs: number) {
  let projected: Partial<Entry> = {};
  const seen: { chip: string; phase: string | null | undefined }[] = [];
  for (const status of statuses) {
    const patch = outboxReceiptPatch(entry(projected), status);
    if (patch) projected = { ...projected, ...patch };
    const host = await bubble(projected, nowMs);
    seen.push({ chip: chip(host), phase: phase(host) });
  }
  return seen;
}

test("#1213 a send parked at a turn boundary stops reading as an attempt on the wire", async () => {
  /* The defect the operator photographed, at its root: `pending`, `queued`,
     `delivering` and `applying` all project to ONE `delivering` bubble state, so
     a reconciliation guard that compares state alone never sees the delivery
     queue park this send behind a turn — and the bubble keeps the spinner and
     the bare word «Delivering» for as long as the turn runs. */
  const nowMs = SUBMITTED_AT + 4 * 60_000;
  const [onWire, parked] = await drive(["delivering", "queued"], nowMs);
  expect(onWire!.phase).toBe("handing-over");
  expect(onWire!.chip).toBe(translate("en", "outbox.delivering"));
  expect(parked!.phase).toBe("awaiting-turn");
  expect(parked!.chip).toBe(translate("en", "runtime.receipt.awaitingTurnFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 4 }),
  }));
});

test("#1213 a send taken off the park and put on the wire stops claiming a turn boundary", async () => {
  /* The same guard in the other direction: the queue reaches the turn boundary
     and moves the send `queued`→`delivering`, and the bubble would go on saying
     the agent is mid-turn while the message is genuinely being handed over. */
  const nowMs = SUBMITTED_AT + 4 * 60_000;
  const [, handingOver] = await drive(["queued", "delivering"], nowMs);
  expect(handingOver!.phase).toBe("handing-over");
  expect(handingOver!.chip).toBe(translate("en", "outbox.delivering"));
});

test("#1213 an admission the request path never confirmed leaves the bubble alone", async () => {
  /* `pending`, `applying` and `uncertain` prove nothing about a hand-over, so
     none of them may write a turn boundary onto the bubble — that flag is a
     claim about where the message IS. */
  for (const status of ["pending", "applying", "uncertain"] as const) {
    expect(outboxReceiptPatch({ state: "delivering" }, status)).toBeNull();
    expect(outboxReceiptPatch({ state: "delivering", awaitingTurn: true }, status)).toBeNull();
  }
});

test("#1213 no admitted bubble offers a control that cannot act on the message", async () => {
  /* Both of these would be lies: `retryOutbox` ignores a `delivering` entry,
     and `cancelOutbox` drops the bubble while the server still holds the send
     — the operator would believe a message was withdrawn that later arrives. */
  for (const nowMs of [SUBMITTED_AT + 4_000, SUBMITTED_AT + PAST_BOUND_MS]) {
    const host = await bubble({ awaitingTurn: true }, nowMs);
    expect(host.querySelector("[data-outbox-retry]")).toBeNull();
    expect(host.querySelector("[data-outbox-cancel]")).toBeNull();
  }
});

test("#1213 a queued or failed bubble keeps the controls it has always had", async () => {
  const queued = await bubble({ state: "queued" }, SUBMITTED_AT + DELIVERY_UNCERTAIN_MS);
  /* Never handed to the server at all — taking it back is honest. */
  expect(queued.querySelector("[data-outbox-cancel='key-1213']")).not.toBeNull();

  const failed = await bubble({ state: "failed", error: "pane is gone" }, SUBMITTED_AT + 60_000);
  expect(chip(failed)).toBe("pane is gone");
  expect(failed.querySelector("[data-outbox-retry='key-1213']")).not.toBeNull();
  expect(failed.querySelector("[data-outbox-cancel='key-1213']")).not.toBeNull();
});

test("#1213 a delivery stranded by a host that went away is not called a turn boundary", async () => {
  /* The rollback population: a deployment terminates every structured host and
     each parked message stays exactly where it was. The bubble reads the same
     host axis the composer does, so it says the window is gone instead of
     naming a turn on an agent that is not there. */
  const host = await bubble(
    { awaitingTurn: true },
    SUBMITTED_AT + 3 * 60_000,
    "en",
    { host: "dead", turn: "running" },
  );
  expect(phase(host)).toBe("awaiting-host");
  expect(chip(host)).toBe(translate("en", "runtime.receipt.awaitingHostFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 3 }),
  }));
  expect(chip(host)).not.toContain(translate("en", "runtime.receipt.awaitingTurnFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 3 }),
  }));
});

test("#1213 with no host behind the feed the bubble says it is waiting without naming a turn", async () => {
  /* A legacy surface with nothing structured behind it knows only that the
     message was admitted. Claiming a turn there is an invention, and the same
     invention would become the explanation on the terminal row. */
  const host = await bubble({ awaitingTurn: true }, SUBMITTED_AT + 3 * 60_000, "en", null);
  expect(phase(host)).toBe("awaiting-handover");
  expect(chip(host)).toBe(translate("en", "runtime.receipt.awaitingHandoverFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 3 }),
  }));
});

test("#1224 a bubble for a document-only submission names its attachment instead of rendering blank", async () => {
  /* An attachment-only message has no text of its own, and the count came from
     the images alone — so the operator's document appeared as an empty bubble
     with a status chip under it. */
  const host = await bubble({ text: "", images: 0, files: 1 }, SUBMITTED_AT + 1_000);
  expect(host.textContent).toContain(translate("en", "composer.attachmentsCount", { count: 1 }));

  /* An images-only submission keeps the wording it always had. */
  const images = await bubble({ text: "", images: 2 }, SUBMITTED_AT + 1_000);
  expect(images.textContent).toContain(translate("en", "composer.imagesCount", { count: 2 }));
});
