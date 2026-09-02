import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import { translate } from "@/lib/i18n";
import type { FileEntry, PendingQuestion } from "@/lib/types";

import { QuestionCard, answerPendingQuestionWithText } from "./QuestionCard";

/*
 * Mobile v2 (#1439, lane 4; README §4.3): on the phone the question card is
 * question, options, "your own answer"; an option SENDS on tap; the reply is
 * the user's bubble; the card folds to one quiet `question · answered` line
 * that expands to the original question with the chosen option marked. A
 * suggested-reply chip answers through the card's seam and gets the same fold.
 * Transport words are a caption, never the headline (audit finding 6).
 */

let narrowViewport = false;

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === "(max-width:767px)" ? narrowViewport : false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

const dom = new Window({ url: "http://localhost/" });
(dom as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});

const tr = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const posted: Record<string, unknown>[] = [];
let answerResponse: () => { status: number; body: Record<string, unknown> } = () => ({ status: 200, body: { ok: true } });

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  if (url !== "/api/answer") throw new Error(`unexpected request: ${url}`);
  const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
  posted.push(body);
  const { status, body: answer } = answerResponse();
  const echo = typeof body.text === "string" ? body.text : undefined;
  return { ok: status < 400, status, json: async () => ({ ...(echo && status < 400 ? { answer: echo } : {}), ...answer }) } as Response;
}) as typeof fetch;

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  narrowViewport = false;
  posted.length = 0;
  answerResponse = () => ({ status: 200, body: { ok: true } });
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

function click(el: Element): void {
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const classOf = (el: Element | null) => el?.getAttribute("class") ?? "";

const OPTIONS = [
  "NDJSON — streams, matches the import path",
  "JSON array — simpler for the spreadsheet import",
  "Both, chosen by the Accept header",
];

function pendingQuestion(): PendingQuestion {
  return {
    kind: "question",
    toolUseId: "toolu_export_format",
    transcriptPath: "/sessions/export.jsonl",
    pid: 4242,
    paneTarget: "lanes:2.0",
    askedAt: new Date(Date.now() - 9 * 60_000).toISOString(),
    questions: [
      {
        question: "Which format should the export endpoint default to?",
        header: "Format",
        multiSelect: false,
        options: OPTIONS.map((label, index) => ({ label, description: index === 0 ? "the import path reads it already" : "", recommended: false })),
      },
    ],
  };
}

function questionFile(): FileEntry {
  return {
    path: "/sessions/export.jsonl",
    root: "claude-projects",
    name: "export.jsonl",
    project: "atlas",
    title: "Implement the export endpoint",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "recent",
    proc: "running",
    pid: 4242,
    pendingQuestion: pendingQuestion(),
    waitingInput: null,
  } as unknown as FileEntry;
}

test("phone: the card leads with the question, 44 px option rows and a 16 px own-answer field", () => {
  narrowViewport = true;
  const host = mount(<QuestionCard file={questionFile()} />);
  const card = host.querySelector('[data-mobile-question="pending"]')!;
  expect(card).toBeTruthy();
  /* Warning-soft surface with the 45% warning border, headed "Needs you · 9 min". */
  expect(classOf(card)).toContain("bg-warning-soft");
  expect(classOf(card)).toContain("border-warning/45");
  expect(card.textContent).toContain(`${en["mobile2.feed.needsYou"]} · ${tr("question.min", { n: 9 })}`);
  /* No transport word as the headline. */
  expect(card.textContent).not.toContain(en["question.waiting"]);
  /* The question at 15 px / 600. */
  const question = [...card.querySelectorAll("p")].find((p) => p.textContent === OPTIONS[0] ? false : (p.textContent ?? "").includes("Which format"))!;
  expect(classOf(question)).toContain("text-title");
  expect(classOf(question)).toContain("font-semibold");
  /* Each option is a 44 px row, 15 px, with a radio mark. */
  const options = [...card.querySelectorAll("button")].filter((b) => OPTIONS.some((label) => (b.textContent ?? "").includes(label)));
  expect(options).toHaveLength(3);
  for (const option of options) {
    expect(classOf(option)).toContain("min-h-11");
    expect(classOf(option)).toContain("text-title");
    expect(option.querySelector("i")).toBeTruthy();
  }
  /* The own-answer field: 44 px, 16 px type so iOS never zooms, a 44 px send. */
  const input = card.querySelector("input")!;
  expect(classOf(input)).toContain("min-h-11");
  expect(classOf(input)).toContain("text-[16px]");
  expect(input.getAttribute("placeholder")).toBe(en["question.ownAnswer"]);
  const send = card.querySelector(`button[aria-label="${en["common.send"]}"]`)!;
  expect(classOf(send)).toContain("h-11 w-11");
  /* The dismiss control is a 44 px target in the header. */
  expect(classOf(card.querySelector(`button[aria-label="${en["question.dismiss"]}"]`))).toContain("h-11 w-11");
});

test("phone: an option sends on tap, the reply is the user bubble, the card folds and expands with the pick marked", async () => {
  narrowViewport = true;
  const host = mount(<QuestionCard file={questionFile()} />);
  const option = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(OPTIONS[2]!))!;
  click(option);
  await tick();
  /* One POST, the picked option, no extra step. */
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ toolUseId: "toolu_export_format", kind: "question", answers: [[2]] });

  const answered = host.querySelector('[data-mobile-question="answered"]')!;
  expect(answered).toBeTruthy();
  /* The reply is the user's bubble: right-aligned, 86%, 15 px. */
  const reply = answered.querySelector("[data-question-reply]")!;
  expect(reply.textContent).toBe(OPTIONS[2]);
  expect(classOf(reply)).toContain("bg-user");
  expect(classOf(reply)).toContain("max-w-[86%]");
  expect(classOf(reply)).toContain("text-title");
  expect(classOf(reply.parentElement)).toContain("justify-end");
  /* Then one quiet 44 px line: `question · answered HH:MM`. */
  const fold = answered.querySelector("[data-question-fold]")!;
  expect(classOf(fold)).toContain("min-h-11");
  expect(fold.textContent).toMatch(/^question · answered \d{2}:\d{2}$/);
  expect(reply.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  /* No green "Answered:" band, no options, until it is expanded. */
  expect(answered.textContent).not.toContain("Answered:");
  expect(answered.querySelector("[data-question-fold-body]")).toBeNull();

  click(fold);
  const body = answered.querySelector("[data-question-fold-body]")!;
  expect(body).toBeTruthy();
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(body.textContent).toContain("Which format should the export endpoint default to?");
  const chosen = body.querySelectorAll('[data-choice-state="selected"]');
  expect(chosen).toHaveLength(1);
  expect(chosen[0]!.textContent).toBe(OPTIONS[2]);
  /* Every option is shown, none of them a control any more. */
  expect(body.querySelectorAll("button")).toHaveLength(0);
  expect(OPTIONS.every((label) => (body.textContent ?? "").includes(label))).toBe(true);

  click(fold);
  expect(answered.querySelector("[data-question-fold-body]")).toBeNull();
});

