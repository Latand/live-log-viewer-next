import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useConversationCatalog, type ConversationCatalogData } from "./useConversationCatalog";
import type { FileEntry } from "@/lib/types";

const dom = new Window({ url: "http://localhost" });
const globals = globalThis as Record<string, unknown>;
const saved = new Map<string, unknown>();
const requests: { url: URL; resolve: (response: Response) => void; signal: AbortSignal }[] = [];
let root: Root;
let result: ConversationCatalogData;
let props: Parameters<typeof useConversationCatalog>[0];
function Harness() { result = useConversationCatalog(props); return null; }
const tick = async () => { await new Promise((r) => setTimeout(r, 15)); };
const row = (path: string, conversationId = path) => ({ path, conversationId, title: "Same title", mtime: 1 }) as FileEntry;
const answer = (index: number, items: FileEntry[], nextCursor: string | null, status = 200) => {
  requests[index]!.resolve(new Response(JSON.stringify({ items, nextCursor, total: 45 }), { status }));
};
function render(next: typeof props) { props = next; flushSync(() => root.render(<Harness />)); }
async function start(next: typeof props = { project: "a", pageSize: 20 }) {
  requests.length = 0;
  root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
  render(next); await tick();
}
beforeAll(() => {
  const overrides = { window: dom, document: dom.document, navigator: dom.navigator,
    fetch: (input: string, init: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ url: new URL(input, "http://localhost"), resolve, signal: init.signal! });
    }) };
  for (const [key, value] of Object.entries(overrides)) { saved.set(key, globals[key]); globals[key] = value; }
});
afterEach(async () => { flushSync(() => root?.unmount()); await tick(); });
afterAll(() => { for (const [key, value] of saved) globals[key] = value; });

test("20/20/5 with one in-flight cursor, within-page duplicates and historical generations preserved", async () => {
  await start();
  expect(requests[0]!.url.searchParams.get("limit")).toBe("20");
  const first = Array.from({ length: 20 }, (_, n) => row(`p${n}`, "shared-generation-id"));
  answer(0, first, "opaque+cursor/20"); await tick();
  flushSync(() => { result.loadMore(); result.loadMore(); }); await tick();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url.searchParams.get("cursor")).toBe("opaque+cursor/20");
  render({ ...props }); // an unrelated files poll must not restart discovery
  const second = Array.from({ length: 20 }, (_, n) => row(`p${n + 20}`));
  answer(1, [first[19]!, ...second, second[0]!], "cursor40"); await tick();
  expect(result.items.map((item) => item.path)).toEqual([...first, ...second].map((item) => item.path));
  result.loadMore(); await tick();
  answer(2, Array.from({ length: 5 }, (_, n) => row(`p${n + 40}`)), null); await tick();
  expect(result.items).toHaveLength(45);
  expect(result.nextCursor).toBeNull();
  result.loadMore(); await tick(); expect(requests).toHaveLength(3);
});

test("append failure retries same cursor; expiry retains rows until explicit coherent refresh", async () => {
  await start(); answer(0, [row("old")], "c1"); await tick();
  result.loadMore(); await tick(); answer(1, [], null, 500); await tick();
  expect(result.items.map((x) => x.path)).toEqual(["old"]);
  expect(result.error).toBe(true);
  result.loadMore(); await tick(); expect(requests).toHaveLength(2);
  result.retry(); await tick(); expect(requests[2]!.url.searchParams.get("cursor")).toBe("c1");
  answer(2, [], null, 409); await tick();
  expect(result.expired).toBe(true); expect(result.items[0]!.path).toBe("old");
  expect(requests).toHaveLength(3);
  result.retry(); await tick(); expect(requests[3]!.url.searchParams.has("cursor")).toBe(false);
  expect(result.items[0]!.path).toBe("old");
  answer(3, [], null, 500); await tick(); expect(result.items[0]!.path).toBe("old");
  result.retry(); await tick(); expect(requests[4]!.url.searchParams.has("cursor")).toBe(false); answer(4, [row("new")], null); await tick();
  expect(result.items.map((x) => x.path)).toEqual(["new"]);
});

test("A to B to A rejects late aborted pages and preserves A's chain", async () => {
  await start(); answer(0, [row("a")], "a20"); await tick();
  result.loadMore(); await tick();
  render({ project: "b", pageSize: 20 }); await tick();
  render({ project: "a", pageSize: 20 }); await tick();
  expect(requests[1]!.signal.aborted).toBe(true);
  answer(1, [row("stale-a")], null); answer(2, [row("b")], null); await tick();
  expect(result.items.map((x) => x.path)).toEqual(["a"]);
  expect(result.nextCursor).toBe("a20");
  result.loadMore(); await tick(); expect(requests[3]!.url.searchParams.get("cursor")).toBe("a20");
});

test("collapse/reopen preserves pages; empty hydrated page continues; desktop defaults to forty", async () => {
  await start({ project: "desktop" });
  expect(requests[0]!.url.searchParams.get("limit")).toBe("40");
  answer(0, [], "empty-next"); await tick();
  render({ ...props, enabled: false }); await tick(); render({ ...props, enabled: true }); await tick();
  expect(requests).toHaveLength(1);
  expect(result.nextCursor).toBe("empty-next");
  result.loadMore(); await tick(); answer(1, [row("after-empty")], null); await tick();
  expect(result.items[0]!.path).toBe("after-empty");
});

test("query debounce fences old scope immediately and page size owns a distinct chain", async () => {
  await start();
  render({ project: undefined, query: "search", pageSize: 20 });
  answer(0, [row("wrong")], null); await tick();
  expect(result.items).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 260));
  expect(requests[1]!.url.searchParams.get("q")).toBe("search");
  expect(requests[1]!.url.searchParams.has("project")).toBe(false);
  answer(1, [row("search-result")], null); await tick();
  render({ ...props, pageSize: 40 }); await tick();
  expect(result.items).toHaveLength(0);
  expect(requests[2]!.url.searchParams.get("limit")).toBe("40");
});

test("initial failure is retryable and never a known empty catalog", async () => {
  await start(); answer(0, [], null, 500); await tick();
  expect(result.known).toBe(false); expect(result.error).toBe(true); expect(result.loading).toBe(false);
  result.retry(); await tick(); answer(1, [], null); await tick();
  expect(result.known).toBe(true); expect(result.error).toBe(false);
});

test("an aborted initial retry remains retryable when its Home is reopened", async () => {
  await start(); answer(0, [], null, 500); await tick();
  result.retry(); await tick(); render({ ...props, enabled: false }); await tick();
  answer(1, [row("late")], null); await tick();
  render({ ...props, enabled: true }); await tick();
  expect(result.error).toBe(true); expect(result.known).toBe(false);
  result.retry(); await tick(); answer(2, [row("recovered")], null); await tick();
  expect(result.items[0]!.path).toBe("recovered");
});

test("identical global queries retain separate snapshots for their owning Home projects", async () => {
  await start({ query: "global", scopeKey: "a", pageSize: 20 });
  answer(0, [row("a-snapshot")], "a20"); await tick();
  render({ ...props, scopeKey: "b" }); await tick();
  expect(result.items).toHaveLength(0);
  answer(1, [row("b-snapshot")], null); await tick();
  render({ ...props, scopeKey: "a" }); await tick();
  expect(result.items[0]!.path).toBe("a-snapshot");
  expect(result.nextCursor).toBe("a20");
});
