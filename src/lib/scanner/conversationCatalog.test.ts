import { expect, test } from "bun:test";

import type { ConversationCatalogEntry } from "./conversationCatalog";
import { ExpiredConversationCatalogCursorError, loadConversationCatalogPage, paginateConversationCatalog } from "./conversationCatalog";
import { schemeWindowConfig, selectSchemeWindow } from "./schemeWindow";

function entry(index: number, project = "viewer"): ConversationCatalogEntry {
  return {
    path: `/sessions/${index}.jsonl`,
    root: "codex-sessions",
    name: `${index}.jsonl`,
    project,
    title: `Conversation ${index}`,
    firstPrompt: `Prompt ${index}`,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: index,
    size: index * 100,
  };
}

test("conversation listing paginates every catalog conversation without a scheme cap", () => {
  const catalog = Array.from({ length: 7 }, (_, index) => entry(index + 1));
  const first = paginateConversationCatalog(catalog, { project: "viewer", limit: 3 });
  const second = paginateConversationCatalog(catalog, { project: "viewer", limit: 3, cursor: first.nextCursor });
  const third = paginateConversationCatalog(catalog, { project: "viewer", limit: 3, cursor: second.nextCursor });

  expect([...first.items, ...second.items, ...third.items].map((item) => item.path)).toEqual([
    "/sessions/7.jsonl",
    "/sessions/6.jsonl",
    "/sessions/5.jsonl",
    "/sessions/4.jsonl",
    "/sessions/3.jsonl",
    "/sessions/2.jsonl",
    "/sessions/1.jsonl",
  ]);
  expect(first.nextCursor).toBeString();
  expect(second.nextCursor).toBeString();
  expect(third.nextCursor).toBeNull();
  expect(first.total).toBe(7);
});

test("pagination keeps its original rows when mtimes refresh between pages", () => {
  const catalog = Array.from({ length: 7 }, (_, index) => entry(index + 1));
  const first = paginateConversationCatalog(catalog, { limit: 3 });
  const refreshed = catalog.map((item) => item.path === "/sessions/4.jsonl" ? { ...item, mtime: 100 } : item);
  const second = paginateConversationCatalog(refreshed, { limit: 3, cursor: first.nextCursor });
  const third = paginateConversationCatalog(refreshed, { limit: 3, cursor: second.nextCursor });

  expect([...first.items, ...second.items, ...third.items].map((item) => item.path)).toEqual([
    "/sessions/7.jsonl",
    "/sessions/6.jsonl",
    "/sessions/5.jsonl",
    "/sessions/4.jsonl",
    "/sessions/3.jsonl",
    "/sessions/2.jsonl",
    "/sessions/1.jsonl",
  ]);
});

test("abandoned uncapped pagination snapshots have an aggregate row budget", () => {
  const catalog = Array.from({ length: 7_000 }, (_, index) => entry(index + 1));
  const first = paginateConversationCatalog(catalog, { limit: 1 });
  paginateConversationCatalog(catalog, { limit: 1 });
  paginateConversationCatalog(catalog, { limit: 1 });

  expect(() => paginateConversationCatalog(catalog, { limit: 1, cursor: first.nextCursor }))
    .toThrow(ExpiredConversationCatalogCursorError);
});

test("search finds a conversation excluded by the scheme project and card caps", () => {
  const catalog = [
    entry(30, "recent-a"),
    entry(29, "recent-a"),
    entry(20, "recent-b"),
    { ...entry(10, "quiet-c"), title: "Quiet title", firstPrompt: "Investigate cobalt orchard" },
  ];
  const scheme = selectSchemeWindow(catalog, (item) => item.project, { projectCap: 2, cardsPerProject: 1 });
  const result = paginateConversationCatalog(catalog, { query: "cobalt orchard", limit: 10 });

  expect(scheme.map((item) => item.path)).not.toContain("/sessions/10.jsonl");
  expect(result.items.map((item) => item.path)).toEqual(["/sessions/10.jsonl"]);
  expect(result.items[0]?.firstPrompt).toBe("");
});

test("a list page stats only the conversations returned on that page", async () => {
  const catalog = Array.from({ length: 12 }, (_, index) => entry(index + 1));
  const statPaths: string[] = [];
  const metadataPaths: string[] = [];
  const page = await loadConversationCatalogPage(catalog, { limit: 4 }, async (pathname) => {
    statPaths.push(pathname);
    return { size: 999, mtimeMs: 50_000 };
  }, async (item) => {
    metadataPaths.push(item.path);
    return { ...item, title: `Hydrated ${item.title}` };
  });

  expect(statPaths).toEqual(page.items.map((item) => item.path));
  expect(metadataPaths).toEqual(statPaths);
  expect(statPaths).toHaveLength(4);
  expect(page.items.every((item) => item.size === 999)).toBe(true);
  expect(page.items.every((item) => item.title.startsWith("Hydrated "))).toBe(true);
  expect(page.nextCursor).toBeString();
});

test("page hydration omits confirmed disappearance and surfaces transient stat failures", async () => {
  const missing = entry(1);
  const missingPage = await loadConversationCatalogPage([missing], {}, async () => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  });
  expect(missingPage.items).toEqual([]);
  expect(missingPage.total).toBe(1);

  await expect(loadConversationCatalogPage([entry(2)], {}, async () => {
    throw Object.assign(new Error("busy"), { code: "EMFILE" });
  })).rejects.toThrow("busy");
});

test("scheme project and card caps are independently configurable", () => {
  expect(schemeWindowConfig({ LLV_SCHEME_PROJECT_CAP: "3", LLV_SCHEME_CARDS_PER_PROJECT: "7" })).toEqual({
    projectCap: 3,
    cardsPerProject: 7,
  });
});
