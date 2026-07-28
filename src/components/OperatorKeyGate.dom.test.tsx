import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import { OperatorKeyGate } from "./OperatorKeyGate";
import { hasOperatorCredential, operatorCredential, resetOperatorCredentialForTests } from "./operatorCredential";

/**
 * The paste is the credential's only way in (#691 round 9), so it is worth a test.
 *
 * Everything else about this feature is a refusal; this is the one affordance that
 * grants authority, and it grants it from a human action a local process cannot
 * perform. What is asserted is that the key reaches memory and reaches nothing else —
 * not the DOM node it was typed into, and not any store the profile would flush to
 * disk.
 */

installActEnv();

const dom = new Window({ url: "http://127.0.0.1:8898/" });
const G = globalThis as Record<string, unknown>;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const OVERRIDES = (): Record<string, unknown> => ({
  window: dom,
  document: dom.document,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  /* `useLocale` reads `navigator.language` on first render; without it the component
     throws before it can be asserted on at all. */
  navigator: dom.navigator,
});

beforeAll(() => {
  const overrides = OVERRIDES();
  for (const key of Object.keys(overrides)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = overrides[key];
  }
});

afterAll(async () => {
  /* Let React's scheduler drain before `window` is taken away underneath it. */
  await settle();
  for (const key of Object.keys(HAS)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

const KEY = "pasted-operator-key-4Kq2Zx";
let roots: Root[] = [];

/* `useSyncExternalStore` re-renders off the store notification, which lands after the
   dispatch that caused it; the assertions are about what the operator ends up seeing. */
const settle = async () => { for (let index = 0; index < 10; index += 1) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  resetOperatorCredentialForTests();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
});

function render(): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<OperatorKeyGate />));
  return container as unknown as HTMLElement;
}

function open(container: HTMLElement): HTMLInputElement {
  const button = container.querySelector("button");
  flushSync(() => { button?.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event); });
  const field = container.querySelector("input");
  if (!field) throw new Error("the key field did not open");
  return field as unknown as HTMLInputElement;
}

function paste(field: HTMLInputElement, value: string): void {
  field.value = value;
  flushSync(() => { field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event); });
  const form = field.closest("form");
  flushSync(() => { form?.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
}

test("a pasted key is adopted, and the gate gets out of the way", async () => {
  const container = render();
  paste(open(container), KEY);
  await settle();

  expect(hasOperatorCredential()).toBe(true);
  expect(operatorCredential()).toBe(KEY);
  /* Authorized: nothing left to ask for, so the whole affordance unmounts. */
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("input")).toBeNull();
});

test("the key does not stay in the DOM node it was typed into", async () => {
  const container = render();
  const field = open(container);
  paste(field, KEY);
  await settle();

  /* The detached node is the last copy outside the module variable; a field left
     populated would sit in the tab holding the credential for the page's lifetime. */
  expect(field.value).toBe("");
  expect(container.innerHTML).not.toContain(KEY);
});

test("adopting writes nothing a same-uid worker could read off the profile", async () => {
  const container = render();
  paste(open(container), KEY);
  await settle();

  expect(dom.sessionStorage.length).toBe(0);
  expect(dom.localStorage.length).toBe(0);
  expect(dom.location.href).not.toContain(KEY);
});

test("an empty submit refuses instead of appearing to unlock", async () => {
  const container = render();
  const field = open(container);
  paste(field, "   ");
  await settle();

  expect(hasOperatorCredential()).toBe(false);
  /* Still open, and saying so, rather than silently closing on a failed paste. */
  expect(container.querySelector("form")).not.toBeNull();
});
