import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { parseConversationHash } from "@/lib/accounts/identity";
import type { TranscriptSearchRow } from "@/app/api/search/transcripts/route";

/*
 * Issue #1054 — the global "find my messages" palette.
 *
 * Every state the design note names is rendered here on purpose: empty query,
 * first-page loading, results, a zero answer that PROVES what it searched, and
 * a failure with a retry. Plus the two behaviours the operator's requirement
 * turns on — the speaker default ("my messages") and select-to-open, which
 * hands off through the app's own `#f=` deep link rather than any new
 * navigation machinery.
 *
 * Fixture strings are invented placeholders; nothing here is lifted from a real
 * conversation.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  history: dom.history,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

const { createRoot } = await import("react-dom/client");
const { GlobalSearch, transcriptFocusHash } = await import("./GlobalSearch");

interface Page {
  items: TranscriptSearchRow[];
  nextCursor: string | null;
  total: number;
  stats: { conversationsIndexed: number; messagesIndexed: number; fieldsSearched: string[]; tokenizer: string };
}

const MATCH_OPEN = "\u0001";
const MATCH_CLOSE = "\u0002";

function row(over: Partial<TranscriptSearchRow> = {}): TranscriptSearchRow {
  return {
    snippet: `chase the ${MATCH_OPEN}heliotrope${MATCH_CLOSE} rollout`,
    speaker: "user",
    timestamp: Math.floor(Date.now() / 1_000) - 120,
    transcriptPath: "/sessions/alpha.jsonl",
    byteOffset: 0,
    lineNumber: 1,
    project: "reports",
    engine: "claude",
    title: "Heliotrope rollout",
    ...over,
  };
}

function page(over: Partial<Page> = {}): Page {
  return {
    items: [],
    nextCursor: null,
    total: 0,
    stats: { conversationsIndexed: 12, messagesIndexed: 4_310, fieldsSearched: ["message.body"], tokenizer: "t" },
    ...over,
  };
}

let requests: string[] = [];
let answer: (url: string) => Promise<Response> = async () => Response.json(page());
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let closed = 0;
/* What the palette handed the shell to open. The palette does not navigate
   itself, so this — not `location.hash` — is the selection's observable. */
let opened: string[] = [];

/* Scoped to this endpoint on purpose: modules loaded by neighbouring test files
   keep their own pollers alive (the runtime bus hits `/api/runtime/snapshot`),
   and counting those as search traffic made this file pass or fail on which
   suite ran beside it. */
function stubFetch() {
  Object.assign(globalThis, {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("/api/search/transcripts")) return Promise.resolve(Response.json({}));
      requests.push(url);
      return answer(url);
    },
  });
}

async function mount(mobile = false) {
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(
      <GlobalSearch
        mobile={mobile}
        onClose={() => { closed += 1; }}
        onOpen={(path) => { opened.push(path); }}
      />,
    );
  });
}

/** Lets the 250ms debounce elapse and the request settle. */
async function settle(ms = 320) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The mounted overlay. Every DOM assertion below runs against it. */
function view(): HTMLDivElement {
  if (!host) throw new Error("the palette is not mounted");
  return host;
}

/** happy-dom's event classes do not structurally match lib.dom's, so the cast
    lives in one place rather than at every dispatch site. */
function dispatch(target: EventTarget, event: unknown): boolean {
  return target.dispatchEvent(event as Event);
}

