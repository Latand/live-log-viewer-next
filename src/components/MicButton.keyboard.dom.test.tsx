import { afterEach, expect, test } from "bun:test";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

/*
 * The transcription menu is portalled to the end of the document (#1858), so
 * it is out of Tab's reach from the Dictate button unless it takes focus
 * itself. Opened from the keyboard it has to hold focus, keep Tab inside, and
 * give focus back to the button when Escape closes it.
 */

const dom = new Window({ url: "http://localhost/" });
installActEnv();
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const backend = {
  backend: "chatgpt",
  lockedByEnv: false,
  options: [
    { id: "local", available: true, keyPath: "" },
    { id: "chatgpt", available: true, keyPath: "" },
    { id: "elevenlabs", available: false, keyPath: "$HOME/.config/example/elevenlabs.key" },
    { id: "soniox", available: true, keyPath: "" },
  ],
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const body = String(input) === "/api/transcribe/backend" ? backend : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { MicButtonView } = await import("./MicButton");

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

async function render(): Promise<HTMLButtonElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <MicButtonView
        phase="idle"
        elapsed={0}
        maxSeconds={300}
        remaining={300}
        capStopped={false}
        srMessage=""
        liveText=""
        canvasRef={createRef<HTMLCanvasElement>()}
        start={async () => {}}
        stop={async () => null}
        discard={() => {}}
        onText={() => {}}
      />,
    );
  });
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]');
  if (!button) throw new Error("no Dictate button");
  return button;
}

/** Shift+F10 on the focused button: the browser delivers it as a contextmenu event. */
async function openFromKeyboard(button: HTMLButtonElement): Promise<HTMLElement> {
  await act(async () => { button.focus(); });
  await act(async () => {
    button.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  /* The options arrive from the transcription route. */
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const menu = document.querySelector<HTMLElement>("[data-mic-backend-menu]");
  if (!menu) throw new Error("the menu did not open");
  expect(menu.querySelectorAll('[role="menuitemradio"]').length).toBe(4);
  return menu;
}

async function press(key: string, init: { shiftKey?: boolean } = {}): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as unknown as Event,
    );
  });
}

test("the menu opened from the keyboard takes focus on the selected option", async () => {
  const button = await render();
  const menu = await openFromKeyboard(button);
  const focused = document.activeElement as HTMLElement | null;
  expect(menu.contains(focused)).toBe(true);
  expect(focused?.getAttribute("role")).toBe("menuitemradio");
  expect(focused?.getAttribute("aria-checked")).toBe("true");
  expect(focused?.textContent).toContain("ChatGPT");
});

test("Tab and the arrows move between its options and never leave the menu", async () => {
  const button = await render();
  const menu = await openFromKeyboard(button);
  const options = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
  await press("Tab");
  expect(document.activeElement).toBe(options[2]);
  await press("Tab");
  await press("Tab");
  /* Past the last option Tab wraps to the first. */
  expect(document.activeElement).toBe(options[0]);
  await press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(options[3]);
  await press("ArrowUp");
  expect(document.activeElement).toBe(options[2]);
  await press("ArrowDown");
  expect(document.activeElement).toBe(options[3]);
});

test("Escape closes the menu and gives focus back to the Dictate button", async () => {
  const button = await render();
  await openFromKeyboard(button);
  await press("Tab");
  await press("Escape");
  expect(document.querySelector("[data-mic-backend-menu]")).toBeNull();
  expect(document.activeElement).toBe(button);
});

test("picking an option closes the menu and returns focus to the button", async () => {
  const button = await render();
  const menu = await openFromKeyboard(button);
  const soniox = menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[3];
  await act(async () => { soniox.focus(); soniox.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(document.querySelector("[data-mic-backend-menu]")).toBeNull();
  expect(document.activeElement).toBe(button);
});
