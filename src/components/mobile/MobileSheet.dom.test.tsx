import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { createReceiptStore, type ReceiptTimers } from "./MobileReceipt";
import { MobileSheet, SHEET_CLOSE_DRAG_PX } from "./MobileSheet";

/*
 * The sheet primitive (mobile v2 §2 rule 1, §3.3, §5): a modal over the
 * current screen that closes on the scrim, the ×, Escape, or a drag of its
 * handle past 80 px; a shorter drag springs back. Its receipt slot sits
 * between the body and the footer.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
/* React schedules passive work on a later tick: let it run before the
   globals go, or it dereferences a window that is no longer there. */
afterAll(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; } });

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); dom.document.body.style.overflow = ""; roots = []; });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; dom.document.body.style.overflow = ""; });

function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const sheet = (host: HTMLElement) => host.querySelector('[data-mobile2-sheet="menu"]') as unknown as HTMLElement | null;
const pointer = (type: string, clientY: number) => new dom.PointerEvent(type, { bubbles: true, cancelable: true, clientY, pointerId: 1 } as never) as unknown as Event;

function open(): { host: HTMLElement; closes: () => number } {
  let closes = 0;
  const host = mount(
    <MobileSheet name="menu" title="atlas" onClose={() => { closes += 1; }}>
      <button type="button" data-testid="row">New agent</button>
    </MobileSheet>,
  );
  return { host, closes: () => closes };
}

test("a sheet is a modal dialog over the screen: it takes focus, locks the body, names itself", () => {
  const { host } = open();
  const dialog = sheet(host)!;
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-label")).toBe("atlas");
  expect(dialog.className).toContain("max-h-[88%]");
  expect(dom.document.body.style.overflow).toBe("hidden");
  expect(dom.document.activeElement).toBe(dialog as never);
  /* Its × is a 44 px target that carries the harness hook. */
  const close = host.querySelector("[data-mobile2-close]") as unknown as HTMLElement;
  expect(close.className).toContain("h-11");
  expect(close.className).toContain("w-11");
});

test("the × and the scrim close it; a tap inside does not", () => {
  const { host, closes } = open();
  flushSync(() => (host.querySelector('[data-testid="row"]') as unknown as HTMLElement).click());
  expect(closes()).toBe(0);
  flushSync(() => (host.querySelector("[data-mobile2-close]") as unknown as HTMLElement).click());
  expect(closes()).toBe(1);
  flushSync(() => (host.querySelector("[data-mobile2-scrim]") as unknown as HTMLElement).click());
  expect(closes()).toBe(2);
});

test("Escape closes it", () => {
  const { closes } = open();
  flushSync(() => {
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
  });
  expect(closes()).toBe(1);
});

test("a drag of the handle past 80 px closes; the sheet follows the finger on the way", () => {
  const { host, closes } = open();
  const grab = host.querySelector("[data-mobile2-grab]") as unknown as HTMLElement;
  const dialog = sheet(host)!;
  flushSync(() => grab.dispatchEvent(pointer("pointerdown", 500)));
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 560)));
  expect(dialog.style.transform).toBe("translateY(60px)");
  expect(dialog.style.transition).toBe("none");
  flushSync(() => grab.dispatchEvent(pointer("pointermove", 500 + SHEET_CLOSE_DRAG_PX + 21)));
  expect(dialog.style.transform).toBe(`translateY(${SHEET_CLOSE_DRAG_PX + 21}px)`);
  flushSync(() => grab.dispatchEvent(pointer("pointerup", 500 + SHEET_CLOSE_DRAG_PX + 21)));
  expect(closes()).toBe(1);
});

test("a shorter drag springs back over 200 ms and keeps the sheet open", () => {
  const { host, closes } = open();
  const header = host.querySelector("[data-mobile2-sheet-header]") as unknown as HTMLElement;
  const dialog = sheet(host)!;
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 300)));
  flushSync(() => header.dispatchEvent(pointer("pointermove", 340)));
  expect(dialog.style.transform).toBe("translateY(40px)");
  flushSync(() => header.dispatchEvent(pointer("pointerup", 340)));
  expect(closes()).toBe(0);
  expect(dialog.style.transform).toBe("");
  expect(dialog.style.transition).toContain("200ms");
  /* An upward pull never moves it. */
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 300)));
  flushSync(() => header.dispatchEvent(pointer("pointermove", 200)));
  expect(dialog.style.transform).toBe("translateY(0px)");
  flushSync(() => header.dispatchEvent(pointer("pointercancel", 200)));
  expect(closes()).toBe(0);
});