function type(value: string) {
  const input = view().querySelector<HTMLInputElement>("[data-search-input]")!;
  act(() => {
    /* react-dom decides ONCE per process whether native `input` events can
       drive onChange (`canUseDOM`, resolved when it is first imported — which
       may be from another test file, before any window exists). When it decided
       no, it falls back to a focus/keydown polyfill. Focusing and adding the
       keydown makes a keystroke land under either decision. */
    input.focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    dispatch(input, new dom.Event("input", { bubbles: true }));
    dispatch(input, new dom.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
}

function press(key: string) {
  const input = view().querySelector<HTMLInputElement>("[data-search-input]")!;
  act(() => {
    dispatch(input, new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function click(selector: string) {
  const node = view().querySelector<HTMLElement>(selector)!;
  act(() => {
    dispatch(node, new dom.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  requests = [];
  closed = 0;
  opened = [];
  answer = async () => Response.json(page());
  dom.location.hash = "";
  stubFetch();
});

afterEach(async () => {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => mounted.unmount());
  host?.remove();
  host = null;
});

test("the link a selection writes is the one the shell resolves", () => {
  /* The two halves of "find, open, CONTINUE": the palette writes this hash and
     Viewer's resolver reads it back to the exact transcript, which is what
     lands the conversation on board focus / MobileFocusView with its composer.
     A path with spaces and a hash character proves the encoding round-trips. */
  const path = "/sessions/a project/session #2.jsonl";

  expect(parseConversationHash(transcriptFocusHash(path)).filePath).toBe(path);
});

test("an untouched palette explains itself and asks for nothing", async () => {
  await mount();

  expect(view().querySelector("[data-search-hint]")?.textContent).toContain("every project");
  expect(view().querySelector("[data-search-hint]")?.textContent).toContain("Enter to open");
  expect(view().querySelector("[data-search-result]")).toBeNull();
  /* An empty query must not cost a request. */
  await settle(300);
  expect(requests).toEqual([]);
});

test("the first query searches the operator's own messages across every project", async () => {
  answer = async () => Response.json(page({ items: [row()], total: 1 }));
  await mount();

  type("heliotrope");
  await settle();

  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("speaker=user");
  expect(requests[0]).not.toContain("project=");
  expect(view().querySelector<HTMLElement>('[data-search-scope="mine"]')?.getAttribute("aria-checked")).toBe("true");
});

test("a result row names the conversation, its project and engine, and marks the matched words", async () => {
  answer = async () => Response.json(page({ items: [row()], total: 1 }));
  await mount();

  type("heliotrope");
  await settle();

  const result = view().querySelector<HTMLElement>("[data-search-result]")!;
  expect(result.textContent).toContain("Heliotrope rollout");
  expect(result.textContent).toContain("reports");
  expect(result.textContent).toContain("Claude");
  expect(result.querySelector("[data-search-match]")?.textContent).toBe("heliotrope");
  /* The sentinel delimiters are consumed by the renderer, never shown. */
  expect(result.textContent).not.toContain(MATCH_OPEN);
  expect(result.textContent).not.toContain(MATCH_CLOSE);
  expect(view().querySelector("[data-search-total]")?.textContent).toBe("1");
});

test("arrows and Enter open the conversation through the app's own deep link", async () => {
  answer = async () => Response.json(page({
    items: [row(), row({ transcriptPath: "/sessions/beta.jsonl", byteOffset: 40, title: "Second match" })],
    total: 2,
  }));
  await mount();

  type("heliotrope");
  await settle();

  const input = view().querySelector<HTMLInputElement>("[data-search-input]")!;
  expect(input.getAttribute("aria-activedescendant")).toBe("llv-search-option-0");
  press("ArrowDown");
  expect(view().querySelector<HTMLInputElement>("[data-search-input]")!.getAttribute("aria-activedescendant"))
    .toBe("llv-search-option-1");
  press("Enter");

  expect(opened).toEqual(["/sessions/beta.jsonl"]);
  expect(closed).toBe(1);
});

test("clicking a row opens that conversation and closes the palette", async () => {
  answer = async () => Response.json(page({ items: [row()], total: 1 }));
  await mount();

  type("heliotrope");
  await settle();
  click("[data-search-result]");

  expect(opened).toEqual(["/sessions/alpha.jsonl"]);
  expect(closed).toBe(1);
});

test("a selection is handed over even when the tab already sits on that hash", async () => {
  /* The tab can be standing on a stale `#f=` while the conversation is NOT on
     screen: a path-only conversation keeps that entry after the board switches
     to List view, which changes no hash. If the palette navigated by assigning
     the hash, this selection would fire no hashchange and open nothing — the
     operator would be dropped back on the surface they searched from. So the
     handoff is unconditional and the shell decides how to re-enter. */
  answer = async () => Response.json(page({ items: [row()], total: 1 }));
  dom.location.hash = transcriptFocusHash("/sessions/alpha.jsonl");
  await mount();

  type("heliotrope");
  await settle();
  click("[data-search-result]");

  expect(opened).toEqual(["/sessions/alpha.jsonl"]);
  expect(closed).toBe(1);
});

test("a query in flight shows loading, and a refinement keeps the rows already on screen", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  answer = async (url) => {
    if (url.includes("q=heliotropes")) {
      await gate;
      return Response.json(page({ items: [row({ title: "Refined" })], total: 1 }));
    }
    return Response.json(page({ items: [row()], total: 1 }));
  };
  await mount();

  type("heliotrope");
  expect(view().querySelector("[data-search-loading]")).not.toBeNull();
  await settle();
  expect(view().querySelector("[data-search-result]")).not.toBeNull();

  type("heliotropes");
  await settle();
  /* Rows hold and the header says so — no blank list between keystrokes. */
  expect(view().querySelector("[data-search-result]")?.textContent).toContain("Heliotrope rollout");
  expect(view().querySelector("[data-search-updating]")).not.toBeNull();

  release();
  await settle(50);
  expect(view().querySelector("[data-search-result]")?.textContent).toContain("Refined");
  expect(view().querySelector("[data-search-updating]")).toBeNull();
});

test("a held row cannot be opened while a refinement is still in flight", async () => {
  /* The rows stay on screen through a refinement so the list never blanks —
     but they answer the PREVIOUS query. Enter is this palette's primary
     action, so a held row that is still activatable opens a conversation the
     operator has already typed past. */
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  answer = async (url) => {
    if (url.includes("q=heliotropes")) {
      await gate;
      return Response.json(page({
        items: [row({ transcriptPath: "/sessions/refined.jsonl", title: "Refined match" })],
        total: 1,
      }));
    }
    return Response.json(page({ items: [row()], total: 1 }));
  };
  await mount();

  type("heliotrope");
  await settle();
  expect(view().querySelector("[data-search-result]")).not.toBeNull();

  type("heliotropes");
  /* Inside the debounce window: the newer query has not even been asked yet. */
  await settle(50);
  expect(view().querySelector("[data-search-result]")?.textContent).toContain("Heliotrope rollout");
  expect(view().querySelector<HTMLElement>("[data-search-result]")?.getAttribute("aria-disabled")).toBe("true");
  expect(view().querySelector("[data-search-stale]")).not.toBeNull();
  click("[data-search-result]");
  press("Enter");
  expect(opened).toEqual([]);
  expect(closed).toBe(0);

  /* Past the debounce, with the request in flight: same refusal. */
  await settle();
  expect(view().querySelector("[data-search-stale]")).not.toBeNull();
  click("[data-search-result]");
  expect(opened).toEqual([]);

  release();
  await settle(50);
  /* The answer lands and the list is trustworthy again. */
  expect(view().querySelectorAll("[data-search-stale]")).toHaveLength(0);
  expect(view().querySelector<HTMLElement>("[data-search-result]")?.getAttribute("aria-disabled")).toBeNull();
  click("[data-search-result]");
  expect(opened).toEqual(["/sessions/refined.jsonl"]);
  expect(closed).toBe(1);
});

test("flipping Everything → My holds the agent's rows honestly and refuses to open one", async () => {
  /* The narrowing flip is the sharper case: the toggle already reads «my
     messages» while the rows on screen are still the agent's. They must keep
     saying whose they are, and none of them may be opened under a scope that
     no longer includes it. */
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  answer = async (url) => {
    if (url.includes("speaker=user")) {
      await gate;
      return Response.json(page({ items: [row()], total: 1 }));
    }
    return Response.json(page({
      items: [row({ speaker: "assistant", transcriptPath: "/sessions/gamma.jsonl", byteOffset: 90, title: "Agent reply" })],
      total: 1,
    }));
  };
  await mount();

  click('[data-search-scope="everything"]');
  type("heliotrope");
  await settle();
  expect(view().querySelector("[data-search-result]")?.textContent).toContain("agent");

  click('[data-search-scope="mine"]');
  await settle(50);

  const held = view().querySelector<HTMLElement>("[data-search-result]")!;
  expect(held.getAttribute("data-search-result")).toBe("/sessions/gamma.jsonl");
  /* Still labelled the agent's — the chip follows the answer on screen, not
     the toggle that has moved ahead of it. */
  expect(held.textContent).toContain("agent");
  expect(held.getAttribute("aria-disabled")).toBe("true");
  click("[data-search-result]");
  press("Enter");
  expect(opened).toEqual([]);
  expect(closed).toBe(0);

  release();
  await settle(50);
  const fresh = view().querySelector<HTMLElement>("[data-search-result]")!;
  expect(fresh.getAttribute("data-search-result")).toBe("/sessions/alpha.jsonl");
  /* In «my messages» every row is the operator's, so no chip claims otherwise. */
  expect(fresh.textContent).not.toContain("agent");
  click("[data-search-result]");
  expect(opened).toEqual(["/sessions/alpha.jsonl"]);
});

test("clearing the query returns the palette to its opening state", async () => {
  /* The empty-query state is a designed one: it must not keep the last
     answer's rows underneath the hint. */
  answer = async () => Response.json(page({ items: [row()], total: 1 }));
  await mount();

  type("heliotrope");
  await settle();
  expect(view().querySelector("[data-search-result]")).not.toBeNull();

  type("");
  await settle(50);
  expect(view().querySelectorAll("[data-search-result]")).toHaveLength(0);
  expect(view().querySelector("[data-search-hint]")).not.toBeNull();
});

test("a zero answer names the corpus it searched and offers the wider scope", async () => {
  answer = async () => Response.json(page({ items: [], total: 0 }));
  await mount();

  type("nothingmatchesthis");
  await settle();

  const empty = view().querySelector<HTMLElement>("[data-search-empty]")!;
  expect(empty.textContent).toContain("nothingmatchesthis");
  expect(view().querySelector("[data-search-corpus]")?.textContent).toContain("4,310 messages");
  expect(view().querySelector("[data-search-corpus]")?.textContent).toContain("12 conversations");

  /* One tap widens to every speaker and requeries. */
  click("[data-search-widen]");
  await settle(50);
  expect(view().querySelector<HTMLElement>('[data-search-scope="everything"]')?.getAttribute("aria-checked")).toBe("true");
  expect(requests.at(-1)).not.toContain("speaker=");
});

test("a failed search says so and retries on demand", async () => {
  let attempts = 0;
  answer = async () => {
    attempts += 1;
    return attempts === 1 ? new Response("boom", { status: 500 }) : Response.json(page({ items: [row()], total: 1 }));
  };
  await mount();

  type("heliotrope");
  await settle();

  expect(view().querySelector("[data-search-error]")?.textContent).toContain("Search failed");
  expect(view().querySelector("[data-search-result]")).toBeNull();

  click("[data-search-retry]");
  await settle(50);

  expect(view().querySelector("[data-search-error]")).toBeNull();
  expect(view().querySelector("[data-search-result]")).not.toBeNull();
});

test("a paginated answer appends the next page and Enter on the last option fetches it", async () => {
  answer = async (url) => url.includes("cursor=")
    ? Response.json(page({ items: [row({ transcriptPath: "/sessions/beta.jsonl", byteOffset: 40, title: "Page two" })], total: 2 }))
    : Response.json(page({ items: [row()], nextCursor: "cursor-2", total: 2 }));
  await mount();

  type("heliotrope");
  await settle();

  expect(view().querySelector("[data-search-more]")).not.toBeNull();
  press("End");
  press("Enter");
  await settle(50);

  const titles = [...view().querySelectorAll("[data-search-result]")].map((node) => node.textContent);
  expect(titles.some((title) => title?.includes("Heliotrope rollout"))).toBe(true);
  expect(titles.some((title) => title?.includes("Page two"))).toBe(true);
  expect(view().querySelector("[data-search-more]")).toBeNull();
  /* Paging is not selecting: nothing was handed over to open. */
  expect(opened).toEqual([]);
  expect(dom.location.hash).toBe("");
});

test("Escape and the backdrop both dismiss the palette", async () => {
  await mount();

  act(() => {
    dispatch(dom as unknown as EventTarget, new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(closed).toBe(1);

  const backdrop = view().querySelector<HTMLElement>("[data-global-search-backdrop]")!;
  act(() => {
    dispatch(backdrop, new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  expect(closed).toBe(2);
});

test("Tab cannot walk out of the dialog while results are on screen", async () => {
  answer = async () => Response.json(page({ items: [row()], nextCursor: "cursor-2", total: 2 }));
  await mount();

  type("heliotrope");
  await settle();
  expect(view().querySelector("[data-search-result]")).not.toBeNull();
  expect(view().querySelector("[data-search-more]")).not.toBeNull();

  /* Rows and Load more are `role="option"` driven by aria-activedescendant, so
     they carry tabIndex={-1} and the browser skips them. The trap has to wrap
     at the last GENUINELY tabbable control — counting a row as the boundary let
     Tab past the real last control and out of the open dialog. */
  const input = view().querySelector<HTMLInputElement>("[data-search-input]")!;
  const close = view().querySelector<HTMLElement>("[data-search-close]")!;

  act(() => { close.focus(); });
  const forward = new dom.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { dispatch(dom as unknown as EventTarget, forward); });
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);

  const backward = new dom.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  act(() => { dispatch(dom as unknown as EventTarget, backward); });
  expect(backward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(close);
});

test("the scope toggle rides the header on desktop and its own row on a phone", async () => {
  await mount();
  expect(view().querySelector("header [data-search-scope]")).not.toBeNull();

  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  await mount(true);
  /* The phone's one deviation: at 390px the header cannot hold the field, the
     scope pair and close at 44px each. */
  expect(view().querySelector("header [data-search-scope]")).toBeNull();
  expect(view().querySelector("[data-search-scope]")).not.toBeNull();
});

test("in Everything mode every row says who wrote it", async () => {
  answer = async () => Response.json(page({
    items: [row(), row({ speaker: "assistant", byteOffset: 90, title: "Agent reply" })],
    total: 2,
  }));
  await mount();

  type("heliotrope");
  await settle();
  click('[data-search-scope="everything"]');
  await settle(50);

  const rows = [...view().querySelectorAll("[data-search-result]")];
  expect(requests.at(-1)).not.toContain("speaker=");
  expect(rows[0]?.textContent).toContain("you");
  expect(rows[1]?.textContent).toContain("agent");
});

test("the phone layout keeps every control at a 44px target", async () => {
  answer = async () => Response.json(page({ items: [row()], total: 1 }));
  await mount(true);

  type("heliotrope");
  await settle();

  expect(view().querySelector<HTMLElement>("[data-search-input]")!.className).toContain("h-11");
  expect(view().querySelector<HTMLElement>("[data-search-close]")!.className).toContain("h-11");
  expect(view().querySelector<HTMLElement>('[data-search-scope="mine"]')!.className).toContain("min-h-11");
  expect(view().querySelector<HTMLElement>("[data-search-result]")!.className).toContain("min-h-11");
});

test("the desktop palette hangs from a fixed top edge, so the input never moves under the caret", async () => {
  /* The dialog's height is content-driven: short on the opening hint, at its
     cap once results land, short again on a zero answer. Centred, it would
     drag the header — and the caret in the input the operator is typing into —
     up and down at exactly those transitions. happy-dom runs no layout engine,
     so the anchor is asserted where it is expressed: geometry classes that are
     the same whatever the answer is. */
  let items: TranscriptSearchRow[] = [];
  answer = async () => Response.json(page({ items, total: items.length }));
  await mount();

  const geometry = () => view().querySelector<HTMLElement>("[data-global-search]")!.className;
  const opening = geometry();
  expect(opening).toContain("mt-[10vh]");
  expect(opening).toContain("self-start");
  /* `m-auto` is what centred it. */
  expect(opening.split(" ")).not.toContain("m-auto");

  items = [row()];
  type("heliotrope");
  await settle();
  expect(view().querySelector("[data-search-result]")).not.toBeNull();
  expect(geometry()).toBe(opening);

  items = [];
  type("nothingmatchesthis");
  await settle();
  expect(view().querySelector("[data-search-empty]")).not.toBeNull();
  expect(geometry()).toBe(opening);

  /* The phone keeps the whole viewport, so it has nothing to anchor. */
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  await mount(true);
  expect(geometry()).toContain("h-full");
  expect(geometry()).not.toContain("mt-[");
});
