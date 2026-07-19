import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { Flow, ReviewVerdict } from "@/lib/flows/types";
import { setLocale } from "@/lib/i18n";

/*
 * Deck disclosure (#289 + #325): the deck auto-collapses to a clickable
 * verdict chip the moment the final verdict lands, a manual expand of the
 * ACTIVE deck is invalidated by that verdict, a manual expand of the TERMINAL
 * group is durable, and the expanded form shows every round with no nested
 * scroll container. Reduced motion / no matchMedia swaps instantly.
 */

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
const { deckDisclosureMarker, writeDeckDisclosureOverride } = await import("./reviewDeckDisclosure");

/* Most tests pin prefers-reduced-motion so disclosure swaps are instant and
   deterministic; the suck-in phase is exercised explicitly by the motion test. */
const windowLike = dom as unknown as { matchMedia?: (query: string) => { matches: boolean } };
const setMotion = (reduced: boolean) => {
  windowLike.matchMedia = () => ({ matches: reduced });
};
setMotion(true);

afterEach(() => {
  setLocale("en");
  dom.localStorage.clear();
  dom.document.body.replaceChildren();
  setMotion(true);
});

function makeRound(n: number, verdict: ReviewVerdict | null, error: string | null = null) {
  return {
    key: `round-${n}`,
    file: null,
    round: {
      n,
      reviewerPath: `/reviewer-${n}`,
      reviewerConversationId: `conversation-r${n}`,
      findingsPath: null,
      triggeredBy: "button" as const,
      readyNote: null,
      verdict,
      findingsCount: verdict ? 0 : null,
      startedAt: "2026-07-17T00:00:00.000Z",
      reviewedAt: verdict ? "2026-07-17T00:01:00.000Z" : null,
      terminalAt: verdict ? "2026-07-17T00:01:00.000Z" : null,
      relayedAt: null,
      error,
    },
  };
}

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function makeFlow(rounds: ReturnType<typeof makeRound>[], state: Flow["state"]): Flow {
  return {
    id: "direct-review::subject::conversation-builder",
    reviewerMode: "pane",
    state,
    roles: { implementer: roleConfig, reviewer: roleConfig },
    rounds: rounds.map((item) => item.round),
  } as Flow;
}

function mount(flow: Flow, rounds: ReturnType<typeof makeRound>[]) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const render = (nextFlow: Flow, nextRounds: ReturnType<typeof makeRound>[]) =>
    flushSync(() => root.render(<RoundDeck flow={nextFlow} rounds={nextRounds} focusRound={null} groupLabel="Builder session" />));
  render(flow, rounds);
  return { host, root, render };
}

/* Long enough for React to flush passive effects (the disclosure swap runs in
   one) plus the follow-up render; far below the 320ms animation window. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test("verdict arrival auto-collapses the deck to a clickable chip; a click expands every round with no inner scroll", async () => {
  const active = [makeRound(1, "REQUEST_CHANGES"), makeRound(2, null)];
  const { host, root, render } = mount(makeFlow(active, "reviewing"), active);
  await settle();
  /* Actionable group: expanded by default, fold control announces state. */
  const collapse = host.querySelector("[data-review-deck-collapse]")!;
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[data-review-deck-collapsed]")).toBeNull();
  const group = host.querySelector('[role="group"]')!;
  expect(group.getAttribute("aria-label")).toBe("Review group for Builder session · 2 rounds");

  /* The verdict lands on round 2 → the group turns terminal on the same
     render and collapses immediately with NO stored override. */
  const done = [makeRound(1, "REQUEST_CHANGES"), makeRound(2, "APPROVE")];
  render(makeFlow(done, "done_comment"), done);
  await settle();
  const chip = host.querySelector("[data-review-deck-collapsed]")!;
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(chip.textContent).toContain("2 rounds");
  expect(chip.textContent).toContain("APPROVE");
  expect(chip.textContent).toContain("Claude");

  /* One click restores the full deck in place: front card plus every prior
     round as a spine — and no scrollable container anywhere in the subtree. */
  flushSync(() => (chip as unknown as HTMLButtonElement).click());
  await settle();
  expect(host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  const spine = host.querySelector('button[title="Round 1 · ✖ REQUEST_CHANGES"]');
  expect(spine).not.toBeNull();
  const scrollable = [...host.querySelectorAll("*")].filter((el) => {
    const style = (el as unknown as HTMLElement).style;
    return style?.overflow === "auto" || style?.overflow === "scroll" || style?.overflowY === "auto" || style?.overflowY === "scroll";
  });
  expect(scrollable).toHaveLength(0);
  expect([...host.querySelectorAll("*")].some((el) => el.className?.toString?.().includes("overflow-y-auto"))).toBe(false);
  flushSync(() => root.unmount());
});

