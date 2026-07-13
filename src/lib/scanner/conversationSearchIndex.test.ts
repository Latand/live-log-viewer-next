import { expect, test } from "bun:test";

import type { ConversationCatalogEntry } from "./conversationCatalog";
import { indexConversationCatalog } from "./conversationSearchIndex";

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
