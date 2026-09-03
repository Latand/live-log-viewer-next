import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";
import { MOBILE_COMPOSER_CHROME_PX, MOBILE_COMPOSER_UNIT_CHROME_PX, mobileComposerUnitMax } from "@/lib/composerScroll";

import { ComposerBar } from "@/components/ComposerBar";

/*
 * Issue #983 — the phone grow ceiling must budget against the VISIBLE viewport.
 * iOS Safari ignores interactive-widget=resizes-content: with the on-screen
 * keyboard open, window.innerHeight keeps the full screen height and only
 * window.visualViewport reports the shrunken visible area. Sizing the field at
 * 40% of innerHeight then overflows the visible half-screen, pushing the model
 * picker and send/mic controls under the keyboard.
 *
 * Issue #1483 adds the second viewport the ceiling has to answer to. The
 * composer is ONE box — field on top, tools row under it — inside a form whose
 * own `max-h-[min(38dvh,20rem)]` scrolls what it cannot show, and `dvh` is the
 * LAYOUT viewport, which the keyboard never shrinks. A field sized only against
 * the visible area therefore still overflowed its own box while dictating with
 * the keyboard down: the tools row holding Stop went below the box's bottom
 * edge, reachable only by scrolling. So every height asserted here is checked
 * against both bounds, and the #983 numbers that assumed the retired chrome are
 * restated against the chrome the phone renders today.
 */

/* A minimal visualViewport stand-in — happy-dom does not provide one. Resize
   listeners are collected so a test can play the keyboard opening/closing. */
function makeVisualViewport(height: number) {
  const listeners = new Set<() => void>();
  return {
    height,
    scale: 1,
    offsetTop: 0,
    addEventListener(type: string, cb: () => void) { if (type === "resize") listeners.add(cb); },
    removeEventListener(type: string, cb: () => void) { if (type === "resize") listeners.delete(cb); },
    resizeTo(next: number) {
      this.height = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

const dom = new Window({ width: 390, height: 800 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
/* Phone layout: the width-based media query matches. */
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
/* Text always overflows: every measurement hits the grow ceiling exactly. */
const proto = dom.HTMLElement.prototype as unknown as Record<string, unknown>;
Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2000 });

const G = globalThis as { visualViewport?: unknown } & Record<string, unknown>;

/** Put the layout viewport on a real phone frame before mounting: the box
    budget is written in `dvh`, so the LAYOUT height is half the input. */
function layoutViewport(width: number, height: number): void {
  dom.happyDOM.setViewport({ width, height });
}

let roots: Root[] = [];
afterEach(() => {
  for (const r of roots) flushSync(() => r.unmount());
  roots = [];
  dom.document.body.replaceChildren();
  delete (dom as unknown as Record<string, unknown>).visualViewport;
  delete G.visualViewport;
  layoutViewport(390, 800);
});
afterAll(() => {
  delete (proto as { scrollHeight?: unknown }).scrollHeight;
});

function Harness() {
  const composer = useComposer({
    initialText: () => "line\n".repeat(40),
    persistText: () => {},
    submit: () => {},
  });
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add images"
      /* The model-picker stand-in: on the phone ComposerBar renders leftSlot as
         the first cell of the composer box's tools row — the control the
         operator lost, now inside the box (mobile v2 §2 rule 8). */
      leftSlot={<button type="button">model picker</button>}
      sendLabelIdle="Send"
      sendLabelRecording="Stop"
      sendIdleClassName="bg-accent"
    />
  );
}

function mountComposer(): HTMLTextAreaElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Harness />));
  return host.querySelector("textarea") as unknown as HTMLTextAreaElement;
}

function openKeyboard(visible: number) {
  const vv = makeVisualViewport(visible);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  return vv;
}

/** The two bounds a rendered field height has to clear at once (#1483): its
    own box, and the visible area under the bar. */
function expectToolsRowReachable(textarea: HTMLTextAreaElement, visible: number, layout: number): void {
  const field = Number.parseInt(textarea.style.height, 10);
  expect(field + MOBILE_COMPOSER_UNIT_CHROME_PX).toBeLessThanOrEqual(mobileComposerUnitMax(layout));
  expect(field + MOBILE_COMPOSER_CHROME_PX).toBeLessThanOrEqual(visible);
  /* The row itself is rendered, at its 44px contract, with the picker in it. */
  const row = dom.document.querySelector("[data-mobile2-tools]") as unknown as HTMLElement;
  expect(row).not.toBeNull();
  expect(row.className).toContain("min-h-11");
  expect(row.textContent).toContain("model picker");
  /* Past the ceiling the field scrolls internally, never the page. */
  expect(textarea.className).toContain("overflow-y-auto");
}

