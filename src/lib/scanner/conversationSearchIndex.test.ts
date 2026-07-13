import { expect, test } from "bun:test";

import type { ConversationCatalogEntry } from "./conversationCatalog";
import { conversationSearchCacheStats, indexConversationCatalog, pruneConversationSearchCache } from "./conversationSearchIndex";

function entry(index: number): ConversationCatalogEntry {
  return {
    path: `/search-index/${index}.jsonl`,
    root: "codex-sessions",
    name: `${index}.jsonl`,
    project: "viewer",
    title: `Catalog ${index}`,
    firstPrompt: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: index,
    size: 100 + index,
  };
}

test("uncapped search indexing yields in batches and reuses unchanged transcript text", async () => {
  const catalog = Array.from({ length: 55 }, (_, index) => entry(index));
  const reads: string[] = [];
  let yields = 0;
  const readText = (pathname: string) => {
    reads.push(pathname);
    return { title: `Indexed ${pathname}`, firstPrompt: `Prompt ${pathname}` };
  };
  const yieldControl = async () => { yields += 1; };

  const first = await indexConversationCatalog(catalog, { readText, yieldControl, batchSize: 10 });
  expect(reads).toHaveLength(55);
  expect(yields).toBe(5);
  expect(first[54]).toMatchObject({ title: "Indexed /search-index/54.jsonl", firstPrompt: "Prompt /search-index/54.jsonl" });

  reads.length = 0;
  yields = 0;
  await indexConversationCatalog(catalog, { readText, yieldControl, batchSize: 10 });
  expect(reads).toHaveLength(0);
  expect(yields).toBe(5);
});

test("search indexing prunes cached transcripts outside the current catalog", async () => {
  const catalog = [entry(1001), entry(1002)];
  const reads: string[] = [];
  const readText = (pathname: string) => {
    reads.push(pathname);
    return { title: pathname, firstPrompt: pathname };
  };
  const options = { readText, yieldControl: async () => {} };

  await indexConversationCatalog(catalog, options);
  reads.length = 0;
  pruneConversationSearchCache(new Set([catalog[1]!.path]));
  await indexConversationCatalog(catalog, options);
  expect(reads).toEqual([catalog[0]!.path]);
});

test("search indexing caches text only after hydration succeeds", async () => {
  const catalog = [entry(1501)];
  let reads = 0;
  const readText = () => {
    reads += 1;
    if (reads === 1) throw new Error("transient read failure");
    return { title: "Recovered title", firstPrompt: "Recovered prompt" };
  };
  const options = { readText, yieldControl: async () => {} };

  await expect(indexConversationCatalog(catalog, options)).rejects.toThrow("transient read failure");
  const recovered = await indexConversationCatalog(catalog, options);
  const cached = await indexConversationCatalog(catalog, options);

  expect(recovered[0]).toMatchObject({ title: "Recovered title", firstPrompt: "Recovered prompt" });
  expect(cached[0]).toMatchObject({ title: "Recovered title", firstPrompt: "Recovered prompt" });
  expect(reads).toBe(2);
});

test("search indexing evicts prompt text beyond its byte budget", async () => {
  const catalog = [entry(2001), entry(2002)];
  const reads: string[] = [];
  const readText = (pathname: string) => {
    reads.push(pathname);
    return { title: pathname, firstPrompt: "x".repeat(80) };
  };
  const options = { readText, yieldControl: async () => {}, maxCacheBytes: 200 };

  await indexConversationCatalog(catalog, options);
  reads.length = 0;
  await indexConversationCatalog(catalog, options);

  expect(reads.length).toBeGreaterThan(0);
});

test("a full scan reuses retained entries when the catalog exceeds the entry cap", async () => {
  const catalog = Array.from({ length: 4 }, (_, index) => entry(3000 + index));
  const reads: string[] = [];
  const readText = (pathname: string) => {
    reads.push(pathname);
    return { title: pathname, firstPrompt: pathname };
  };
  const options = { readText, yieldControl: async () => {}, maxCacheBytes: 1_000_000, maxCacheEntries: 2 };

  await indexConversationCatalog(catalog, options);
  reads.length = 0;
  await indexConversationCatalog(catalog, options);

  expect(reads).toEqual(catalog.slice(2).map((item) => item.path));
});

test("superseded search waiters abort while one catalog projection remains reusable", async () => {
  const catalog = [entry(4001), entry(4002)];
  const reads: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let yields = 0;
  const options = {
    readText: (pathname: string) => {
      reads.push(pathname);
      return { title: pathname, firstPrompt: pathname };
    },
    yieldControl: async () => { if (yields++ === 0) await gate; },
    batchSize: 1,
    reuseProjection: true,
  };

  const first = indexConversationCatalog(catalog, options);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const superseded = indexConversationCatalog(catalog, { ...options, signal: controller.signal });
  controller.abort();
  await expect(superseded).rejects.toHaveProperty("name", "AbortError");

  release();
  const projected = await first;
  const reused = await indexConversationCatalog(catalog, options);
  expect(reused).toBe(projected);
  expect(reads).toHaveLength(catalog.length);
});

test("a superseded build leaves cache byte accounting exact", async () => {
  const firstCatalog = [entry(5001), entry(5002)];
  const secondCatalog = [entry(6001), entry(6002)];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const readText = (pathname: string) => ({ title: pathname, firstPrompt: "x".repeat(40) });
  let yields = 0;
  const first = indexConversationCatalog(firstCatalog, {
    readText,
    yieldControl: async () => { if (yields++ === 0) await gate; },
    batchSize: 1,
    maxCacheBytes: 400,
    reuseProjection: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = indexConversationCatalog(secondCatalog, {
    readText,
    yieldControl: async () => {},
    batchSize: 1,
    maxCacheBytes: 400,
    reuseProjection: true,
  });
  release();

  await expect(first).rejects.toHaveProperty("name", "AbortError");
  await second;
  const stats = conversationSearchCacheStats();
  expect(stats.trackedBytes).toBe(stats.computedBytes);
  expect(stats.trackedBytes).toBeLessThanOrEqual(400);
});

test("a full-catalog projection beyond its hard entry ceiling is never retained", async () => {
  const catalog = Array.from({ length: 2_049 }, (_, index) => entry(7000 + index));
  let reads = 0;
  const options = {
    readText: (pathname: string) => {
      reads += 1;
      return { title: pathname, firstPrompt: pathname };
    },
    yieldControl: async () => {},
    reuseProjection: true,
    maxProjectionEntries: 2_048,
  };

  await indexConversationCatalog(catalog, options);
  const firstReads = reads;
  await indexConversationCatalog(catalog, options);

  expect(reads).toBeGreaterThan(firstReads);
});
