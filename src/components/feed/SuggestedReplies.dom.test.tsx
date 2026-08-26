import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * #1202 in the renderer: the manager's drafts as pills under its own message,
 * and one tap away from being the operator's next sentence.
 *
 * The click goes through the composer's OWN insertion seam — the stored draft
 * plus the compose event every mounted composer for that conversation listens
 * to — so this mounts the real composer beside the pills and asserts what the
 * operator would see: their text in the field, focused, caret at the end, and
 * nothing sent.
 */

const dom = new Window({ url: "http://localhost/" });
dom.matchMedia = ((query: string) => ({
  matches: false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
})) as unknown as typeof dom.matchMedia;
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
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});

const { SuggestedReplies } = await import("./SuggestedReplies");
const { TmuxComposer } = await import("../TmuxComposer");

const CONVERSATION = "conversation_seat";
const SET_AT = "2026-08-26T10:00:00.000Z";

const drafts = [
  { label: "yes, do it", text: "Yes — merge it and deploy." },
  { label: "only the first part", text: "Only the first part: merge, hold the deploy." },
  { label: "hold — explain first", text: "Hold. Explain the rollback path first." },
];

let served: { set: unknown } = { set: { conversationId: CONVERSATION, setId: "rsg_1", at: SET_AT, origin: { kind: "manager", conversationId: CONVERSATION, role: "orchestrator" }, replies: drafts } };
const requests: { url: string; method: string }[] = [];
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  requests.push({ url, method: init?.method ?? "GET" });
  if (url.startsWith("/api/log/suggestions")) {
    return { ok: true, json: async () => served } as Response;
  }
  if (url === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
  throw new Error(`unexpected request: ${url}`);
}) as typeof fetch;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => { root.unmount(); });
  document.body.replaceChildren();
  sessionStorage.clear();
  requests.length = 0;
  setLocale("en");
});

function file(conversationId = CONVERSATION): FileEntry {
  return {
    path: `/${conversationId}.jsonl`,
    root: "claude-projects",
    name: "seat.jsonl",
    project: "viewer",
    title: "Manager",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: "running",
    pid: null,
    conversationId,
    pendingQuestion: null,
    waitingInput: null,
  } as unknown as FileEntry;
}

function mountRoot(node: React.ReactElement): { host: HTMLElement; rerender: (next: React.ReactElement) => void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(node));
  return {
    host: host as unknown as HTMLElement,
    rerender: (next) => flushSync(() => root.render(next)),
  };
}

function mount(node: React.ReactElement): HTMLElement {
  return mountRoot(node).host;
}

