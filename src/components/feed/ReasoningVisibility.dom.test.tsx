import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createFeedSession, type FeedSnapshot } from "./parse";
import { useReasoningFeed } from "../conversation/liveTurnHandoff";
import { FeedItem } from "./FeedItem";
import type { FileEntry } from "@/lib/types";
import type { LogTailState } from "@/hooks/useLogTail";
import type { RuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import { setLocale } from "@/lib/i18n";

const dom = new Window({ width: 390, height: 844 });
const previous = Object.getOwnPropertyDescriptors(globalThis);
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, localStorage: dom.localStorage,
  Event: dom.Event, CustomEvent: dom.CustomEvent, sessionStorage: dom.sessionStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
const previousFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
let liveTurn: RuntimeLiveTurn | null = null;
const runtimeHooks = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({ ...runtimeHooks,
  useRuntimeSessionForConversation: () => ({ session: liveTurn ? { liveTurn, turn: "idle", host: "alive" } : null,
    uiState: "idle", attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true }),
}));
const { LogFeed } = await import("../LogFeed");
const { setLogFeedDependenciesForTests } = await import("../logFeedDependencies");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(() => { flushSync(() => root.render(null)); setLocale("en"); liveTurn = null; setLogFeedDependenciesForTests(null); });
afterAll(async () => {
  root.unmount();
  await new Promise((resolve) => setTimeout(resolve, 30));
  dom.close();
  globalThis.fetch = previousFetch;
  mock.restore();
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"]) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const record = (id: string, text = "") => JSON.stringify({ type: "event_msg", payload: {
  type: "item_completed", item: { type: "Reasoning", id, summary_text: text || [], raw_content: [] },
} });
const parser = () => createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
function render(lines: string[], start = 0) {
  const feed = parser().feed(lines, start, false);
  flushSync(() => root.render(<>{feed.items.map((entry) => <FeedItem key={entry.key} item={entry.item} />)}</>));
  return feed;
}

test("one accessible unavailable disclosure retains every source anchor without empty children", () => {
  const feed = render(Array.from({ length: 20 }, (_, i) => record(`reason-${i}`)));
  expect(host.querySelectorAll("details")).toHaveLength(1);
  expect(host.querySelector("summary")?.getAttribute("aria-label")).toBe("Reasoning · 20 · Text unavailable");
  expect(host.textContent).toContain("No reasoning text was provided.");
  expect(host.querySelectorAll("[data-feed-key]")).toHaveLength(20);
  for (let i = 0; i < 20; i++) {
    expect(host.querySelector(`[data-feed-key="row:${i}:0"]`)?.getAttribute("data-feed-source-id")).toBe(`reason-${i}`);
  }
  expect(feed.items).toHaveLength(1);
});

test("short and long provider text are fully present in the expandable body", () => {
  const long = "A provider-exposed explanation. ".repeat(20);
  render([record("short", "Short explanation"), record("empty"), record("long", long)]);
  expect(host.querySelectorAll("details")).toHaveLength(1);
  const details = host.querySelector("details")!;
  details.open = true;
  expect(details.querySelector("div")?.textContent).toBe(`Short explanation\n\n${long.trim()}`);
  expect(details.getAttribute("data-reasoning-availability")).toBe("available");
});

test("locale changes update availability and count without changing provider text", () => {
  render([record("empty")]);
  flushSync(() => setLocale("uk"));
  expect(host.querySelector("summary")?.getAttribute("aria-label")).toBe("Міркування · 1 · Текст відсутній");
  expect(host.textContent).toContain("Доступний текст міркувань не надано.");
});

test("prepending across the middle retains every previously addressable member", () => {
  const lines = Array.from({ length: 20 }, (_, i) => record(`reason-${i}`));
  render(lines.slice(10), 10);
  const anchors = Array.from(host.querySelectorAll("[data-feed-key]")).map((el) => el.getAttribute("data-feed-key"));
  render(lines);
  for (const anchor of anchors) expect(host.querySelector(`[data-feed-key="${anchor}"]`)).not.toBeNull();
  expect(host.querySelectorAll("details")).toHaveLength(1);
});


let serial = 0;
function mountFeed(lines: string[], start = 0) {
  const file = { path: `fixture/reasoning-${++serial}`, name: "reasoning", root: "fixture", engine: "codex",
    fmt: "codex", kind: "session", size: 1000, mtime: 0, activity: "idle" } as unknown as FileEntry;
  let finish = (_count: number) => {};
  let tail: LogTailState = { lines, linesStart: start, size: 1000, loading: false, error: null,
    tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: start > 0, loadingOlder: false,
    loadOlder: () => new Promise<number>((resolve) => { finish = resolve; }), prependGen: 0 };
  setLogFeedDependenciesForTests({ useLogTail: () => tail });
  const draw = (nextFile = file) => flushSync(() => root.render(<LogFeed file={nextFile} showSvc={false} lineFilter=""
    onStatus={() => {}} paused={false} follow={false} setFollow={() => {}} />));
  draw();
  return { file, draw, prepend(all: string[]) { tail = { ...tail, lines: all, linesStart: 0, prependGen: 1, hasMore: false }; draw(); finish(start); } };
}

