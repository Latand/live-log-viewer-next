import { expect, test } from "bun:test";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";

test("search_transcripts reads the HTTP body index with cross-project pagination arguments", async () => {
  const reads: string[] = [];
  const indexedPage = {
    items: [{
      snippet: "matched #звіт body",
      speaker: "user",
      timestamp: 1_780_000_000,
      transcriptPath: "/sessions/report.jsonl",
      byteOffset: 42,
      lineNumber: 3,
      project: "reports",
      engine: "codex",
    }],
    nextCursor: "cursor-b",
    total: 2,
    stats: {
      conversationsIndexed: 12,
      messagesIndexed: 34,
      fieldsSearched: ["message.body"],
      tokenizer: "FTS5 unicode61, remove_diacritics=0, tokenchars=#_",
    },
  };
  const control: ViewerControlDependencies = {
    get: async (pathname) => {
      reads.push(pathname);
      return indexedPage;
    },
    post: async () => ({}),
  };
  const bindings = viewerMcpBindings(undefined, control);

  const result = await bindings.search_transcripts({
    clientRequestId: "search-body-1",
    query: "#звіт",
    project: "reports",
    cursor: "cursor-a",
    limit: 25,
  });

  expect(reads).toEqual([
    "/api/search/transcripts?q=%23%D0%B7%D0%B2%D1%96%D1%82&project=reports&cursor=cursor-a&limit=25",
  ]);
  expect(result).toEqual(indexedPage);
});
