"use client";

import { useCallback, useEffect, useState } from "react";

import type { FileEntry } from "@/lib/types";

interface ConversationPage {
  items: FileEntry[];
  nextCursor: string | null;
  total: number;
}

interface ConversationCatalogData extends ConversationPage {
  loading: boolean;
  error: boolean;
  loadMore: () => void;
  retry: () => void;
}

interface SettledCatalogRequest {
  key: string;
  page: ConversationPage;
  error: boolean;
}

interface MoreRequest {
  key: string;
  cursor: string;
}

const EMPTY_PAGE: ConversationPage = { items: [], nextCursor: null, total: 0 };
export const CONVERSATION_SEARCH_DEBOUNCE_MS = 250;

export function conversationCatalogRequestDelay(currentQuery: string, nextQuery: string): number {
  return currentQuery === nextQuery ? 0 : CONVERSATION_SEARCH_DEBOUNCE_MS;
}

export class ConversationCatalogRequestError extends Error {
  constructor(readonly status: number) {
    super(`conversation catalog request failed: ${status}`);
    this.name = "ConversationCatalogRequestError";
  }
}

export function conversationCatalogCursorExpired(cause: unknown): boolean {
  return cause instanceof ConversationCatalogRequestError && cause.status === 409;
}

function conversationCatalogUrl(project: string | undefined, query: string, cursor?: string | null): string {
  const params = new URLSearchParams({ limit: "40" });
  if (project) params.set("project", project);
  if (query.trim()) params.set("q", query.trim());
  if (cursor) params.set("cursor", cursor);
  return `/api/conversations?${params}`;
}

async function fetchConversationPage(
  project: string | undefined,
  query: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ConversationPage> {
  const response = await fetch(conversationCatalogUrl(project, query, cursor), { signal });
  if (!response.ok) throw new ConversationCatalogRequestError(response.status);
  return response.json() as Promise<ConversationPage>;
}

export function useConversationCatalog({
  project,
  query = "",
  enabled = true,
}: {
  project?: string;
  query?: string;
  enabled?: boolean;
}): ConversationCatalogData {
  const [request, setRequest] = useState({ project, query });
  useEffect(() => {
    if (query === request.query && project === request.project) return;
    const delay = conversationCatalogRequestDelay(request.query, query);
    const timer = window.setTimeout(() => setRequest({ project, query }), delay);
    return () => window.clearTimeout(timer);
  }, [project, query, request.project, request.query]);
  const requestKey = `${request.project ?? ""}\u0000${request.query}`;
  const [settled, setSettled] = useState<SettledCatalogRequest>({
    key: "",
    page: EMPTY_PAGE,
    error: false,
  });
  const [moreRequest, setMoreRequest] = useState<MoreRequest | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetchConversationPage(request.project, request.query, null, controller.signal)
      .then((result) => setSettled({ key: requestKey, page: result, error: false }))
      .catch((cause: unknown) => {
        if ((cause as { name?: string }).name !== "AbortError") {
          setSettled({ key: requestKey, page: EMPTY_PAGE, error: true });
        }
      });
    return () => controller.abort();
  }, [request.project, request.query, enabled, requestKey, retryNonce]);

  useEffect(() => {
    if (!moreRequest || moreRequest.key !== requestKey) return;
    const controller = new AbortController();
    void fetchConversationPage(request.project, request.query, moreRequest.cursor, controller.signal)
      .then((result) => {
        setSettled((current) => {
          if (current.key !== moreRequest.key) return current;
          const seen = new Set(current.page.items.map((item) => item.path));
          return {
            key: current.key,
            page: {
              items: [...current.page.items, ...result.items.filter((item) => !seen.has(item.path))],
              nextCursor: result.nextCursor,
              total: result.total,
            },
            error: false,
          };
        });
      })
      .catch((cause: unknown) => {
        if (conversationCatalogCursorExpired(cause)) {
          setRetryNonce((value) => value + 1);
        } else if ((cause as { name?: string }).name !== "AbortError") {
          setSettled((current) =>
            current.key === moreRequest.key ? { ...current, error: true } : current,
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setMoreRequest((current) => (current === moreRequest ? null : current));
        }
      });
    return () => controller.abort();
  }, [moreRequest, request.project, request.query, requestKey]);

  const current = enabled && settled.key === requestKey ? settled : null;
  const page = current?.page ?? EMPTY_PAGE;
  const loading = enabled && (current === null || moreRequest?.key === requestKey);
  const error = current?.error ?? false;

  const loadMore = useCallback(() => {
    if (!loading && page.nextCursor) setMoreRequest({ key: requestKey, cursor: page.nextCursor });
  }, [loading, page.nextCursor, requestKey]);

  const retry = useCallback(() => {
    setMoreRequest(null);
    setRetryNonce((value) => value + 1);
  }, []);

  return { ...page, loading, error, loadMore, retry };
}
