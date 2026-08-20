import { expect, test } from "bun:test";

import type { TranscriptSearchRow } from "@/app/api/search/transcripts/route";

import {
  mergeTranscriptSearchPage,
  TRANSCRIPT_SEARCH_DEBOUNCE_MS,
  TRANSCRIPT_SEARCH_PAGE_SIZE,
  TranscriptSearchRequestError,
  transcriptSearchCursorRejected,
  transcriptSearchRequestDelay,
  transcriptSearchRowKey,
  transcriptSearchUrl,
  type TranscriptSearchPage,
} from "./useTranscriptSearch";

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

function page(over: Partial<TranscriptSearchPage> = {}): TranscriptSearchPage {
  return { items: [], nextCursor: null, total: 0, stats: null, ...over };
}

test("the request searches every project and defaults nothing about the speaker", () => {
  const mine = transcriptSearchUrl("  heliotrope  ", "user");
  const everything = transcriptSearchUrl("heliotrope", undefined);

  expect(mine).toBe(`/api/search/transcripts?q=heliotrope&limit=${TRANSCRIPT_SEARCH_PAGE_SIZE}&speaker=user`);
  /* No `project` param on either request: one search across all projects,
     accounts and engines is the whole point of the surface. */
  expect(everything).toBe(`/api/search/transcripts?q=heliotrope&limit=${TRANSCRIPT_SEARCH_PAGE_SIZE}`);
  expect(everything).not.toContain("speaker");
  expect(transcriptSearchUrl("heliotrope", "user", "cursor-1")).toContain("cursor=cursor-1");
});

test("typing waits out the debounce while a speaker flip requeries at once", () => {
  expect(transcriptSearchRequestDelay("", "heli")).toBe(TRANSCRIPT_SEARCH_DEBOUNCE_MS);
  expect(transcriptSearchRequestDelay("heliotrope", "heliotrope")).toBe(0);
});

test("only a rejected cursor restarts the query at page one", () => {
  expect(transcriptSearchCursorRejected(new TranscriptSearchRequestError(400))).toBe(true);
  expect(transcriptSearchCursorRejected(new TranscriptSearchRequestError(500))).toBe(false);
  expect(transcriptSearchCursorRejected(new Error("network"))).toBe(false);
});

test("two matches inside one conversation stay two distinct rows", () => {
  const first = row({ byteOffset: 0 });
  const second = row({ byteOffset: 512 });

  expect(transcriptSearchRowKey(first)).not.toBe(transcriptSearchRowKey(second));
});

test("a following page appends without repeating a row the list already shows", () => {
  const current = page({ items: [row({ byteOffset: 0 }), row({ byteOffset: 512 })], nextCursor: "c1", total: 3 });
  const next = page({
    items: [row({ byteOffset: 512 }), row({ byteOffset: 900 })],
    nextCursor: null,
    total: 3,
    stats: { conversationsIndexed: 4, messagesIndexed: 9, fieldsSearched: ["message.body"], tokenizer: "t" },
  });

  const merged = mergeTranscriptSearchPage(current, next);

  expect(merged.items.map((item) => item.byteOffset)).toEqual([0, 512, 900]);
  expect(merged.nextCursor).toBeNull();
  expect(merged.total).toBe(3);
  expect(merged.stats?.messagesIndexed).toBe(9);
});

test("a page that carries no stats keeps the corpus totals already known", () => {
  const current = page({
    items: [row()],
    stats: { conversationsIndexed: 4, messagesIndexed: 9, fieldsSearched: ["message.body"], tokenizer: "t" },
  });

  expect(mergeTranscriptSearchPage(current, page()).stats?.conversationsIndexed).toBe(4);
});
