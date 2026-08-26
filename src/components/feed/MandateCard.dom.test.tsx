import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import { FeedItem } from "./FeedItem";
import { MessageProvenanceProvider, provenanceLookupFor } from "./messageProvenance";
import type { Item } from "./parse";

/**
 * #1166 end to end through the renderer: the delivered mandate stops posing as
 * the operator's own 8 KB bubble and becomes a card that names what it is and
 * opens on demand. Which row that is comes from the delivery evidence, so the
 * dock and the board's conversation pane — the same `FeedItem` reading the same
 * provenance — render the same card, bespoke label included.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
});

const HANDOFF = [
  "## Handoff from your predecessor (rotation)",
  "",
  "You are replacing orchestrator conversation conv-A for project demo.",
  "",
  "No open board tasks are recorded for this project.",
].join("\n");

const ROW_TS = "2026-08-25T09:00:00.000Z";
const DELIVERED_AT = "2026-08-25T08:59:58.000Z";

const mandateRow = (text: string): Item =>
  ({ kind: "user", ts: ROW_TS, text }) as unknown as Item;

/** The row's own delivery, as the server projected it for this transcript. */
function deliveredAs(text: string, provenance: DeliveredMessageProvenance) {
  return { occurrences: [{ textDigest: messageTextDigest(text), deliveredAt: DELIVERED_AT, ...provenance }] };
}

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(node));
  return container as unknown as HTMLElement;
}

/** One row, resolved through the real occurrence join the panes both use. */
function renderRow(text: string, provenance: DeliveredMessageProvenance | null): HTMLElement {
  const item = mandateRow(text);
  const lookup = provenanceLookupFor(provenance ? deliveredAs(text, provenance) : {}, [item]);
  return render(
    <MessageProvenanceProvider value={lookup}>
      <FeedItem item={item} />
    </MessageProvenanceProvider>,
  );
}

function expand(container: HTMLElement, index: number): void {
  const details = container.querySelectorAll("details")[index]!;
  (details as unknown as { open: boolean }).open = true;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}

test("the delivered mandate renders as a card in place of the operator's bubble", () => {
  const text = ORCHESTRATOR_SYSTEM_PROMPT;
  const container = renderRow(text, { origin: "agent", mandate: { version: 9 } });

  expect(container.querySelector("[data-mandate-card]")).not.toBeNull();
  /* The user bubble's own surface is gone: this is not the operator talking. */
  expect(container.innerHTML).not.toContain("bg-user");
  /* And the 180-character teaser with a character count is gone with it. */
  expect(container.textContent).not.toContain(`${text.length} chars`);

  const header = container.querySelector("[data-mandate-card]")!.textContent ?? "";
  expect(header).toContain("Mandate v9");
  expect(header).toContain(`${text.split("\n").length} lines`);
  expect(header).toContain("sent at seat creation");
});

test("the card holds the mandate back until it is expanded", () => {
  const container = renderRow(ORCHESTRATOR_SYSTEM_PROMPT, { origin: "agent", mandate: { version: 9 } });

  expect(container.textContent).not.toContain("You are the viewer's built-in Manager");
  expand(container, 0);
  expect(container.textContent).toContain("You are the viewer's built-in Manager");
});

test("a rotation handoff opens as a second section of the same card", () => {
  const container = renderRow(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${HANDOFF}`, { origin: "agent", mandate: { version: 9 } });

  expect(container.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(container.querySelectorAll("details")).toHaveLength(2);
  expect(container.textContent).toContain("Rotation handoff");

  expect(container.textContent).not.toContain("You are replacing orchestrator conversation");
  expand(container, 1);
  expect(container.textContent).toContain("You are replacing orchestrator conversation");
  /* The handoff is its own section: opening it does not unfold the mandate. */
  expect(container.textContent).not.toContain("You are the viewer's built-in Manager");
});

test("a bespoke mandate reads as custom, on the board's conversation pane as in the dock", () => {
  /* The pane behind the dock mounts the same feed with the same evidence, and
     the seat's own record of a bespoke mandate travels with the delivery. */
  const container = renderRow("You run the conveyor here. Ship issue #7 first.", { origin: "agent", mandate: { version: null } });
  const header = container.querySelector("[data-mandate-card]")!.textContent ?? "";
  expect(header).toContain("Mandate custom");
});

test("an ordinary operator message keeps its bubble, and so does a paste of the mandate itself", () => {
  const ordinary = renderRow("rerun the failing check and paste the output", null);
  expect(ordinary.querySelector("[data-mandate-card]")).toBeNull();
  expect(ordinary.innerHTML).toContain("bg-user");

  flushSync(() => root!.unmount());
  root = null;
  /* Same bytes as a mandate, delivered by the operator: still their message. */
  const pasted = renderRow(ORCHESTRATOR_SYSTEM_PROMPT, { origin: "operator" });
  expect(pasted.querySelector("[data-mandate-card]")).toBeNull();
  expect(pasted.innerHTML).toContain("bg-user");
});
