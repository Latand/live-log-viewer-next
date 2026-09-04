import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { translate } from "@/lib/i18n";

import { toolEvent } from "../__fixtures__/readableTools";
import type { CmdGroupItem, ToolEvent, ToolOutputBlock } from "../parse";
import { CmdGroupCard } from "./CmdGroupCard";
import { ToolCard } from "./ToolCard";

/*
 * #1498: an image an agent reads is a block of its tool result, and the tool
 * card draws it with the feed's ImageCard — among the result's text, in order.
 * Nothing decodes until the operator asks: the block renders as the collapsed
 * chip (dimensions · size · show), and the data URI enters the DOM only when
 * the chip is opened. One frame is ~400 KB of base64 and a capture run makes
 * dozens, so the phone (390 × 844) and the desktop both start collapsed.
 */

let narrowViewport = false;

const normalize = (query: string) => String(query).replace(/\s+/g, "");
/* The phone is whatever `useIsMobile` asks for — the shared layout query, so a
   future pin change cannot leave this stub matching a query nobody consults. */
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === normalize(MOBILE_LAYOUT_QUERY) ? narrowViewport : false,
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

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

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

function toggle(details: Element, open: boolean): void {
  (details as unknown as { open: boolean }).open = open;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}

function click(el: Element): void {
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event));
}

const FRAME_DATA = "c3ludGhldGljLWZyYW1l";
const FRAME_URI = `data:image/jpeg;base64,${FRAME_DATA}`;
const frame: ToolOutputBlock = { type: "image", media: "image/jpeg", data: FRAME_DATA, w: 1999, h: 1161, bytes: 304134 };

/** A Read of a rendered frame whose result carried text around the picture. */
function frameRead(over: Partial<ToolEvent> = {}): ToolEvent {
  return toolEvent({
    id: "read-frame",
    family: "read",
    tool: "Read",
    icon: "file",
    summary: "Read op-image-1.jpg",
    outputPreview: `before the frame\n[${en("render.imageOutput")}]\nafter the frame`,
    outputBlocks: [{ type: "text", text: "before the frame" }, frame, { type: "text", text: "after the frame" }],
    open: true,
    ...over,
  });
}

const chipOf = (host: Element) => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(en("common.show"))) ?? null;
const order = (text: string, ...needles: string[]) => needles.map((needle) => text.indexOf(needle));

test("desktop: the picture renders as a collapsed chip among the result's text, in order, with nothing decoded", () => {
  const host = mount(<ToolCard event={frameRead()} />);
  const body = host.querySelector("details > div")!;
  expect(body).toBeTruthy();
  /* No data URI in the DOM until the operator opens the chip. */
  expect(host.querySelector("img")).toBeNull();
  expect(host.innerHTML).not.toContain(FRAME_DATA);
  const chip = chipOf(host)!;
  expect(chip).toBeTruthy();
  expect(chip.textContent).toContain("1999×1161");
  expect(chip.textContent).toContain(`297 ${en("common.kb")}`);
  /* Text, picture, text — the transcript's order, and the placeholder text is gone. */
  const [before, picture, after] = order(body.textContent ?? "", "before the frame", "1999×1161", "after the frame");
  expect(before).toBeGreaterThanOrEqual(0);
  expect(picture).toBeGreaterThan(before);
  expect(after).toBeGreaterThan(picture);
  expect(body.textContent).not.toContain(`[${en("render.imageOutput")}]`);
  /* Inside the sunken body there is no feed-gutter indent to double up. */
  expect(chip.getAttribute("class")).not.toContain("ml-9");
  /* Opening the chip is what inserts the data URI. */
  click(chip);
  const img = host.querySelector("img")!;
  expect(img).toBeTruthy();
  expect(img.getAttribute("src")).toBe(FRAME_URI);
  expect(img.getAttribute("class")).not.toContain("ml-9");
});

test("phone at 390 px: the line is closed until tapped, then the picture is a 44 px chip that expands in place", () => {
  narrowViewport = true;
  const host = mount(<ToolCard event={frameRead()} />);
  const details = host.querySelector("details")!;
  expect((details as unknown as { open: boolean }).open).toBe(false);
  expect(host.querySelector("details > div")).toBeNull();
  expect(host.innerHTML).not.toContain(FRAME_DATA);
  toggle(details, true);
  expect(host.querySelector("img")).toBeNull();
  const chip = chipOf(host)!;
  expect(chip).toBeTruthy();
  expect(chip.getAttribute("class")).toContain("min-h-11");
  expect(chip.getAttribute("class")).not.toContain("ml-9");
  click(chip);
  const img = host.querySelector("img")!;
  expect(img.getAttribute("src")).toBe(FRAME_URI);
  /* The thumbnail never forces the 390 px document sideways. */
  expect(img.getAttribute("class")).toContain("max-w-full");
});

test("a live run block shows every picture as a chip and still decodes none of them", () => {
  const calls = [1, 2, 3].map((n) =>
    frameRead({ id: `read-frame-${n}`, summary: `Read op-image-${n}.jpg`, outputPreview: `[${en("render.imageOutput")}]`, outputBlocks: [frame] }),
  );
  const group: CmdGroupItem = {
    kind: "cmd-group",
    ids: calls.map((call) => call.id),
    calls,
    t0: calls[0]!.ts,
    t1: calls[2]!.ts,
    byTool: { Read: 3 },
    okCount: 3,
    errCount: 0,
    hasErr: false,
    active: true,
  };
  const host = mount(<CmdGroupCard item={group} />);
  const chips = [...host.querySelectorAll("button")].filter((button) => button.textContent?.includes(en("common.show")));
  expect(chips).toHaveLength(3);
  expect(host.querySelectorAll("img")).toHaveLength(0);
  expect(host.innerHTML).not.toContain(FRAME_DATA);
});

test("a picture block without data falls back to the text placeholder and never blanks the card", () => {
  const event = frameRead({
    outputPreview: `captured\n[${en("render.imageOutput")}]`,
    outputBlocks: [{ type: "text", text: "captured" }, { type: "image", media: "image/png", data: "" }],
  });
  const host = mount(<ToolCard event={event} />);
  const body = host.querySelector("details > div")!;
  expect(body.textContent).toContain("captured");
  expect(body.textContent).toContain(en("render.imageOutput"));
  expect(chipOf(host)).toBeNull();
  expect(host.querySelector("img")).toBeNull();
});