test("mounted LogFeed upgrades a delayed supplied overlay in the canonical slot and retains it after buffer retirement", () => {
  const lines = [record("one"), record("two"), JSON.stringify({ type: "response_item", payload: {
    type: "message", role: "assistant", id: "final", content: [{ type: "output_text", text: "Final answer" }],
  } })];
  const feed = mountFeed(lines);
  const anchor = host.querySelector('[data-feed-source-id="two"]')!.getAttribute("data-feed-key");
  liveTurn = { turnId: "turn", text: "", items: [{ itemId: "two", text: "Delivered explanation", phase: "awaiting-echo", startedAt: null, completedAt: null }] };
  feed.draw();
  expect(host.querySelectorAll("details")).toHaveLength(1);
  expect(host.querySelector("details > div")?.textContent).toBe("Delivered explanation");
  expect(host.textContent?.match(/Delivered explanation/g)).toHaveLength(1);
  expect(host.textContent!.indexOf("Delivered explanation")).toBeLessThan(host.textContent!.indexOf("Final answer"));
  expect(host.querySelector('[data-feed-source-id="two"]')!.getAttribute("data-feed-key")).toBe(anchor);
  liveTurn = null; feed.draw();
  expect(host.querySelector("details > div")?.textContent).toBe("Delivered explanation");
  feed.draw({ ...feed.file, path: "fixture/other-conversation" });
  expect(host.textContent).not.toContain("Delivered explanation");
});

for (const start of [1, 10]) test(`mounted prepend across reasoning member ${start} preserves the current offset`, () => {
  const lines = Array.from({ length: 20 }, (_, i) => record(`reason-${i}`));
  const feed = mountFeed(lines.slice(start), start);
  const scroller = host.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 500 });
  const original = dom.HTMLElement.prototype.getBoundingClientRect;
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-feed-key")) return new dom.DOMRect(0, 200 - scroller.scrollTop, 390, 44);
    return original.call(this);
  };
  try {
    scroller.scrollTop = 80;
    const earlier = Array.from(host.querySelectorAll("button")).find((button) => /earlier/i.test(button.textContent ?? ""));
    expect(earlier).toBeDefined(); flushSync(() => earlier!.click());
    scroller.scrollTop += 60;
    const key = `row:${start}:0`;
    const before = host.querySelector(`[data-feed-key="${key}"]`)!.getBoundingClientRect().top;
    feed.prepend(lines);
    expect(host.querySelector(`[data-feed-key="${key}"]`)!.getBoundingClientRect().top).toBe(before);
    expect(scroller.scrollTop).toBe(140);
    expect(host.querySelectorAll("details")).toHaveLength(1);
    expect(host.querySelectorAll("details [data-feed-source-id]")).toHaveLength(20);
  } finally { dom.HTMLElement.prototype.getBoundingClientRect = original; }
});


test.skipIf(!process.env.LLV_REASONING_RECORDS)("captured native run through normalization, parser, and mounted renderer", async () => {
  const { normalizeSessionLine } = await import("@/lib/session/reader");
  const records = await Bun.file(process.env.LLV_REASONING_RECORDS!).json() as Record<string, unknown>[];
  expect(records).toHaveLength(40);
  const normalized = records.flatMap((record) => normalizeSessionLine("codex", record));
  expect(normalized.filter(({ record }) => record.kind === "reasoning" && record.text.trim())).toHaveLength(0);
  const session = parser();
  const lines = records.map((record) => JSON.stringify(record));
  const live = session.feed(lines, 0, true);
  const done = session.feed(lines, 0, false);
  expect(live.items).toEqual(done.items);
  expect(done.items).toHaveLength(1);
  const item = done.items[0].item;
  if (item.kind !== "think") throw new Error("expected reasoning");
  expect(new Set(item.members?.map((member) => member.sourceId)).size).toBe(20);
  expect(new Set(item.members?.map((member) => member.anchorKey)).size).toBe(20);
  expect(item.availability).toBe("unavailable");
  flushSync(() => root.render(<FeedItem item={item} />));
  expect(host.querySelectorAll("details")).toHaveLength(1);
  expect(host.querySelectorAll("[data-feed-source-id]")).toHaveLength(20);
  expect(host.textContent).toContain("No reasoning text was provided.");
});


function ProjectedReasoning({ feed, live, identity }: { feed: FeedSnapshot; live: RuntimeLiveTurn | null; identity: string }) {
  const projected = useReasoningFeed(feed, live, identity);
  return <>{projected.items.map((entry) => <FeedItem key={entry.key} item={entry.item} />)}</>;
}

test("pane-scoped reasoning projection retains text after live retirement and clears on conversation change", () => {
  const feed = parser().feed([record("member")], 0, false);
  const live: RuntimeLiveTurn = { turnId: "turn", text: "", items: [{ itemId: "member", text: "Supplied text", phase: "awaiting-echo", startedAt: null, completedAt: null }] };
  flushSync(() => root.render(<ProjectedReasoning feed={feed} live={live} identity="first" />));
  expect(host.querySelector("details > div")?.textContent).toBe("Supplied text");
  flushSync(() => root.render(<ProjectedReasoning feed={feed} live={null} identity="first" />));
  expect(host.querySelector("details > div")?.textContent).toBe("Supplied text");
  flushSync(() => root.render(<ProjectedReasoning feed={feed} live={null} identity="second" />));
  expect(host.textContent).not.toContain("Supplied text");
  expect(feed.items[0].item).toMatchObject({ text: "", availability: "unavailable" });
});