test("a mid-round manual expand is invalidated by the verdict (stale override auto-collapses)", async () => {
  const activeRounds = [makeRound(1, null)];
  const activeFlow = makeFlow(activeRounds, "reviewing");
  /* The user collapsed, then re-expanded the ACTIVE deck: an expanded
     override recorded under the open-round marker. */
  writeDeckDisclosureOverride(dom.localStorage, activeFlow.id, "expanded", deckDisclosureMarker(activeFlow));
  const { host, root, render } = mount(activeFlow, activeRounds);
  await settle();
  expect(host.querySelector("[data-review-deck-collapsed]")).toBeNull();

  /* The verdict changes the marker → the override is stale → auto-collapse
     wins ("collapse immediately after the final verdict"). */
  const doneRounds = [makeRound(1, "APPROVE")];
  render(makeFlow(doneRounds, "done_comment"), doneRounds);
  await settle();
  expect(host.querySelector("[data-review-deck-collapsed]")).not.toBeNull();
  flushSync(() => root.unmount());
});

test("a manual expand of the TERMINAL group is durable across remounts until a new round starts", async () => {
  const doneRounds = [makeRound(1, "APPROVE")];
  const doneFlow = makeFlow(doneRounds, "done_comment");
  const first = mount(doneFlow, doneRounds);
  await settle();
  const chip = first.host.querySelector("[data-review-deck-collapsed]") as unknown as HTMLButtonElement;
  flushSync(() => chip.click());
  await settle();
  expect(first.host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  const stored = JSON.parse(dom.localStorage.getItem(reviewDeckCollapseKey(doneFlow.id))!) as { v: string; at: string };
  expect(stored.v).toBe("expanded");
  expect(stored.at).toBe(deckDisclosureMarker(doneFlow));
  flushSync(() => first.root.unmount());

  /* Reload: the expanded override survives for the SAME terminal state. */
  const second = mount(doneFlow, doneRounds);
  await settle();
  expect(second.host.querySelector("[data-review-deck-collapsed]")).toBeNull();

  /* A fresh round invalidates it in the auto-expand direction too — live
     work surfaces regardless of any stored disclosure. */
  const retry = [makeRound(1, "APPROVE"), makeRound(2, null)];
  second.render(makeFlow(retry, "reviewing"), retry);
  await settle();
  expect(second.host.querySelector("[data-review-deck-collapsed]")).toBeNull();
  expect(second.host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  flushSync(() => second.root.unmount());
});

test("a legacy '1' collapse pin still reads as collapsed and expanding rewrites it as JSON", async () => {
  const rounds = [makeRound(1, null)];
  const flow = makeFlow(rounds, "reviewing");
  dom.localStorage.setItem(reviewDeckCollapseKey(flow.id), "1");
  const { host, root } = mount(flow, rounds);
  await settle();
  const chip = host.querySelector("[data-review-deck-collapsed]") as unknown as HTMLButtonElement;
  expect(chip).not.toBeNull();
  flushSync(() => chip.click());
  await settle();
  expect(host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  const stored = JSON.parse(dom.localStorage.getItem(reviewDeckCollapseKey(flow.id))!) as { v: string };
  expect(stored.v).toBe("expanded");
  flushSync(() => root.unmount());
});

test("with motion allowed the collapse plays the two-phase suck-in before the chip commits", async () => {
  setMotion(false);
  const active = [makeRound(1, null)];
  const { host, root, render } = mount(makeFlow(active, "reviewing"), active);
  await settle();
  const done = [makeRound(1, "APPROVE")];
  render(makeFlow(done, "done_comment"), done);
  await settle();
  /* Phase 1: the deck is still mounted, sucking in. */
  expect(host.querySelector(".deck-collapsing")).not.toBeNull();
  expect(host.querySelector("[data-review-deck-collapsed]")).toBeNull();
  /* Phase 2 commits after the animation window. */
  await new Promise((resolve) => setTimeout(resolve, 360));
  flushSync(() => {});
  expect(host.querySelector("[data-review-deck-collapsed]")).not.toBeNull();
  flushSync(() => root.unmount());
});

test("reduced motion swaps instantly with no animation phase", async () => {
  setMotion(true);
  const active = [makeRound(1, null)];
  const { host, root, render } = mount(makeFlow(active, "reviewing"), active);
  await settle();
  const done = [makeRound(1, "APPROVE")];
  render(makeFlow(done, "done_comment"), done);
  await settle();
  flushSync(() => {});
  expect(host.querySelector(".deck-collapsing")).toBeNull();
  expect(host.querySelector("[data-review-deck-collapsed]")).not.toBeNull();
  flushSync(() => root.unmount());
});

test("both locales render the disclosure labels", async () => {
  setLocale("uk");
  const done = [makeRound(1, "APPROVE"), makeRound(2, "APPROVE"), makeRound(3, "APPROVE")];
  const { host, root } = mount(makeFlow(done, "done_comment"), done);
  await settle();
  const chip = host.querySelector("[data-review-deck-collapsed]")!;
  expect(chip.getAttribute("aria-label")).toBe("Розгорнути стек ревʼю (3 раундів)");
  expect(chip.textContent).toContain("3 раунди");
  flushSync(() => (chip as unknown as HTMLButtonElement).click());
  await settle();
  const collapse = host.querySelector("[data-review-deck-collapse]")!;
  expect(collapse.getAttribute("aria-label")).toBe("Згорнути стек ревʼю (3 раундів)");
  expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Група ревʼю для Builder session · 3 раунди");
  flushSync(() => root.unmount());
});
