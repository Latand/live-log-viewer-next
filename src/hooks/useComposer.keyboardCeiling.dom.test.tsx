import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";

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
      leftSlot={null}
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

test("without visualViewport the layout viewport still drives the ceiling (#177 item 3)", () => {
  /* Older browsers / SSR hydration: no visualViewport at all. Today's
     behaviour is preserved — 40% of window.innerHeight. */
  const textarea = mountComposer();
  expect(textarea.style.height).toBe("320px");
});
