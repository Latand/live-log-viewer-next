import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";
import { MOBILE_COMPOSER_CHROME_PX } from "@/lib/composerScroll";

import { ComposerBar } from "@/components/ComposerBar";

/*
 * Issue #983 — the phone grow ceiling must budget against the VISIBLE viewport.
 * iOS Safari ignores interactive-widget=resizes-content: with the on-screen
 * keyboard open, window.innerHeight keeps the full screen height and only
 * window.visualViewport reports the shrunken visible area. Sizing the field at
 * 40% of innerHeight then overflows the visible half-screen, pushing the model
 * picker and send/mic controls under the keyboard.
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

let roots: Root[] = [];
afterEach(() => {
  for (const r of roots) flushSync(() => r.unmount());
  roots = [];
  dom.document.body.replaceChildren();
  delete (dom as unknown as Record<string, unknown>).visualViewport;
  delete G.visualViewport;
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

test("keyboard open: the ceiling tracks the visual viewport, not the layout viewport (#983)", () => {
  /* Layout viewport 800px, keyboard eating half: visible 400px. The field may
     take 40% of what the user can SEE — max(160, 0.4·400) = 160px — never 40%
     of the full screen (320px), which would not fit above the keyboard. */
  const vv = makeVisualViewport(400);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  const textarea = mountComposer();
  expect(dom.innerHeight).toBe(800);
  expect(textarea.style.height).toBe("160px");
});

test("keyboard closes: a visualViewport resize re-opens the tall ceiling (#983)", () => {
  const vv = makeVisualViewport(400);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("160px");
  /* The keyboard folds away — only visualViewport says so on iOS. */
  flushSync(() => vv.resizeTo(800));
  expect(textarea.style.height).toBe("320px");
});

test("pinch zoom is not a keyboard: the scale factor cancels out of the budget (#983)", () => {
  /* Zoomed 2×, no keyboard: the visual viewport halves in CSS px but the
     layout budget is unchanged — the field keeps its full 40% ceiling. */
  const vv = makeVisualViewport(400);
  vv.scale = 2;
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("320px");
});

test("rotated keyboard: the ceiling shrinks below 160px so the chrome fits the visible area (#983 round 2)", () => {
  /* Landscape phone, keyboard up: 280px visible. The old 160px floor plus the
     mandatory chrome (focus strip, conversation header, 44px picker row —
     MOBILE_COMPOSER_CHROME_PX) needs ~316px, and the overflow-clipped shell
     hides the overflow — the picker was unreachable. The ceiling must yield
     the chrome's share first: 280 − 156 = 124px. */
  const vv = makeVisualViewport(280);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("124px");
  /* The arithmetic that decides visibility inside the clipped shell. */
  expect(124 + MOBILE_COMPOSER_CHROME_PX).toBeLessThanOrEqual(280);
  /* The tools row is present with its 44px row contract — the chip, the
     picker and the send slot all still reachable — and the field scrolls
     internally past the shrunken ceiling instead of pushing them out. */
  const row = dom.document.querySelector("[data-mobile2-tools]") as unknown as HTMLElement;
  expect(row).not.toBeNull();
  expect(row.className).toContain("min-h-11");
  expect(row.textContent).toContain("model picker");
  expect(textarea.className).toContain("overflow-y-auto");
});

test("smaller rotated viewport: send stays visible because the field yields further (#983 round 2)", () => {
  /* At 240px visible the budget after chrome is 84px — still above the 44px
     one-row floor, so the field shrinks rather than pushing Send out. */
  const vv = makeVisualViewport(240);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("84px");
  const send = dom.document.querySelector('button[aria-label="Send"]') as unknown as HTMLElement;
  expect(send).not.toBeNull();
  /* The 44px tap-target contract. Mobile v2 makes the phone's slot a REAL
     44 px box holding a 32 px visual, because the capture's hit gate measures
     bounding boxes and the old pseudo-element hit area measured 32 (§2 rule 7). */
  expect(send.className).toContain("h-11");
  expect(send.querySelector("span")!.className).toContain("h-8");
});

test("an absurdly small visible viewport floors the field at one tap-target row (#983 round 2)", () => {
  const vv = makeVisualViewport(150);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("44px");
});

test("without visualViewport the layout viewport still drives the ceiling (#177 item 3)", () => {
  /* Older browsers / SSR hydration: no visualViewport at all. Today's
     behaviour is preserved — 40% of window.innerHeight. */
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("320px");
});
