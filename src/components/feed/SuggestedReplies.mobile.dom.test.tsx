import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import type { FileEntry, PendingQuestion } from "@/lib/types";

/*
 * Mobile v2 (#1439, lane 4; README §4.3): on the phone a suggested-reply chip
 * SENDS on tap. With a pane-backed question pending, the chip's text is the
 * question's reply; otherwise it enters the conversation's outbox — the same
 * write-ahead queue the composer's send button feeds — so the reply is the
 * user's bubble the instant it is tapped. The desktop chip still only fills
 * the composer (#1202).
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
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  matchMedia: matchMediaStub,
});

const { SuggestedReplies } = await import("./SuggestedReplies");
const { QuestionCard } = await import("./QuestionCard");
const { readOutbox, resetOutboxForTests } = await import("../conversation/outbox");

const SET_AT = "2026-09-02T13:55:00.000Z";
const drafts = [
  { label: "NDJSON", text: "NDJSON — it matches the import path." },
  { label: "Both, by header", text: "Both, chosen by the Accept header." },
  { label: "Ask the orchestrator", text: "Ask the orchestrator which format the spreadsheet import expects." },
];

const requests: { url: string; body: Record<string, unknown> | null }[] = [];
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  requests.push({ url, body });
  if (url.startsWith("/api/log/suggestions")) {
    const conversationId = decodeURIComponent(url.split("conversationId=")[1] ?? "");
    return { ok: true, json: async () => ({ set: { conversationId, setId: `rsg_${conversationId}`, at: SET_AT, origin: { kind: "manager", conversationId: "seat", role: "orchestrator" }, replies: drafts } }) } as Response;
  }
  if (url === "/api/answer") return { ok: true, status: 200, json: async () => ({ ok: true, answer: body?.text }) } as Response;
  throw new Error(`unexpected request: ${url}`);
}) as typeof fetch;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => { root.unmount(); });
  document.body.replaceChildren();
  sessionStorage.clear();
  requests.length = 0;
  narrowViewport = false;
  resetOutboxForTests();
});

function pendingQuestion(paneTarget: string | null): PendingQuestion {
  return {
    kind: "question",
    toolUseId: "toolu_export_format",
    transcriptPath: "/sessions/export.jsonl",
    pid: 4242,
    paneTarget,
    askedAt: SET_AT,
    questions: [{ question: "Which format should the export endpoint default to?", header: "Format", multiSelect: false, options: [{ label: "NDJSON", description: "", recommended: false }] }],
  };
}

function file(conversationId: string, pending: PendingQuestion | null = null): FileEntry {
  return {
    path: `/${conversationId}.jsonl`,
    root: "claude-projects",
    name: "export.jsonl",
    project: "atlas",
    title: "Implement the export endpoint",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: "running",
    pid: 4242,
    conversationId,
    pendingQuestion: pending,
    waitingInput: null,
  } as unknown as FileEntry;
}

function mount(node: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(node));
  return host as unknown as HTMLElement;
}

async function settle(host: HTMLElement, selector: string, count: number, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && host.querySelectorAll(selector).length !== count) {
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

const classOf = (el: Element | null) => el?.getAttribute("class") ?? "";

test("phone: chips are 32 px inside 44 px targets on one swipeable row", async () => {
  narrowViewport = true;
  const host = mount(<SuggestedReplies file={file("conv_chips")} revision="1" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);
  const row = host.querySelector("[data-mobile-chips]")!;
  expect(row).toBeTruthy();
  expect(row.getAttribute("aria-label")).toBe(en["composer.suggestedReplies"]);
  expect(classOf(row)).toContain("overflow-x-auto");
  expect(classOf(row)).not.toContain("flex-wrap");
  const chips = [...host.querySelectorAll("[data-reply-suggestion]")];
  expect(chips.map((chip) => chip.textContent)).toEqual(drafts.map((draft) => draft.label));
  for (const chip of chips) {
    expect(classOf(chip)).toContain("h-11");
    expect(classOf(chip.firstElementChild)).toContain("h-8");
    expect(classOf(chip.firstElementChild)).toContain("rounded-full");
  }
});

test("phone: with no question pending a chip sends through the outbox and the row retires", async () => {
  narrowViewport = true;
  const host = mount(<SuggestedReplies file={file("conv_send")} revision="1" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);
  const chip = host.querySelectorAll("[data-reply-suggestion]")[1] as HTMLButtonElement;
  flushSync(() => { chip.click(); });
  /* The text is in the conversation's write-ahead queue, the composer's own. */
  const queue = readOutbox("conv_send");
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({ text: drafts[1]!.text, state: "queued", images: 0 });
  expect(queue[0]!.id).toMatch(/^op_/);
  /* Nothing was dropped into the draft field, and no question was answered. */
  expect(sessionStorage.getItem("llvDraft:conv_send")).toBeNull();
  expect(requests.some((entry) => entry.url === "/api/answer")).toBe(false);
  /* The chips are gone the moment one was tapped. */
  expect(host.querySelector("[data-reply-suggestions]")).toBeNull();
});