test("phone: a typed own answer sends and becomes the bubble", async () => {
  narrowViewport = true;
  const host = mount(<QuestionCard file={questionFile()} />);
  const input = host.querySelector("input") as HTMLInputElement;
  /* Typing into a controlled input: focus first, then the value through the
     prototype setter, then both the input event and a keyup — whichever
     change path react-dom chose when it loaded (see the harness notes) sees
     the keystroke. */
  flushSync(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "NDJSON, and add a test for each format.");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new dom.KeyboardEvent("keyup", { key: ".", bubbles: true }) as unknown as Event);
  });
  click(host.querySelector(`button[aria-label="${en["common.send"]}"]`)!);
  await tick();
  expect(posted[0]).toMatchObject({ text: "NDJSON, and add a test for each format." });
  expect(host.querySelector("[data-question-reply]")!.textContent).toBe("NDJSON, and add a test for each format.");
  click(host.querySelector("[data-question-fold]")!);
  /* Nothing was picked, so no option is marked. */
  expect(host.querySelectorAll('[data-choice-state="selected"]')).toHaveLength(0);
});

test("phone: a chip's text answers through the card's seam and the card folds the same way", async () => {
  narrowViewport = true;
  const host = mount(<QuestionCard file={questionFile()} />);
  const event = await answerPendingQuestionWithText(pendingQuestion(), "Both, by header");
  expect(event.ok).toBe(true);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ toolUseId: "toolu_export_format", kind: "question", text: "Both, by header" });
  await tick();
  expect(host.querySelector('[data-mobile-question="answered"]')).toBeTruthy();
  expect(host.querySelector("[data-question-reply]")!.textContent).toBe("Both, by header");
  expect(host.querySelector("[data-question-fold]")!.textContent).toContain("question · answered");
});

test("phone: a chip answer that fails shows the failure with a retry that resends the text", async () => {
  narrowViewport = true;
  answerResponse = () => ({ status: 502, body: { ok: false, delivered: false, error: "screen does not match this question: " } });
  const host = mount(<QuestionCard file={questionFile()} />);
  const event = await answerPendingQuestionWithText(pendingQuestion(), "Both, by header");
  expect(event.ok).toBe(false);
  await tick();
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert).toBeTruthy();
  expect(alert.textContent).toContain(en["question.errorNotDelivered"]);
  expect(alert.textContent).not.toContain("screen does not match");
  /* Still a pending card, still answerable. */
  expect(host.querySelector('[data-mobile-question="pending"]')).toBeTruthy();
  answerResponse = () => ({ status: 200, body: { ok: true } });
  const retry = [...alert.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(en["question.retryAnswer"]))!;
  expect(classOf(retry)).toContain("min-h-11");
  click(retry);
  await tick();
  expect(posted).toHaveLength(2);
  expect(posted[1]).toMatchObject({ text: "Both, by header" });
  expect(host.querySelector('[data-mobile-question="answered"]')).toBeTruthy();
});

test("phone: without a pane the transport state is a caption under the question, not the headline", () => {
  narrowViewport = true;
  const file = questionFile();
  file.pendingQuestion!.paneTarget = null;
  const host = mount(<QuestionCard file={file} />);
  const note = host.querySelector('[data-question-transport="unavailable"]')!;
  expect(note.textContent).toBe(en["question.noPane"]);
  const question = [...host.querySelectorAll("*")].find((el) => el.textContent === "Which format should the export endpoint default to?")!;
  expect(question.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("desktop: the card keeps its waiting chip, numbered options and green answered band", async () => {
  narrowViewport = false;
  const host = mount(<QuestionCard file={questionFile()} />);
  expect(host.querySelector("[data-mobile-question]")).toBeNull();
  expect(host.textContent).toContain(en["question.waiting"]);
  const option = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(OPTIONS[0]!))!;
  expect(classOf(option)).toContain("rounded-[8px]");
  click(option);
  await tick();
  expect(host.querySelector("[data-question-fold]")).toBeNull();
  expect(host.textContent).toContain(tr("question.answered", { text: OPTIONS[0]! }));
  expect(classOf(host.querySelector("#question"))).toContain("bg-success-soft");
});

