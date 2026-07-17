import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { Flow } from "@/lib/flows/types";
import { setLocale } from "@/lib/i18n";

const dom = new Window({ url: "http://viewer.local/" });
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

const { RoundDeck, reviewDeckCollapseKey } = await import("./RoundDeck");

afterEach(() => {
  setLocale("en");
  dom.localStorage.clear();
  dom.document.body.replaceChildren();
});

const flow = {
  id: "flow-three-rounds",
  reviewerMode: "pane",
} as Flow;

const rounds = [1, 2, 3].map((n) => ({
  key: `round-${n}`,
  file: null,
  round: {
    n,
    reviewerPath: null,
    reviewerConversationId: null,
    findingsPath: null,
    triggeredBy: "button" as const,
    readyNote: null,
    verdict: n === 3 ? "APPROVE" as const : "REQUEST_CHANGES" as const,
    findingsCount: 0,
    startedAt: "2026-07-17T00:00:00.000Z",
    reviewedAt: "2026-07-17T00:01:00.000Z",
    terminalAt: "2026-07-17T00:01:00.000Z",
    relayedAt: null,
    error: null,
  },
}));

function mount() {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<RoundDeck flow={flow} rounds={rounds} focusRound={null} />));
  return { host, root };
}

test("a three-round review deck collapses to one persisted summary and expands again", async () => {
  setLocale("uk");
  const first = mount();
  const collapse = first.host.querySelector("[data-review-deck-collapse]") as unknown as HTMLButtonElement;
  expect(collapse.getAttribute("aria-label")).toBe("Згорнути стек ревʼю (3 раундів)");

  flushSync(() => collapse.click());
  expect(first.host.querySelector("[data-review-deck-collapsed]")?.textContent).toContain("3 раунди");
  expect(dom.localStorage.getItem(reviewDeckCollapseKey(flow.id))).toBe("1");
  flushSync(() => first.root.unmount());

  const second = mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(second.host.querySelector("[data-review-deck-collapsed]")).not.toBeNull();
  const expand = second.host.querySelector("[data-review-deck-collapsed]") as unknown as HTMLButtonElement;
  flushSync(() => expand.click());
  expect(second.host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  expect(dom.localStorage.getItem(reviewDeckCollapseKey(flow.id))).toBeNull();
  flushSync(() => second.root.unmount());
});
