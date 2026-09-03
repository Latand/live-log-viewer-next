import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useComposer, type UseComposerReturn } from "@/hooks/useComposer";
import { COMPOSER_MAX_PX } from "@/lib/composerScroll";

import { ComposerBar } from "@/components/ComposerBar";

/*
 * Issue #1483, cause 2 — a dictated chunk must never move the operator's
 * viewport.
 *
 * `insertSpoken` runs on EVERY dictated segment: the realtime commits while
 * the operator is still talking (`onLiveCommit`) and the transcript of a
 * capped auto-stop (`onUnclaimedText`). It drops the caret at the end and
 * scrolls the newest words into view, which is right. It did that after an
 * unqualified `el.focus()`, and an unqualified focus lets the browser scroll
 * the focused element into view — scrolling the composer's own scroll box, and
 * on iOS the window with it. Dictating a long transcript, the operator scrolled
 * down to reach Stop and the next chunk lifted the view straight back up.
 *
 * The newest words stay visible through the field's OWN `scrollTop`; nothing
 * outside the textarea may move. The focus call is where that is decided, so
 * this file asserts the call itself: `preventScroll` is the browser's one
 * switch for "do not scroll anything to reach this element", and a focus call
 * without it is a focus call that can scroll the page.
 */

const dom = new Window({ width: 390, height: 844 });
/* rAF resolved by hand: `insertSpoken` defers its focus/caret/scroll work by a
   frame, and a timer-driven frame would race the assertions. */
let frames: (() => void)[] = [];
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  requestAnimationFrame: (cb: () => void) => frames.push(cb),
  cancelAnimationFrame: () => {},
});
let mobile = true;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: mobile && query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
/* The field always overflows, so every insert lands past the grow ceiling and
   has somewhere to scroll to. */
const proto = dom.HTMLElement.prototype as unknown as Record<string, unknown>;
Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2000 });

function flushFrames(): void {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb();
}

let roots: Root[] = [];
afterEach(() => {
  for (const r of roots) flushSync(() => r.unmount());
  roots = [];
  frames = [];
  mobile = true;
  dom.document.body.replaceChildren();
});
afterAll(() => {
  delete (proto as { scrollHeight?: unknown }).scrollHeight;
});

let composer: UseComposerReturn | null = null;
function Harness() {
  composer = useComposer({ initialText: () => "already typed", persistText: () => {}, submit: () => {} });
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add images"
      leftSlot={<button type="button">model picker</button>}
      sendLabelIdle="Send"
      sendLabelRecording="Stop"
      sendIdleClassName="bg-accent"
    />
  );
}

interface Spies {
  field: HTMLTextAreaElement;
  focusCalls: unknown[];
  scrolledIntoView: number;
  windowScrolls: number;
}

function mountComposer(): Spies {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Harness />));
  const field = host.querySelector("textarea") as unknown as HTMLTextAreaElement;
  const spies: Spies = { field, focusCalls: [], scrolledIntoView: 0, windowScrolls: 0 };
  /* Own properties shadow the prototype methods for this element only. */
  field.focus = ((options?: unknown) => { spies.focusCalls.push(options); }) as HTMLTextAreaElement["focus"];
  field.scrollIntoView = (() => { spies.scrolledIntoView += 1; }) as HTMLTextAreaElement["scrollIntoView"];
  (dom as unknown as { scrollTo: () => void }).scrollTo = () => { spies.windowScrolls += 1; };
  return spies;
}

test("a dictated chunk focuses the field without letting the browser scroll to it (#1483)", () => {
  const spies = mountComposer();
  flushSync(() => composer!.insertSpoken("the first dictated chunk"));
  flushFrames();

  /* One focus, and it carries the browser's "do not scroll to reach this"
     switch. Without `preventScroll` the browser scrolls every ancestor — the
     composer's own scroll box, then the window — to bring the field into view,
     which is the jump the operator reported. */
  expect(spies.focusCalls).toHaveLength(1);
  expect(spies.focusCalls[0]).toBeDefined();
  expect((spies.focusCalls[0] as { preventScroll?: boolean }).preventScroll).toBe(true);
});

test("every chunk of a long dictation keeps the same promise (#1483)", () => {
  const spies = mountComposer();
  for (const chunk of ["one", "two", "three", "four", "five"]) {
    flushSync(() => composer!.insertSpoken(chunk));
    flushFrames();
  }
  expect(spies.focusCalls).toHaveLength(5);
  for (const options of spies.focusCalls) {
    expect((options as { preventScroll?: boolean } | undefined)?.preventScroll).toBe(true);
  }
});

test("the newest words stay visible inside the field, which scrolls internally (#1483)", () => {
  const spies = mountComposer();
  flushSync(() => composer!.insertSpoken("the newest words"));
  /* Zeroed after the render's own autosize pass, so what the frame does next
     is attributable to the insert alone. */
  spies.field.scrollTop = 0;
  flushFrames();

  /* The field itself scrolls to its bottom — the one scroll this insert is
     allowed to perform. */
  expect(spies.field.scrollTop).toBe(spies.field.scrollHeight);
  /* And the caret follows the text, so the operator keeps typing at the end. */
  expect(spies.field.selectionStart).toBe(spies.field.value.length);
  expect(spies.field.selectionEnd).toBe(spies.field.value.length);
  /* Nothing outside the textarea moved: no element scrolled into view, no
     window scroll. Both are the other roads to the same regression. */
  expect(spies.scrolledIntoView).toBe(0);
  expect(spies.windowScrolls).toBe(0);
});

test("desktop keeps its own ceiling and the same insert contract (#1483 changes nothing there)", () => {
  mobile = false;
  const spies = mountComposer();
  /* The desktop ceiling is the fixed shared cap, untouched by the phone's
     box budget: the overflowing field stops at COMPOSER_MAX_PX. */
  expect(spies.field.style.height).toBe(`${COMPOSER_MAX_PX}px`);
  flushSync(() => composer!.insertSpoken("spoken on a desktop"));
  spies.field.scrollTop = 0;
  flushFrames();
  /* Focus, caret at the end and the field scrolled to the newest words — the
     desktop's insert behaviour as it was. The one thing it now shares with the
     phone is that reaching the field scrolls nothing around it. */
  expect(spies.focusCalls).toHaveLength(1);
  expect((spies.focusCalls[0] as { preventScroll?: boolean }).preventScroll).toBe(true);
  expect(spies.field.scrollTop).toBe(spies.field.scrollHeight);
  expect(spies.field.selectionStart).toBe(spies.field.value.length);
  expect(spies.scrolledIntoView).toBe(0);
  expect(spies.windowScrolls).toBe(0);
});

test("the insert appends to what is already typed and clears the last status (#1483 keeps today's contract)", () => {
  const spies = mountComposer();
  flushSync(() => composer!.setStatus({ kind: "err", text: "an earlier failure" }));
  flushSync(() => composer!.insertSpoken("spoken words"));
  flushFrames();
  expect(spies.field.value).toBe("already typed spoken words");
  expect(composer!.status).toBeNull();
});
