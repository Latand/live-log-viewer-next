import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "@/lib/orchestrator/prompt";

import { FeedItem } from "./FeedItem";
import { MandateSeatProvider } from "./mandateSeat";
import type { Item } from "./parse";

/**
 * #1166 end to end through the renderer: the delivered mandate stops posing as
 * the operator's own 8 KB bubble and becomes a card that names what it is and
 * opens on demand — in the orchestrator dock (a seat in scope) and in the
 * board's conversation pane (none), through the same `FeedItem` seam.
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

const delivered = (mandate: string): string =>
  mandate.includes(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)
    ? mandate
    : `${mandate}\n\n${ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE}`;

const mandateRow = (text: string): Item =>
  ({ kind: "user", ts: "2026-08-25T09:00:00.000Z", text }) as unknown as Item;

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(node));
  return container as unknown as HTMLElement;
}

function expand(container: HTMLElement, index: number): void {
  const details = container.querySelectorAll("details")[index]!;
  (details as unknown as { open: boolean }).open = true;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}

test("the delivered mandate renders as a card in place of the operator's bubble", () => {
  const text = delivered(ORCHESTRATOR_SYSTEM_PROMPT);
  const container = render(
    <MandateSeatProvider value={{ promptVersion: ORCHESTRATOR_PROMPT_VERSION }}>
      <FeedItem item={mandateRow(text)} />
    </MandateSeatProvider>,
  );

  expect(container.querySelector("[data-mandate-card]")).not.toBeNull();
  /* The user bubble's own surface is gone: this is not the operator talking. */
  expect(container.innerHTML).not.toContain("bg-user");
  /* And the 180-character teaser with a character count is gone with it. */
  expect(container.textContent).not.toContain(`${text.length} chars`);

  const header = container.querySelector("[data-mandate-card]")!.textContent ?? "";
  expect(header).toContain(`Mandate v${ORCHESTRATOR_PROMPT_VERSION}`);
  expect(header).toContain(`${text.split("\n").length} lines`);
  expect(header).toContain("sent at seat creation");
});

test("the card holds the mandate back until it is expanded", () => {
  const text = delivered(ORCHESTRATOR_SYSTEM_PROMPT);
  const container = render(
    <MandateSeatProvider value={{ promptVersion: ORCHESTRATOR_PROMPT_VERSION }}>
      <FeedItem item={mandateRow(text)} />
    </MandateSeatProvider>,
  );

  expect(container.textContent).not.toContain("You are the viewer's built-in Manager");
  expand(container, 0);
  expect(container.textContent).toContain("You are the viewer's built-in Manager");
});

test("a rotation handoff opens as a second section of the same card", () => {
  const text = delivered(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${HANDOFF}`);
  const container = render(
    <MandateSeatProvider value={{ promptVersion: ORCHESTRATOR_PROMPT_VERSION }}>
      <FeedItem item={mandateRow(text)} />
    </MandateSeatProvider>,
  );

  const cards = container.querySelectorAll("[data-mandate-card]");
  expect(cards).toHaveLength(1);
  const sections = container.querySelectorAll("details");
  expect(sections).toHaveLength(2);
  expect(container.textContent).toContain("Rotation handoff");

  expect(container.textContent).not.toContain("You are replacing orchestrator conversation");
  expand(container, 1);
  expect(container.textContent).toContain("You are replacing orchestrator conversation");
  /* The handoff is its own section: opening it does not unfold the mandate. */
  expect(container.textContent).not.toContain("You are the viewer's built-in Manager");
});

test("a bespoke mandate reads as custom on a seat that recorded no version", () => {
  const container = render(
    <MandateSeatProvider value={{ promptVersion: null }}>
      <FeedItem item={mandateRow(delivered("You run the conveyor here. Ship issue #7 first."))} />
    </MandateSeatProvider>,
  );
  const header = container.querySelector("[data-mandate-card]")!.textContent ?? "";
  expect(header).toContain("Mandate custom");
});

test("the board's conversation pane renders the same card without inventing a version", () => {
  /* No seat provider — exactly how the pane behind the dock mounts the feed. */
  const container = render(<FeedItem item={mandateRow(delivered("Ship issue #7 first."))} />);
  expect(container.querySelector("[data-mandate-card]")).not.toBeNull();
  const header = container.querySelector("[data-mandate-card]")!.textContent ?? "";
  expect(header).toContain("Mandate");
  expect(header).not.toContain("custom");
  expect(header).not.toMatch(/\bv\d/);
});

test("an ordinary operator message keeps its bubble", () => {
  const container = render(<FeedItem item={mandateRow("rerun the failing check and paste the output")} />);
  expect(container.querySelector("[data-mandate-card]")).toBeNull();
  expect(container.innerHTML).toContain("bg-user");
});
