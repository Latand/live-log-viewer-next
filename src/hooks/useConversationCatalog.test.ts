import { expect, test } from "bun:test";

import { ConversationCatalogRequestError, conversationCatalogCursorExpired, conversationCatalogRequestDelay } from "./useConversationCatalog";

test("only an expired pagination snapshot requires an explicit page-one refresh", () => {
  expect(conversationCatalogCursorExpired(new ConversationCatalogRequestError(409))).toBe(true);
  expect(conversationCatalogCursorExpired(new ConversationCatalogRequestError(500))).toBe(false);
  expect(conversationCatalogCursorExpired(new Error("network"))).toBe(false);
});

test("a scope change caused by search waits for the query debounce", () => {
  expect(conversationCatalogRequestDelay("", "a")).toBe(250);
  expect(conversationCatalogRequestDelay("amber", "amber")).toBe(0);
});