async function settle(host: HTMLElement, selector: string, count: number, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && host.querySelectorAll(selector).length !== count) {
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

test("the current set renders as one pill per draft, labelled and in order", async () => {
  const host = mount(<SuggestedReplies file={file()} revision="1" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);

  const pills = [...host.querySelectorAll("[data-reply-suggestion]")];
  expect(pills.map((pill) => pill.textContent)).toEqual(drafts.map((draft) => draft.label));
  /* A row, wrapping and scrollable, so a phone shows three drafts without a
     horizontal page. */
  const row = host.querySelector("[data-reply-suggestions]")!;
  expect(row.getAttribute("aria-label")).toBe(en["composer.suggestedReplies"]);
  expect(row.className).toContain("flex-wrap");
  expect(row.className).toContain("overflow-x-auto");
});

test("the row names itself in the operator's own language", async () => {
  setLocale("uk");
  const host = mount(<SuggestedReplies file={file()} revision="uk" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);

  expect(host.querySelector("[data-reply-suggestions]")!.getAttribute("aria-label")).toBe(String(uk["composer.suggestedReplies"]));
  expect(String(uk["composer.suggestedReplies"])).not.toBe(en["composer.suggestedReplies"]);
});

test("tapping a pill fills the composer — focused, caret at the end, nothing sent", async () => {
  const host = mount(
    <>
      <SuggestedReplies file={file()} revision="2" />
      <TmuxComposer file={file()} />
    </>,
  );
  await settle(host, "[data-reply-suggestion]", drafts.length);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("");

  const pill = host.querySelectorAll("[data-reply-suggestion]")[2] as HTMLButtonElement;
  flushSync(() => { pill.click(); });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(textarea.value).toBe(drafts[2]!.text);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe(drafts[2]!.text.length);
  /* The draft is a draft: no delivery was attempted, and the pills stay put
     until the operator actually sends. */
  expect(requests.some((entry) => entry.url === "/api/tmux")).toBe(false);
  expect(host.querySelectorAll("[data-reply-suggestion]")).toHaveLength(drafts.length);
});

test("a draft joins whatever the operator already typed instead of replacing it", async () => {
  sessionStorage.setItem(`llvDraft:${CONVERSATION}`, "one more thing:");
  const host = mount(
    <>
      <SuggestedReplies file={file()} revision="3" />
      <TmuxComposer file={file()} />
    </>,
  );
  await settle(host, "[data-reply-suggestion]", drafts.length);

  flushSync(() => { (host.querySelectorAll("[data-reply-suggestion]")[0] as HTMLButtonElement).click(); });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe(`one more thing:\n\n${drafts[0]!.text}`);
});

test("the operator's own message retires the set and clears the durable record", async () => {
  const answered = { at: Date.parse(SET_AT) + 1_000, text: "no, wait" };
  const host = mount(<SuggestedReplies file={file()} revision="4" outbox={[{ id: "out-1", text: answered.text, images: 0, at: answered.at, state: "queued" }] as never} />);
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(host.querySelectorAll("[data-reply-suggestion]")).toHaveLength(0);
  expect(requests.some((entry) => entry.method === "DELETE" && entry.url.includes(CONVERSATION))).toBe(true);
});

test("a second set offered into the same pane is retired by its own answer", async () => {
  /* The clear is guarded per set, not per mount: a pane the operator keeps open
     all afternoon answers many asks, and every one of those answers has to take
     its own drafts down — and the record with them. */
  const conversation = "conversation_two_asks";
  const answeredFirstAt = Date.parse(SET_AT) + 1_000;
  const secondAt = new Date(Date.parse(SET_AT) + 2_000).toISOString();
  const outboxAt = (at: number) => [{ id: `out-${at}`, text: "answered", images: 0, at, state: "queued" }] as never;
  served = { set: { conversationId: conversation, setId: "rsg_first", at: SET_AT, origin: { kind: "manager", conversationId: conversation, role: "orchestrator" }, replies: drafts } };

  const { host, rerender } = mountRoot(<SuggestedReplies file={file(conversation)} revision="ask-1" />);
  await settle(host, "[data-reply-suggestion]", drafts.length);

  rerender(<SuggestedReplies file={file(conversation)} revision="ask-1" outbox={outboxAt(answeredFirstAt)} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(host.querySelectorAll("[data-reply-suggestion]")).toHaveLength(0);
  expect(requests.filter((entry) => entry.method === "DELETE")).toHaveLength(1);

  /* The manager asks again in the same pane, and the operator answers again. */
  served = { set: { conversationId: conversation, setId: "rsg_second", at: secondAt, origin: { kind: "manager", conversationId: conversation, role: "orchestrator" }, replies: drafts.slice(0, 2) } };
  rerender(<SuggestedReplies file={file(conversation)} revision="ask-2" outbox={outboxAt(answeredFirstAt)} />);
  /* Past the read floor: a burst of transcript growth collapses into one
     trailing read, so the fresh set lands a beat after the pane moved. */
  await settle(host, "[data-reply-suggestion]", 2, 4_000);
  expect(host.querySelectorAll("[data-reply-suggestion]")).toHaveLength(2);

  rerender(<SuggestedReplies file={file(conversation)} revision="ask-2" outbox={outboxAt(Date.parse(secondAt) + 1_000)} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(host.querySelectorAll("[data-reply-suggestion]")).toHaveLength(0);
  expect(requests.filter((entry) => entry.method === "DELETE")).toHaveLength(2);
});

test("a conversation with no set renders nothing at all", async () => {
  /* Its own conversation: nothing this file read earlier can answer for it. */
  served = { set: null };
  const host = mount(<SuggestedReplies file={file("conversation_quiet")} revision="5" />);
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(host.querySelector("[data-reply-suggestions]")).toBeNull();
  expect(requests.some((entry) => entry.url.includes("conversation_quiet"))).toBe(true);
});
