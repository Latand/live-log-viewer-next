import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";

import { clampPercent, meterTone, MobileMeter } from "./MobileMeter";
import { createReceiptStore, MobileReceipt, RECEIPT_MS, type ReceiptInverse, type ReceiptTimers } from "./MobileReceipt";

/*
 * Receipts (mobile v2 §2 rule 9, §5): four seconds in flow, the inverse action
 * as a 44 px text button, a newer receipt replacing the one showing. Meters
 * (§5): the fill is what remains, coloured by what remains.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
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
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; });

function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return host as unknown as HTMLElement;
}

/** A clock the test turns by hand. */
function clock() {
  const scheduled: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const timers: ReceiptTimers = {
    set: (callback, ms) => { scheduled.push({ callback, ms, cleared: false }); return scheduled.length; },
    clear: (handle) => { const entry = scheduled[(handle as number) - 1]; if (entry) entry.cleared = true; },
  };
  return { timers, scheduled, fire: (handle: number) => { const entry = scheduled[handle - 1]!; if (!entry.cleared) entry.callback(); } };
}

const receipt = (host: HTMLElement) => host.querySelector("[data-mobile2-receipt]") as unknown as HTMLElement | null;
const undoButton = (host: HTMLElement) => host.querySelector("[data-mobile2-receipt-undo]") as unknown as HTMLButtonElement | null;

test("a receipt shows in flow for four seconds and then leaves on its own", () => {
  const { timers, scheduled, fire } = clock();
  const store = createReceiptStore(timers);
  const host = mount(<MobileReceipt store={store} />);
  expect(receipt(host)).toBeNull();
  flushSync(() => { store.show("Archived — the project list keeps it under Archive"); });
  expect(receipt(host)!.textContent).toContain("Archived");
  expect(receipt(host)!.getAttribute("role")).toBe("status");
  expect(receipt(host)!.getAttribute("data-mobile2-receipt-placement")).toBe("flow");
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.ms).toBe(RECEIPT_MS);
  expect(RECEIPT_MS).toBe(4_000);
  flushSync(() => fire(1));
  expect(receipt(host)).toBeNull();
});

test("the inverse action runs on tap, takes the receipt down and cancels its clock", () => {
  const { timers, scheduled, fire } = clock();
  const store = createReceiptStore(timers);
  let restored = 0;
  const host = mount(<MobileReceipt store={store} />);
  flushSync(() => { store.show("Archived", { kind: "restore", run: () => { restored += 1; } }); });
  const undo = undoButton(host)!;
  expect(undo.textContent).toBe(translate("en", "mobile2.receipt.restore"));
  expect(undo.className).toContain("min-h-11");
  expect(undo.className).toContain("min-w-11");
  flushSync(() => undo.click());
  expect(restored).toBe(1);
  expect(receipt(host)).toBeNull();
  expect(scheduled[0]!.cleared).toBe(true);
  /* A late clock does nothing. */
  flushSync(() => fire(1));
  expect(receipt(host)).toBeNull();
});

test("a newer receipt replaces the one showing and restarts the clock; the stale clock is inert", () => {
  const { timers, scheduled, fire } = clock();
  const store = createReceiptStore(timers);
  const host = mount(<MobileReceipt store={store} />);
  flushSync(() => { store.show("Killed", { kind: "respawn", run: () => {} }); });
  flushSync(() => { store.show("Closed", { kind: "reopen", run: () => {} }); });
  expect(receipt(host)!.textContent).toContain("Closed");
  expect(undoButton(host)!.textContent).toBe(translate("en", "mobile2.receipt.reopen"));
  expect(scheduled[0]!.cleared).toBe(true);
  flushSync(() => fire(1));
  expect(receipt(host)!.textContent).toContain("Closed");
  flushSync(() => fire(2));
  expect(receipt(host)).toBeNull();
});

test("every inverse the design names has its label, in both locales", () => {
  const kinds: ReceiptInverse[] = ["respawn", "reopen", "restore", "switchBack", "retryStage"];
  expect(kinds.map((kind) => translate("en", `mobile2.receipt.${kind}`))).toEqual(["Respawn", "Reopen", "Restore", "Switch back", "Retry stage"]);
  for (const kind of kinds) expect(translate("uk", `mobile2.receipt.${kind}`).length).toBeGreaterThan(0);
});

test("a receipt without an inverse carries no button", () => {
  const { timers } = clock();
  const store = createReceiptStore(timers);
  const host = mount(<MobileReceipt store={store} placement="sheet" />);
  flushSync(() => { store.show("Limits re-read"); });
  expect(receipt(host)!.getAttribute("data-mobile2-receipt-placement")).toBe("sheet");
  expect(undoButton(host)).toBeNull();
});

test("the meter fills with what remains and colours by what remains", () => {
  const fill = (host: HTMLElement) => host.querySelector("[data-mobile2-meter-fill]") as unknown as HTMLElement;
  const meter = (host: HTMLElement) => host.querySelector("[data-mobile2-meter]") as unknown as HTMLElement;
  const at76 = mount(<MobileMeter left={76} label="context" />);
  expect(fill(at76).style.width).toBe("76%");
  expect(fill(at76).className).toContain("bg-accent");
  expect(meter(at76).getAttribute("data-mobile2-meter-tone")).toBe("accent");
  expect(meter(at76).getAttribute("aria-valuenow")).toBe("76");
  expect(meter(at76).getAttribute("aria-label")).toBe("context");
  const at30 = mount(<MobileMeter left={30} />);
  expect(fill(at30).style.width).toBe("30%");
  expect(fill(at30).className).toContain("bg-warning");
  const at10 = mount(<MobileMeter left={10} />);
  expect(fill(at10).className).toContain("bg-danger");
  expect(meterTone(31)).toBe("accent");
  expect(meterTone(30)).toBe("warning");
  expect(meterTone(11)).toBe("warning");
  expect(meterTone(10)).toBe("danger");
  expect(meterTone(0)).toBe("danger");
  expect(clampPercent(140)).toBe(100);
  expect(clampPercent(-5)).toBe(0);
  expect(clampPercent(Number.NaN)).toBe(0);
  expect(clampPercent(33.6)).toBe(34);
});
