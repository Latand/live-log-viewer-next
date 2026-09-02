import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import { setLocale } from "@/lib/i18n";
import { uk } from "@/lib/i18n/uk";

import { AttentionCard } from "./AttentionCard";
import { attentionDismissKey, isAttentionDismissed, rememberAttentionDismissed } from "./ConversationAttention";
import type { RuntimeAttention } from "./runtimeModel";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

/*
 * Issue #765, structured half: a question raised through the runtime plane
 * rendered as an AttentionCard with no way to dismiss it. The card now carries
 * the same labelled dismiss control the transcript-path QuestionCard got in
 * #779 — question cards only, view-level only (dismissal never answers or
 * resolves the attention), and it must never displace the answer controls as
 * the card's initial focus.
 */

/* Mobile is driven through the same viewport query `useIsMobile` consults. */
let narrowViewport = false;

const dom = new Window({ url: "http://localhost/" });
const matchMediaStub = (query: string) => ({
  matches: narrowViewport && String(query) === MOBILE_LAYOUT_QUERY,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
dom.matchMedia = matchMediaStub as unknown as typeof dom.matchMedia;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

const roots: Root[] = [];

afterEach(() => {
  narrowViewport = false;
  setLocale("en");
  for (const root of roots.splice(0)) flushSync(() => { root.unmount(); });
  document.body.replaceChildren();
  dom.localStorage.clear();
});

function questionAttention(overrides: Partial<RuntimeAttention> = {}): RuntimeAttention {
  return {
    id: "att_q1",
    conversationId: "conv_a",
    kind: "question",
    state: "open",
    unowned: false,
    createdAt: "2026-07-10T00:00:00.000Z",
    request: {
      question: {
        header: "Scope",
        /* Quoted key: an unquoted `prompt:` line reads as transcript content
           to the privacy publication gate. */
        "prompt": "Which scope should ship?",
        options: [
          { label: "Small", description: "Focused" },
          { label: "Full", description: "Everything" },
        ],
      },
    },
    ...overrides,
  };
}

function mount(node: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  roots.push(root);
  return host;
}

const dismissButton = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>("button[data-attention-dismiss]");

test("a question card carries a labelled dismiss control that only dismisses", () => {
  let dismissed = 0;
  let answered = 0;
  const host = mount(
    <AttentionCard
      attention={questionAttention()}
      onAnswerQuestion={() => { answered += 1; }}
      onDismiss={() => { dismissed += 1; }}
    />,
  );
  const control = dismissButton(host);
  expect(control).not.toBeNull();
  expect(control!.getAttribute("aria-label")).toBe(en["question.dismiss"]);
  expect(typeof uk["question.dismiss"]).toBe("string");
  expect(uk["question.dismiss"]).not.toBe(en["question.dismiss"]);
  control!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(dismissed).toBe(1);
  expect(answered).toBe(0);
});

test("without a dismiss handler no control renders (approvals stay undismissable)", () => {
  const host = mount(
    <AttentionCard
      attention={questionAttention({ id: "att_a1", kind: "approval", request: { command: "rm -rf build" } })}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );
  expect(dismissButton(host)).toBeNull();
});

test("an archived card never offers dismissal — it is already inert history", () => {
  const host = mount(
    <AttentionCard attention={questionAttention()} archived onDismiss={() => {}} />,
  );
  expect(dismissButton(host)).toBeNull();
});

test("initial focus lands on the first answer option, never on the dismiss X", () => {
  const host = mount(
    <AttentionCard attention={questionAttention()} onAnswerQuestion={() => {}} onDismiss={() => {}} />,
  );
  const focused = document.activeElement as HTMLElement | null;
  expect(focused?.hasAttribute("data-attention-dismiss")).toBe(false);
  expect(focused?.textContent ?? "").toContain("Small");
  /* The X stays reachable in the Tab cycle. */
  expect(dismissButton(host)).not.toBeNull();
});

test("the dismiss control meets the 44px phone target", () => {
  narrowViewport = true;
  const host = mount(
    <AttentionCard attention={questionAttention()} onAnswerQuestion={() => {}} onDismiss={() => {}} />,
  );
  const control = dismissButton(host)!;
  expect(control.className).toContain("h-11");
  expect(control.className).toContain("w-11");
});

test("dismissal is remembered per attention and safe against a broken store", () => {
  const attention = { conversationId: "conv_a", id: "att_q1" };
  const sibling = { conversationId: "conv_a", id: "att_q2" };
  expect(attentionDismissKey(attention)).not.toBe(attentionDismissKey(sibling));

  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  expect(isAttentionDismissed(storage, attention)).toBe(false);
  rememberAttentionDismissed(storage, attention);
  expect(isAttentionDismissed(storage, attention)).toBe(true);
  expect(isAttentionDismissed(storage, sibling)).toBe(false);

  const throwing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  expect(isAttentionDismissed(throwing, attention)).toBe(false);
  expect(() => rememberAttentionDismissed(throwing, attention)).not.toThrow();
  expect(isAttentionDismissed(null, attention)).toBe(false);
});
