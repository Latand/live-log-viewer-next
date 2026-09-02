import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import { translate } from "@/lib/i18n";

import { FeedItem } from "./FeedItem";
import type { Item, ToolEvent } from "./parse";

/*
 * Mobile v2 (#1439, lane 4; README §2.6, §4.2, §8 row 4): on the phone the
 * feed spends no column on avatars, message content reads at 15 px, and the
 * message header is a 44 px target of its own that sits above the prose
 * instead of over it. The desktop keeps every class it had.
 *
 * Phone-ness is the viewport query `useIsMobile` consults; the pointer axis is
 * held at fine so the copy control's own sizing does not enter the picture.
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
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});

const tr = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  narrowViewport = false;
  dom.document.body.replaceChildren();
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

const classOf = (el: Element | null) => el?.getAttribute("class") ?? "";

function prose(): Item {
  return { kind: "prose", ts: "2026-09-02T13:43:00Z", engine: "claude", text: "The projection lives in one module." } as Item;
}

function user(): Item {
  return { kind: "user", ts: "2026-09-02T13:41:00Z", text: "Read the issue and tell me which file owns it." } as Item;
}

function tool(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: "call-1",
    ts: "2026-09-02T13:57:00Z",
    srcCall: 0,
    family: "shell",
    tool: "Bash",
    icon: "shell",
    summary: "bun test src/lib/board",
    chips: [],
    status: "ok",
    statusLabel: "ok",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    ...over,
  };
}

function tmsg(): Item {
  return { kind: "tmsg", ts: "2026-09-02T13:44:00Z", dir: "in", peer: "reviewer", summary: "", text: "APPROVE" } as Item;
}

test("phone: an agent message has no avatar column and its content reads at 15 px", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={prose()} />);
  const message = host.querySelector('[data-mobile-message="agent"]');
  expect(message).toBeTruthy();
  /* The 26 px engine avatar and its flex column are gone. */
  expect(host.querySelector(".bg-claude")).toBeNull();
  expect(classOf(message)).not.toContain("flex");
  expect(classOf(message)).not.toContain("gap-2.5");
  /* The prose is the full width at the title size (15 px) and 1.45 leading. */
  const body = host.querySelector("[data-tts-message]");
  expect(classOf(body)).toContain("w-full");
  expect(classOf(body)).toContain("text-title");
  expect(classOf(body)).toContain("leading-[1.45]");
  expect(classOf(body)).not.toContain("flex-1");
  /* The read-aloud anchors survive the layout change (#1022). */
  expect(body!.getAttribute("data-tts-message")).toBe("claude:2026-09-02T13:43:00Z");
  expect(host.querySelector("[data-tts-body]")).toBeTruthy();
});

test("phone: the message header is a 44 px target above the prose, never over it", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={prose()} speakText="The projection lives in one module." />);
  const message = host.querySelector('[data-mobile-message="agent"]')!;
  const header = host.querySelector("[data-mobile-message-header]")!;
  /* 44 px tall, the whole width, and the first thing in the message. */
  expect(classOf(header)).toContain("h-11");
  expect(classOf(header)).toContain("w-full");
  expect(message.firstElementChild).toBe(header);
  /* The prose starts under it: next sibling, in flow, no negative margin
     anywhere on the message that could pull the text up into the header. */
  expect(header.nextElementSibling).toBe(host.querySelector("[data-tts-message]"));
  for (const el of [message, header, host.querySelector("[data-tts-message]")!]) {
    expect(classOf(el)).not.toMatch(/(^|\s)-m[tby]?-/);
    expect(classOf(el)).not.toContain("absolute");
  }
  /* No vertical margin of its own: the header's height is the gap. */
  expect(classOf(message)).not.toContain("my-3");
  /* The engine mark is the one avatar left: a 16 px glyph beside the name. */
  const glyph = header.querySelector("svg");
  expect(classOf(glyph)).toContain("h-4");
  expect(header.textContent).toContain("Claude");
  expect(header.textContent).toContain("13:43");
  /* The message actions live in the header row: the copy control is there,
     and the read-aloud control shares the same cluster once the speech
     backend reports itself (it renders nothing without one, as here). */
  const actions = header.querySelector(`button[aria-label="${en["feed.copyMd"]}"]`)!;
  expect(actions).toBeTruthy();
  expect(classOf(actions.parentElement)).toContain("ml-auto");
  expect(host.querySelector("[data-tts-trigger]")).toBeNull();
});

test("phone: the user keeps the bubble at 86% and 15 px", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={user()} />);
  const bubble = host.querySelector(".bg-user")!;
  expect(classOf(bubble)).toContain("max-w-[86%]");
  expect(classOf(bubble)).toContain("text-title");
  expect(classOf(bubble)).not.toContain("max-w-[75%]");
});

test("phone: a lone tool call is one 44 px line with no chrome indent, and says when it runs", () => {
  narrowViewport = true;
  const host = mount(
    <>
      <FeedItem item={tool()} />
      <FeedItem item={tool({ id: "call-2", status: "run", statusLabel: "running", summary: "bun test src/lib/accounts" })} />
    </>,
  );
  const lines = host.querySelectorAll("[data-mobile-tool-line]");
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(classOf(line)).toContain("min-h-11");
  for (const details of host.querySelectorAll("details")) expect(classOf(details)).not.toContain("ml-9");
  expect(lines[0]!.getAttribute("data-mobile-tool-line")).toBe("done");
  expect(lines[1]!.getAttribute("data-mobile-tool-line")).toBe("running");
  expect(lines[1]!.textContent).toContain(tr("mobile2.feed.running", { summary: "bun test src/lib/accounts" }));
});

test("phone: internal relay cards drop the avatar-column indent too", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={tmsg()} />);
  expect(classOf(host.firstElementChild)).not.toContain("ml-9");
});

test("desktop: every message keeps its avatar column, indent, 75% bubble and margins", () => {
  narrowViewport = false;
  const host = mount(
    <>
      <FeedItem item={prose()} />
      <FeedItem item={user()} />
      <FeedItem item={tool()} />
      <FeedItem item={tmsg()} />
    </>,
  );
  expect(host.querySelector("[data-mobile-message]")).toBeNull();
  expect(host.querySelector("[data-mobile-message-header]")).toBeNull();
  expect(host.querySelector("[data-mobile-tool-line]")).toBeNull();
  expect(host.querySelector(".bg-claude")).toBeTruthy();
  expect(classOf(host.querySelector(".group\\/msg"))).toContain("my-3 flex gap-2.5");
  expect(classOf(host.querySelector("[data-tts-message]"))).toBe("min-w-0 flex-1 whitespace-pre-wrap break-words");
  expect(classOf(host.querySelector(".bg-user"))).toContain("max-w-[75%]");
  expect(classOf(host.querySelector("details"))).toContain("ml-9");
  expect(classOf(host.querySelector(".bg-accent-soft"))).toContain("my-3 ml-9 overflow-hidden");
});
