import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { TranscriptSearchRow } from "@/app/api/search/transcripts/route";

/*
 * Issue #1429 — what the palette's hook asks the server, and when.
 *
 * The server answers a first page synchronously on the Viewer's only thread,
 * so a request the browser abandons is still paid for there. These tests pin
 * the request discipline that keeps that cost bounded: one first page in
 * flight, refinements typed meanwhile never abort it and never fan out, and
 * only the newest question follows once it answers. Counts and URLs only —
 * nothing here asserts a duration.
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
  Element: dom.Element,
  Event: dom.Event,
});

const { createRoot } = await import("react-dom/client");
const { TRANSCRIPT_SEARCH_DEBOUNCE_MS, useTranscriptSearch } = await import("./useTranscriptSearch");
type Search = ReturnType<typeof useTranscriptSearch>;

interface Page {
  items: TranscriptSearchRow[];
  nextCursor: string | null;
  total: number;
  stats: { conversationsIndexed: number; messagesIndexed: number; fieldsSearched: string[]; tokenizer: string };
}

function row(over: Partial<TranscriptSearchRow> = {}): TranscriptSearchRow {
  return {
    snippet: "heliotrope totals",
    speaker: "user",
    timestamp: 1_700_000_000,
    transcriptPath: "/sessions/alpha.jsonl",
    byteOffset: 0,
    lineNumber: 1,
    project: "reports",
    engine: "claude",
    title: "Weekly totals",
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

/** One request the hook has issued and the test has not yet answered. */
interface Pending {
  url: string;
  signal: AbortSignal;
  answer: (page: Page) => void;
}

let pending: Pending[] = [];
let latest: Search | null = null;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({ query, speaker }: { query: string; speaker?: "user" }) {
  latest = useTranscriptSearch({ query, speaker });
  return null;
}

beforeEach(() => {
  pending = [];
  latest = null;
  Object.assign(globalThis, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/search/transcripts")) return Promise.resolve(Response.json({}));
      return new Promise<Response>((resolve, reject) => {
        /* A real fetch rejects when its signal aborts; the stub must too, or
           an aborted request would hang forever instead of settling. */
        const signal = init!.signal!;
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        pending.push({ url, signal, answer: (answered) => resolve(Response.json(answered)) });
      });
    },
  });
});

afterEach(async () => {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => mounted.unmount());
  host?.remove();
  host = null;
});

async function render(props: { query: string; speaker?: "user" }) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const mounted = root;
  await act(async () => {
    mounted.render(<Harness {...props} />);
  });
}

async function settle(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function answer(request: Pending, answered: Page) {
  await act(async () => {
    request.answer(answered);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test("a refinement waits for the answer in flight instead of aborting it, and only the newest question follows", async () => {
  await render({ query: "heliotrope", speaker: "user" });
  await settle(10);
  expect(pending).toHaveLength(1);
  const first = pending[0]!;

  /* Two refinements, each past its own debounce, while the first request is
     still unanswered. */
  await render({ query: "heliotropes", speaker: "user" });
  await settle(TRANSCRIPT_SEARCH_DEBOUNCE_MS + 50);
  await render({ query: "heliotropes again", speaker: "user" });
  await settle(TRANSCRIPT_SEARCH_DEBOUNCE_MS + 50);

  expect(pending).toHaveLength(1);
  expect(first.signal.aborted).toBe(false);
  expect(latest!.loading).toBe(true);

  await answer(first, page({ items: [row()], total: 1 }));

  /* Exactly one more request, for the question the operator ended on; the
     intermediate one was never asked. */
  expect(pending).toHaveLength(2);
  expect(pending[1]!.url).toContain("q=heliotropes+again");
  /* Meanwhile the first answer holds on screen as rows that must not be
     activated. */
  expect(latest!.items).toHaveLength(1);
  expect(latest!.stale).toBe(true);
  expect(latest!.loading).toBe(true);

  await answer(pending[1]!, page({ items: [row({ title: "Final" })], total: 1 }));

  expect(pending).toHaveLength(2);
  expect(latest!.stale).toBe(false);
  expect(latest!.loading).toBe(false);
  expect(latest!.items.map((item) => item.title)).toEqual(["Final"]);
});

test("unmounting is the one thing that aborts a search in flight", async () => {
  await render({ query: "heliotrope", speaker: "user" });
  await settle(10);
  const first = pending[0]!;
  expect(first.signal.aborted).toBe(false);

  const mounted = root!;
  root = null;
  await act(async () => mounted.unmount());

  expect(first.signal.aborted).toBe(true);
});

test("retry asks the same question again, and a speaker flip asks it at once", async () => {
  await render({ query: "heliotrope", speaker: "user" });
  await settle(10);
  await answer(pending[0]!, page({ items: [row()], total: 1 }));
  expect(pending).toHaveLength(1);

  await act(async () => { latest!.retry(); });
  await settle(10);
  expect(pending).toHaveLength(2);
  expect(pending[1]!.url).toBe(pending[0]!.url);
  await answer(pending[1]!, page({ items: [row()], total: 1 }));

  await render({ query: "heliotrope" });
  await settle(10);
  expect(pending).toHaveLength(3);
  expect(pending[2]!.url).not.toContain("speaker=");
});

test("StrictMode's rehearsal unmount does not strand the first search", async () => {
  /* Development mounts every effect twice: the cleanup aborts the request the
     first pass started, and the second pass must ask again rather than sit
     behind a controller that will never answer. */
  const { StrictMode } = await import("react");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const mounted = root;
  await act(async () => {
    mounted.render(<StrictMode><Harness query="heliotrope" speaker="user" /></StrictMode>);
  });
  await settle(10);

  const live = pending.filter((request) => !request.signal.aborted);
  expect(live).toHaveLength(1);
  expect(latest!.loading).toBe(true);

  await answer(live[0]!, page({ items: [row()], total: 1 }));

  expect(latest!.loading).toBe(false);
  expect(latest!.items).toHaveLength(1);
  expect(pending.filter((request) => !request.signal.aborted)).toHaveLength(1);
});
