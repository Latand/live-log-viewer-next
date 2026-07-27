import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { composerStore, resetComposerStoresForTest, type ComposerStore } from "@/components/voice/composerStore";
import { installActEnv } from "@/test-helpers/actEnv";

import { useComposer, type UseComposerReturn } from "./useComposer";

/**
 * U2, in production: one draft, two renderings.
 *
 * The card owns the real composer; the floater renders a second one. Until the card
 * consumes the shared store, "one draft" is true only of the store nothing writes to
 * — the card keeps its own `useState` and the two textareas silently diverge until
 * one of them is sent. These drive the card's own hook.
 */

installActEnv();

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const OVERRIDES = (): Record<string, unknown> => ({
  window: dom,
  document: dom.document,
  navigator: { language: "en-US", languages: ["en-US"], userAgent: "test", mediaDevices: {} },
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  const overrides = OVERRIDES();
  for (const key of Object.keys(overrides)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = overrides[key];
  }
});

afterAll(async () => {
  await settle();
  for (const key of Object.keys(HAS)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

let roots: Root[] = [];
let persisted: string[] = [];
let submitted: (string | undefined)[] = [];

beforeEach(() => {
  dom.document.body.replaceChildren();
  roots = [];
  persisted = [];
  submitted = [];
  resetComposerStoresForTest();
});

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
});

const CONVERSATION = "conversation_root_shared";

async function mountComposer(initial = "", shared: ComposerStore | null = composerStore(CONVERSATION)) {
  const published: UseComposerReturn[] = [];
  function Probe({ publish }: { publish: (composer: UseComposerReturn) => void }) {
    const composer = useComposer({
      initialText: () => initial,
      persistText: (value) => { persisted.push(value); },
      submit: (override) => { submitted.push(override); },
      shared,
    });
    publish(composer);
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  const render = () => flushSync(() => root.render(
    <Probe publish={(composer) => { published.push(composer); }} />,
  ));
  render();
  await settle();
  return { latest: () => published.at(-1)!, render };
}

test("typing in the card writes the one shared draft the floater reads", async () => {
  const card = await mountComposer();
  flushSync(() => card.latest().setText("start a reviewer"));
  await settle();

  expect(composerStore(CONVERSATION).getSnapshot().draft).toBe("start a reviewer");
  /* And the card's own persistence still runs — the shared store replaces neither
     the sessionStorage draft nor the outbox. */
  expect(persisted.at(-1)).toBe("start a reviewer");
});

test("an edit made in the floater appears in the card's textarea", async () => {
  const card = await mountComposer();
  flushSync(() => composerStore(CONVERSATION).setDraft("typed in the floating window"));
  await settle();

  expect(card.latest().text).toBe("typed in the floating window");
});

test("the card's persisted draft seeds the shared store on mount", async () => {
  const card = await mountComposer("a draft from last session");
  expect(composerStore(CONVERSATION).getSnapshot().draft).toBe("a draft from last session");
  expect(card.latest().text).toBe("a draft from last session");
});

test("a card remount does not clobber what was typed in the floater meanwhile", async () => {
  flushSync(() => composerStore(CONVERSATION).setDraft("newer, from the floater"));
  const card = await mountComposer("older persisted draft");
  expect(card.latest().text).toBe("newer, from the floater");
  expect(composerStore(CONVERSATION).getSnapshot().draft).toBe("newer, from the floater");
});

test("a composer with no shared store is completely unaffected", async () => {
  const card = await mountComposer("", null);
  flushSync(() => card.latest().setText("ordinary card"));
  await settle();

  expect(card.latest().text).toBe("ordinary card");
  /* The voice conversation's store must not have been touched by an unrelated card. */
  expect(composerStore(CONVERSATION).getSnapshot().draft).toBe("");
});

test("the floater's send runs the card's own submit, so there is one dispatcher", async () => {
  await mountComposer();
  const store = composerStore(CONVERSATION);
  flushSync(() => store.setDraft("deploy it"));
  await settle();

  /* This is what VoicePipHost invokes: the card registered its real delivery, so a
     send from the floating window goes through the queue-first outbox the card
     already owns rather than a second send route. */
  flushSync(() => store.send());
  await settle();
  expect(submitted).toHaveLength(1);
});

test("with no card mounted the floater's send delivers nothing rather than inventing a path", async () => {
  const store = composerStore(CONVERSATION);
  store.setDraft("nobody is listening");
  expect(() => store.send()).not.toThrow();
  expect(submitted).toEqual([]);
});
