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

function drag(element: HTMLElement, from: number, to: number): void {
  const down = new dom.Event("pointerdown", { bubbles: true }) as unknown as Event & { clientY: number };
  Object.defineProperty(down, "clientY", { value: from });
  element.dispatchEvent(down);
  const up = new dom.Event("pointerup", { bubbles: true }) as unknown as Event & { clientY: number };
  Object.defineProperty(up, "clientY", { value: to });
  element.dispatchEvent(up);
}

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
  expect(mount("rail").length).toBe(0);
  click(one("[data-testid='sheet-grabber']")!);
  /* The moves array belongs to the most recent mount. */
  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  dom.document.body.replaceChildren();

  const fromHalf = mount("half");
  click(one("[data-testid='sheet-grabber']")!);
  expect(fromHalf).toEqual(["rail"]);
});

test("a drag never jumps two snaps", () => {
  const moves = mount("full");

  drag(one("[data-testid='sheet-grabber']")!, 100, 400);

  /* A long drag from Full still stops at Half; two-snap moves come only from an
     explicit control. */
  expect(moves).toEqual(["half"]);
});

test("a drag shorter than the threshold is a scroll, not a snap change", () => {
  const moves = mount("half");

  drag(one("[data-testid='sheet-grabber']")!, 100, 110);

  expect(moves).toEqual([]);
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
