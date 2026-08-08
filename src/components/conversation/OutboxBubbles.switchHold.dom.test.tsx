/**
 * P1 round-2 — the queued message's ONE delivery state has to carry the hold.
 *
 * The card already collapsed a held message to a single statement: its outbox
 * bubble. But during the pending window that bubble said only "Delivering" — a
 * spinner with no reason, in the exact phase the operator says an account switch
 * is hardest to follow. The bubble now says what it is waiting for, and it stays
 * the only place that says it: no second banner, no second receipt.
 *
 * What may NOT change: a settled entry keeps its own word. A failure stays a
 * failure and keeps its retry, switch or no switch.
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
type Entry = Parameters<typeof OutboxBubblesView>[0]["entries"][number];

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "key-queued",
    text: "message for the successor",
    images: 0,
    at: 1_770_000_000_000,
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

const chipText = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("[data-outbox-status]")).map((node) => node.textContent ?? "");

test("an unsettled bubble on a switching card says it waits for the switch, named or not", async () => {
  for (const locale of ["en", "uk"] as const) {
    const named = await render(
      <OutboxBubblesView
        entries={[entry({ state: "delivering" })]}
        t={translator(locale)}
        onCancel={() => {}}
        onRetry={() => {}}
        switchHold={{ label: "Account B" }}
      />,
    );
    expect(chipText(named)).toEqual([translate(locale, "outbox.heldForSwitch", { label: "Account B" })]);
    expect(named.textContent).not.toContain(translate(locale, "outbox.delivering"));

    /* The whole pending window publishes no target identity, so the nameless
       copy is the normal case — never «». */
    const nameless = await render(
      <OutboxBubblesView
        entries={[entry({ id: "key-queued-2", state: "queued" })]}
        t={translator(locale)}
        onCancel={() => {}}
        onRetry={() => {}}
        switchHold={{ label: null }}
      />,
    );
    expect(chipText(nameless)).toEqual([translate(locale, "outbox.heldForSwitchUnnamed")]);
    expect(nameless.textContent).not.toContain("«»");
    document.body.replaceChildren();
  }
});

test("with no switch running the bubble reads exactly as before", async () => {
  const host = await render(
    <OutboxBubblesView
      entries={[entry({ state: "delivering" })]}
      t={translator("en")}
      onCancel={() => {}}
      onRetry={() => {}}
    />,
  );
  expect(chipText(host)).toEqual([translate("en", "outbox.delivering")]);
  document.body.replaceChildren();
});

test("a failed delivery keeps its own failure and its retry through a switch", async () => {
  const host = await render(
    <OutboxBubblesView
      entries={[entry({ id: "key-failed", state: "failed", error: "pane is gone" })]}
      t={translator("en")}
      onCancel={() => {}}
      onRetry={() => {}}
      switchHold={{ label: "Account B" }}
    />,
  );
  /* Tidying a real failure into a hold would strand the operator's message with
     nothing to act on. */
  expect(chipText(host)).toEqual(["pane is gone"]);
  expect(host.querySelector("[data-outbox-retry='key-failed']")).toBeTruthy();
  document.body.replaceChildren();
});

test("the durable entry state is untouched — the hold is display only", async () => {
  const host = await render(
    <OutboxBubblesView
      entries={[entry({ state: "delivering" })]}
      t={translator("en")}
      onCancel={() => {}}
      onRetry={() => {}}
      switchHold={{ label: null }}
    />,
  );
  expect(host.querySelector("[data-outbox-entry='key-queued']")?.getAttribute("data-outbox-state")).toBe("delivering");
  document.body.replaceChildren();
});