test("keyboard open: the ceiling budgets against the visual viewport (#983)", () => {
  /* Layout viewport 800px, keyboard eating half: visible 400px. The field may
     take 40% of what the user can SEE — max(160, 0.4·400) = 160px — never 40%
     of the full screen (320px), which would not fit above the keyboard. */
  openKeyboard(400);
  const textarea = mountComposer();
  expect(dom.innerHeight).toBe(800);
  expect(textarea.style.height).toBe("160px");
  expectToolsRowReachable(textarea, 400, 800);
});

test("keyboard closes: a visualViewport resize re-opens the tall ceiling (#983)", () => {
  const vv = openKeyboard(400);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("160px");
  /* The keyboard folds away — only visualViewport says so on iOS. */
  flushSync(() => vv.resizeTo(800));
  /* #983 re-opened this to a flat 320px, 40% of the 800px screen. The box the
     field lives in tops out at min(38dvh, 20rem) = 304px here, and the tools
     row needs 65 of those, so the field re-opens to 239 — still far past the
     shared 160px cap, and now with Stop inside the box beside it. */
  expect(textarea.style.height).toBe("239px");
  expectToolsRowReachable(textarea, 800, 800);
});

test("pinch zoom is not a keyboard: the scale factor cancels out of the budget (#983)", () => {
  /* Zoomed 2×, no keyboard: the visual viewport halves in CSS px but the
     layout budget is unchanged — the field keeps its full ceiling. */
  const vv = openKeyboard(400);
  vv.scale = 2;
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("239px");
  expectToolsRowReachable(textarea, 800, 800);
});

test("a keyboard-open viewport too short for the cap yields the chrome's share first (#983 round 2)", () => {
  /* 280px visible on the 800px layout. #983 reserved 156px here — a docked
     focus strip, a conversation header and a picker row under the input — and
     shrank the field to 124px to pay for them. Mobile v2 renders none of the
     three, so the honest reserve is 117 (the bar plus the box's own chrome)
     and the 160px cap fits inside 280 again. */
  openKeyboard(280);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("160px");
  expect(160 + MOBILE_COMPOSER_CHROME_PX).toBeLessThanOrEqual(280);
  expectToolsRowReachable(textarea, 280, 800);
});

test("smaller visible viewport: send stays visible because the field yields further (#983 round 2)", () => {
  /* At 240px visible the budget after chrome is 123px — still above the 44px
     one-row floor, so the field shrinks rather than pushing Send out. */
  openKeyboard(240);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("123px");
  expectToolsRowReachable(textarea, 240, 800);
  const send = dom.document.querySelector('button[aria-label="Send"]') as unknown as HTMLElement;
  expect(send).not.toBeNull();
  /* The 44px tap-target contract. Mobile v2 makes the phone's slot a REAL
     44 px box holding a 32 px visual, because the capture's hit gate measures
     bounding boxes and the old pseudo-element hit area measured 32 (§2 rule 7). */
  expect(send.className).toContain("h-11");
  expect(send.querySelector("span")!.className).toContain("h-8");
});

test("an absurdly small visible viewport floors the field at one tap-target row (#983 round 2)", () => {
  openKeyboard(150);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("44px");
});

test("without visualViewport the layout viewport still drives the ceiling (#177 item 3)", () => {
  /* Older browsers / SSR hydration: no visualViewport at all. The field still
     opens into a tall multi-line input, bounded by its own box. */
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("239px");
  expectToolsRowReachable(textarea, 800, 800);
});

test("390×844 dictating with the keyboard down: Stop stays inside the box (#1483)", () => {
  /* The operator's report. 40% of 844 is 338px, and 338 + the box's own 65px
     of chrome is 403 — 83px past the form's 320px max-height, so the form
     scrolled and the tools row sat below its bottom edge. The field takes 255
     instead: 255 + 65 = 320 exactly, the whole unit visible with no scroll. */
  layoutViewport(390, 844);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("255px");
  expectToolsRowReachable(textarea, 844, 844);
});

test("430×932 dictating with the keyboard down: the taller phone gets the same promise (#1483)", () => {
  layoutViewport(430, 932);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("255px");
  expectToolsRowReachable(textarea, 932, 932);
});

test("390×844 with the keyboard up keeps its 40% share unchanged (#1483 costs the keyboard case nothing)", () => {
  layoutViewport(390, 844);
  openKeyboard(508);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("203px");
  expectToolsRowReachable(textarea, 508, 844);
});

test("a rotated landscape phone: the box's own dvh cap is the tighter bound (#1483)", () => {
  /* 844×390 rotated, keyboard up. The layout viewport is 390px tall, so the
     box tops out at 38dvh = 148px and the field takes 83 of it. Budgeting the
     box against the VISIBLE height would have under-read every keyboard-open
     portrait frame, which is why the ceiling reads both viewports. */
  layoutViewport(844, 390);
  openKeyboard(280);
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("83px");
  expectToolsRowReachable(textarea, 280, 390);
});
