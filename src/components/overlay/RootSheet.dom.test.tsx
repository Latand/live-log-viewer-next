import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { digestChips } from "@/lib/overlay/digest";
import { sheetHeights, type SheetSnap } from "@/lib/overlay/layout";
import type { OverlayTurn } from "@/lib/overlay/timeline";
import { translate } from "@/lib/i18n";

import { RootSheet, type RootSheetProps } from "./RootSheet";

/*
 * #691 — the mobile rendering. What is happening in the Viewer above must stay
 * visible, so this is a controllable cover over live work rather than a chat
 * app that hides it.
 */

const USABLE = 844 - 34;

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

const t = ((key: string, vars?: Record<string, string | number>) => translate("en", key as "overlay.title", vars)) as RootSheetProps["t"];

const turns: OverlayTurn[] = [
  { id: "t1", role: "user", text: "How is it going?", at: "2026-07-01T10:00:00.000Z" },
  { id: "t2", role: "agent", text: "The reviewer finished with request-changes.", at: "2026-07-01T10:00:10.000Z" },
];

function mount(snap: SheetSnap, props: Partial<RootSheetProps> = {}): SheetSnap[] {
  const moves: SheetSnap[] = [];
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <RootSheet
      snap={snap}
      usableHeight={USABLE}
      onSnapChange={(next) => moves.push(next)}
      state="idle"
      turns={turns}
      onAcceptAttention={() => {}}
      onPreviewAttention={() => {}}
      onDeclineAttention={() => {}}
      onDismissAttention={() => {}}
      onReturnAttention={() => {}}
      t={t}
      {...props}
    />,
  ));
  roots.push(root);
  return moves;
}

const one = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const all = (selector: string) => [...dom.document.querySelectorAll(selector)] as unknown as HTMLElement[];
const click = (element: HTMLElement) => element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);

function pointer(kind: string, clientY: number): Event {
  const event = new dom.Event(kind, { bubbles: true }) as unknown as Event & { clientY: number; pointerId: number };
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

/**
 * A pointer sequence as a browser actually emits it: pointerdown, pointerup,
 * and — because both landed on the same element — the click that follows. The
 * bug this pins is exactly the one a pointerdown/pointerup-only helper cannot
 * see, since happy-dom never synthesizes that trailing click by itself.
 */
function drag(element: HTMLElement, from: number, to: number): void {
  element.dispatchEvent(pointer("pointerdown", from));
  element.dispatchEvent(pointer("pointerup", to));
  click(element);
}

/** A tap is the same sequence with the finger staying put. */
const tap = (element: HTMLElement, at = 100) => drag(element, at, at);

test("each snap renders its own height and leaves the Viewer the rest", () => {
  const heights = sheetHeights(USABLE);

  for (const snap of ["rail", "half", "full"] as const) {
    mount(snap);
    const sheet = one("[data-testid='root-sheet']")!;
    expect(sheet.style.height).toBe(`${heights[snap]}px`);
    /* Even Full leaves a peek — it is the return affordance, and it is why the
       Viewer never fully vanishes. */
    expect(heights[snap]).toBeLessThan(USABLE);
    flushSync(() => roots.at(-1)!.unmount());
    roots.pop();
    dom.document.body.replaceChildren();
  }
});

test("Rail is one truncated line, and a digest becomes a counter rather than height", () => {
  mount("rail", {
    chips: digestChips([
      { eventId: "e1", kind: "stage-started", summary: "Stage started.", at: "2026-07-01T10:00:05.000Z" },
      { eventId: "e2", kind: "review-verdict", summary: "Review: request-changes.", at: "2026-07-01T10:00:15.000Z" },
    ]),
  });

  expect(one("[data-testid='root-overlay']")!.getAttribute("data-density")).toBe("rail");
  expect(all("[data-testid='overlay-turn']")).toHaveLength(1);
  expect(all("[data-testid='overlay-turn']")[0]!.getAttribute("data-clamp")).toBe("1");
  /* At Rail a digest never expands the sheet. */
  expect(one("[data-testid='overlay-chip-counter']")!.textContent).toBe("+2 updates");
  expect(all("[data-testid='overlay-chip']")).toHaveLength(0);
});

test("tapping the state row toggles Rail and Half", () => {
  const fromRail = mount("rail");
  tap(one("[data-testid='sheet-grabber']")!);
  expect(fromRail).toEqual(["half"]);
  /* The moves array belongs to the most recent mount. */
  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  dom.document.body.replaceChildren();

  const fromHalf = mount("half");
  tap(one("[data-testid='sheet-grabber']")!);
  expect(fromHalf).toEqual(["rail"]);
});

test("a drag never jumps two snaps", () => {
  const moves = mount("full");

  drag(one("[data-testid='sheet-grabber']")!, 100, 400);

  /* A long drag from Full still stops at Half; two-snap moves come only from an
     explicit control. */
  expect(moves).toEqual(["half"]);
});

test("the click a drag leaves behind does not toggle the sheet back", () => {
  const moves = mount("half");

  /* The grabber is one target for two gestures, and a browser reports a drag as
     pointerdown, pointerup AND a click. Applying both would take an upward drag
     from Half to Full and then collapse it to Rail in the same gesture. */
  drag(one("[data-testid='sheet-grabber']")!, 400, 100);

  expect(moves).toEqual(["full"]);
});

test("a movement below the threshold stays a tap rather than becoming a snap of its own", () => {
  const moves = mount("half");

  drag(one("[data-testid='sheet-grabber']")!, 100, 110);

  /* Ten pixels is a finger that did not mean to drag; the browser still calls
     it a click, and it reads as the tap it was — once. */
  expect(moves).toEqual(["rail"]);
});

test("a gesture the browser takes away moves nothing and leaves no origin behind", () => {
  const moves = mount("half");
  const grabber = one("[data-testid='sheet-grabber']")!;

  grabber.dispatchEvent(pointer("pointerdown", 400));
  grabber.dispatchEvent(pointer("pointercancel", 400));
  /* A pointerup arriving after the cancel has no live drag to be measured
     against, so it cannot move the sheet on a stale origin. */
  grabber.dispatchEvent(pointer("pointerup", 100));
  expect(moves).toEqual([]);

  /* And the control is not left wedged: the next tap still works. */
  tap(grabber);
  expect(moves).toEqual(["rail"]);
});

test("the snap state is announced as a named state, not a percentage", () => {
  mount("half");

  const label = one("[data-testid='sheet-grabber']")!.getAttribute("aria-label")!;
  expect(label).toBe("Conversation sheet height: Half height");
  expect(label).not.toContain("%");
});

test("an attention request is answerable at full mobile control size", () => {
  const created = new Date("2026-07-01T10:00:00.000Z");
  mount("half", {
    attention: {
      request: {
        id: "attention_1",
        createdAt: created.toISOString(),
        requestedBy: { rootId: "root_fixed" },
        origin: "root-agent",
        target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
        frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
        intent: "show",
        zoom: "situate",
        reason: "The reviewer finished with request-changes.",
        state: "offered",
        stateChangedAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + 600_000).toISOString(),
        offeredTo: ["device-a"],
        returnPoints: [],
        revision: 1,
      },
      status: "actionable",
      returnAvailable: false,
    },
  });

  /* Accept and decline are full-size controls in the mobile action row. */
  for (const testId of ["attention-accept", "attention-preview", "attention-decline"]) {
    expect(one(`[data-testid='${testId}']`)!.style.minHeight).toBe("48px");
  }
});