test("phone: with a pane-backed question pending a chip answers it and the row retires", async () => {
  narrowViewport = true;
  const host = mount(<SuggestedReplies file={file("conv_answer", pendingQuestion("lanes:2.0"))} revision="1" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);
  const chip = host.querySelectorAll("[data-reply-suggestion]")[0] as HTMLButtonElement;
  flushSync(() => { chip.click(); });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const answer = requests.find((entry) => entry.url === "/api/answer");
  expect(answer).toBeTruthy();
  expect(answer!.body).toMatchObject({ toolUseId: "toolu_export_format", kind: "question", text: drafts[0]!.text });
  expect(readOutbox("conv_answer")).toHaveLength(0);
  expect(sessionStorage.getItem("llvDraft:conv_answer")).toBeNull();
  expect(host.querySelector("[data-reply-suggestions]")).toBeNull();
});

test("phone: answering the question from the card retires the chips, so no chip can re-post", async () => {
  narrowViewport = true;
  const entry = file("conv_card_answer", pendingQuestion("lanes:2.0"));
  const host = mount(
    <>
      <QuestionCard file={entry} />
      <SuggestedReplies file={entry} revision="1" />
    </>,
  );
  await settle(host, "[data-reply-suggestion]", drafts.length);
  expect(host.querySelector("[data-mobile-chips]")).toBeTruthy();
  /* The card's own option row, inside the card — the chip carries the same label. */
  const option = [...host.querySelector("#question")!.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("NDJSON"))!;
  flushSync(() => { option.click(); });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(requests.filter((entry) => entry.url === "/api/answer")).toHaveLength(1);
  expect(host.querySelector('[data-mobile-question="answered"]')).toBeTruthy();
  /* The chips went with the answer: nothing left to tap, nothing to re-post. */
  expect(host.querySelector("[data-reply-suggestions]")).toBeNull();
  expect(host.querySelectorAll("[data-reply-suggestion]")).toHaveLength(0);
  expect(readOutbox("conv_card_answer")).toHaveLength(0);
});

test("phone: a question with no pane cannot take the chip, so the chip sends as a message", async () => {
  narrowViewport = true;
  const host = mount(<SuggestedReplies file={file("conv_nopane", pendingQuestion(null))} revision="1" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);
  flushSync(() => { (host.querySelectorAll("[data-reply-suggestion]")[2] as HTMLButtonElement).click(); });
  expect(requests.some((entry) => entry.url === "/api/answer")).toBe(false);
  expect(readOutbox("conv_nopane")[0]).toMatchObject({ text: drafts[2]!.text });
});

test("desktop: a chip still only fills the composer draft", async () => {
  narrowViewport = false;
  const host = mount(<SuggestedReplies file={file("conv_desk")} revision="1" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);
  expect(host.querySelector("[data-mobile-chips]")).toBeNull();
  flushSync(() => { (host.querySelectorAll("[data-reply-suggestion]")[1] as HTMLButtonElement).click(); });
  expect(sessionStorage.getItem("llvDraft:conv_desk")).toBe(drafts[1]!.text);
  expect(readOutbox("conv_desk")).toHaveLength(0);
  expect(requests.some((entry) => entry.url === "/api/answer")).toBe(false);
  expect(host.querySelectorAll("[data-reply-suggestion]")).toHaveLength(drafts.length);
});