test("a pointer that lands on the × or another header control is that control's tap, never a drag: no capture, no follow", () => {
  /* happy-dom has no pointer capture; in Chromium a captured pointer's click
     is retargeted to the capturing element, which is how a captured header
     swallowed the ×. The contract under test: the sheet asks for capture only
     when the drag starts from the handle or the title, never from a control,
     and a control's own click still fires. */
  const captures: string[] = [];
  const proto = dom.HTMLElement.prototype as unknown as { setPointerCapture?: (this: HTMLElement, pointerId: number) => void };
  const original = proto.setPointerCapture;
  proto.setPointerCapture = function () {
    captures.push(this.hasAttribute("data-mobile2-sheet-header") ? "header" : this.hasAttribute("data-mobile2-grab") ? "grab" : this.tagName);
  };
  try {
    let nexts = 0;
    let closes = 0;
    const host = mount(
      <MobileSheet
        name="attention"
        title="Needs you · 3"
        onClose={() => { closes += 1; }}
        extra={<button type="button" data-testid="next" onClick={() => { nexts += 1; }}>Next</button>}
      >
        <div>rows</div>
      </MobileSheet>,
    );
    const dialog = host.querySelector('[data-mobile2-sheet="attention"]') as unknown as HTMLElement;
    const header = host.querySelector("[data-mobile2-sheet-header]") as unknown as HTMLElement;
    const close = host.querySelector("[data-mobile2-close]") as unknown as HTMLElement;
    const next = host.querySelector('[data-testid="next"]') as unknown as HTMLElement;
    for (const control of [close, next]) {
      flushSync(() => control.dispatchEvent(pointer("pointerdown", 300)));
      flushSync(() => header.dispatchEvent(pointer("pointermove", 360)));
      expect(dialog.style.transform).toBe("");
      flushSync(() => header.dispatchEvent(pointer("pointerup", 360)));
    }
    expect(captures).toEqual([]);
    expect(closes).toBe(0);
    flushSync(() => next.click());
    expect(nexts).toBe(1);
    flushSync(() => close.click());
    expect(closes).toBe(1);
    /* The title text and the handle still start one, and capture it. */
    const title = header.querySelector("h2") as unknown as HTMLElement;
    flushSync(() => title.dispatchEvent(pointer("pointerdown", 300)));
    flushSync(() => header.dispatchEvent(pointer("pointermove", 340)));
    expect(dialog.style.transform).toBe("translateY(40px)");
    flushSync(() => header.dispatchEvent(pointer("pointerup", 340)));
    const grab = host.querySelector("[data-mobile2-grab]") as unknown as HTMLElement;
    flushSync(() => grab.dispatchEvent(pointer("pointerdown", 300)));
    flushSync(() => grab.dispatchEvent(pointer("pointercancel", 300)));
    expect(captures).toEqual(["header", "grab"]);
    expect(closes).toBe(1);
  } finally {
    if (original) proto.setPointerCapture = original;
    else delete proto.setPointerCapture;
  }
});

test("the receipt slot inside a sheet sits between the body and the footer", () => {
  const timers: ReceiptTimers = { set: () => 1, clear: () => {} };
  const store = createReceiptStore(timers);
  const host = mount(
    <MobileSheet name="menu" title="atlas" onClose={() => {}} receiptStore={store} footer={<button type="button" data-testid="foot">Rotate</button>}>
      <div data-testid="body-row">row</div>
    </MobileSheet>,
  );
  expect(host.querySelector("[data-mobile2-receipt]")).toBeNull();
  flushSync(() => { store.show("Reset used"); });
  const receipt = host.querySelector('[data-mobile2-receipt-placement="sheet"]') as unknown as HTMLElement;
  expect(receipt).not.toBeNull();
  expect(sheet(host)!.contains(receipt as never)).toBe(true);
  const body = host.querySelector("[data-mobile2-sheet-body]") as unknown as HTMLElement;
  const foot = host.querySelector('[data-testid="foot"]') as unknown as HTMLElement;
  expect(body.compareDocumentPosition(receipt as never) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(receipt.compareDocumentPosition(foot as never) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a fullscreen sheet has no handle and never drags", () => {
  let closes = 0;
  const host = mount(
    <MobileSheet name="rotate" title="Replace the orchestrator" full onClose={() => { closes += 1; }}>
      <div>draft</div>
    </MobileSheet>,
  );
  expect(host.querySelector("[data-mobile2-grab]")).toBeNull();
  const dialog = host.querySelector('[data-mobile2-sheet="rotate"]') as unknown as HTMLElement;
  expect(dialog.className).toContain("h-full");
  const header = host.querySelector("[data-mobile2-sheet-header]") as unknown as HTMLElement;
  flushSync(() => header.dispatchEvent(pointer("pointerdown", 100)));
  flushSync(() => header.dispatchEvent(pointer("pointermove", 400)));
  flushSync(() => header.dispatchEvent(pointer("pointerup", 400)));
  expect(dialog.style.transform).toBe("");
  expect(closes).toBe(0);
});
