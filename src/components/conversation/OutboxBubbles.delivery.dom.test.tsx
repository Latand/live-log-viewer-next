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
const { DELIVERY_UNCERTAIN_MS } = await import("@/components/runtime/deliveryWait");
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
    const host = await bubble({ awaitingTurn: true }, SUBMITTED_AT + DELIVERY_UNCERTAIN_MS + 60_000, locale);
    expect(phase(host)).toBe("uncertain");
    expect(chip(host)).toBe(translate(locale, "runtime.receipt.unconfirmed", {
      waited: translate(locale, "runtime.receipt.waitedMin", { n: 21 }),
    }));
    expect(host.querySelector(".animate-spin")).toBeNull();
  }
});

test("#1213 no admitted bubble offers a control that cannot act on the message", async () => {
  /* Both of these would be lies: `retryOutbox` ignores a `delivering` entry,
     and `cancelOutbox` drops the bubble while the server still holds the send
     — the operator would believe a message was withdrawn that later arrives. */
  for (const nowMs of [SUBMITTED_AT + 4_000, SUBMITTED_AT + DELIVERY_UNCERTAIN_MS + 60_000]) {
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
