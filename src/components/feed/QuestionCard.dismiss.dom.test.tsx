import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import type { FileEntry } from "@/lib/types";

import { QuestionCard, isQuestionDismissed, questionDismissKey, rememberQuestionDismissed } from "./QuestionCard";

/*
 * Issue #765, explicit-dismiss half (the automatic half shipped in #775): a
 * skipped question card stayed pinned to the composer forever with nothing on
 * it to close it. The dismiss control must retire the card from the live
 * composer region — the same exit scanner-side retirement takes, leaving the
 * transcript's tool record as the history — and the dismissal must hold
 * across a reload, per question, without ever touching the answer API.
 */

/* Mobile is driven through the same viewport query `useIsMobile` consults. */
let narrowViewport = false;

const dom = new Window({ url: "http://localhost/" });
const matchMediaStub = (query: string) => ({
  matches: narrowViewport && String(query).replace(/\s+/g, "") === "(max-width:767px)",
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
});

const originalFetch = globalThis.fetch;
const roots: Root[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  narrowViewport = false;
  for (const root of roots.splice(0)) flushSync(() => { root.unmount(); });
  document.body.replaceChildren();
  dom.localStorage.clear();
});

function questionFile(overrides: { toolUseId?: string; paneTarget?: string | null } = {}): FileEntry {
  return {
    path: "/sessions/q.jsonl",
    root: "claude-projects",
    name: "q.jsonl",
    project: "demo",
    title: "Question",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 4_242,
    model: null,
    waitingInput: null,
    pendingQuestion: {
      kind: "question",
      toolUseId: overrides.toolUseId ?? "tool-1",
      transcriptPath: "/sessions/q.jsonl",
      pid: 4_242,
      paneTarget: overrides.paneTarget === undefined ? "%1" : overrides.paneTarget,
      askedAt: "2026-07-26T00:00:00.000Z",
      questions: [
        {
          question: "Which transport?",
          header: "Transport",
          multiSelect: false,
          options: [
            { label: "Structured", description: "pane-less", recommended: true },
            { label: "Terminal", description: "tmux pane" },
          ],
        },
      ],
    },
  } as unknown as FileEntry;
}

function renderCard(file: FileEntry): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => { root.render(<QuestionCard file={file} />); });
  return host as unknown as HTMLElement;
}

const dismissControl = (host: HTMLElement): HTMLButtonElement | undefined =>
  [...host.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === en["question.dismiss"],
  ) as HTMLButtonElement | undefined;

test("dismiss retires the card from the composer region without any API call", () => {
  let posts = 0;
  globalThis.fetch = mock(async () => {
    posts += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const host = renderCard(questionFile());
  expect(host.textContent).toContain(en["question.waiting"]);

  const dismiss = dismissControl(host);
  expect(dismiss).toBeTruthy();
  /* A native, labelled button: focusable and keyboard-operable by contract,
     and never a submit trigger inside a future form. */
  expect(dismiss!.getAttribute("type")).toBe("button");
  expect(dismiss!.hasAttribute("disabled")).toBe(false);

  flushSync(() => { dismiss!.click(); });

  /* The composer region is empty — the card no longer presents itself as
     awaiting input anywhere. The transcript history is untouched by
     construction: this component only ever owned the composer card. */
  expect(host.textContent).toBe("");
  expect(host.querySelector("#question")).toBeNull();
  expect(posts).toBe(0);
});

test("a dismissal is remembered across a remount (reload) of the same question", () => {
  const host = renderCard(questionFile());
  flushSync(() => { dismissControl(host)!.click(); });

  /* A fresh mount — what a reload or a second pane of the conversation is. */
  const remounted = renderCard(questionFile());
  expect(remounted.textContent).toBe("");
  expect(remounted.querySelector("#question")).toBeNull();
});

test("a dismissal is keyed to its question: the next question still renders", () => {
  const host = renderCard(questionFile({ toolUseId: "tool-1" }));
  flushSync(() => { dismissControl(host)!.click(); });

  const next = renderCard(questionFile({ toolUseId: "tool-2" }));
  expect(next.textContent).toContain(en["question.waiting"]);
  expect(next.querySelector("#question")).not.toBeNull();
});

test("the pane-less variant of the card carries the same dismiss control", () => {
  const host = renderCard(questionFile({ paneTarget: null }));
  expect(host.textContent).toContain(en["question.noPane"]);

  const dismiss = dismissControl(host);
  expect(dismiss).toBeTruthy();
  flushSync(() => { dismiss!.click(); });
  expect(host.textContent).toBe("");
});

test("on a phone the dismiss control meets the 44px touch target", () => {
  narrowViewport = true;
  const host = renderCard(questionFile());
  const dismiss = dismissControl(host)!;
  /* h-11/w-11 is the repo's 44px minimum for phone transcript question
     actions — the same classes the composer's receipt dismiss uses. */
  expect(dismiss.className).toContain("h-11");
  expect(dismiss.className).toContain("w-11");
});

test("both locales label the control", () => {
  expect(typeof en["question.dismiss"]).toBe("string");
  expect(en["question.dismiss"]).not.toBe("");
  expect(typeof uk["question.dismiss"]).toBe("string");
  expect(uk["question.dismiss"]).not.toBe("");
});

test("the dismissal store is per question and safe against a broken storage", () => {
  const q1 = { transcriptPath: "/sessions/a.jsonl", toolUseId: "t1" };
  const q2 = { transcriptPath: "/sessions/a.jsonl", toolUseId: "t2" };
  expect(questionDismissKey(q1)).not.toBe(questionDismissKey(q2));

  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  expect(isQuestionDismissed(storage, q1)).toBe(false);
  rememberQuestionDismissed(storage, q1);
  expect(isQuestionDismissed(storage, q1)).toBe(true);
  expect(isQuestionDismissed(storage, q2)).toBe(false);

  /* Safari private mode and quota errors throw; dismissal must not. */
  const throwing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  expect(isQuestionDismissed(throwing, q1)).toBe(false);
  expect(() => rememberQuestionDismissed(throwing, q1)).not.toThrow();
  expect(isQuestionDismissed(null, q1)).toBe(false);
});
