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
  if (!response.ok) throw new Error(`conversation catalog request failed: ${response.status}`);
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
  const requestKey = `${project ?? ""}\u0000${query}`;
  const [settled, setSettled] = useState<SettledCatalogRequest>({
    key: "",
    page: EMPTY_PAGE,
    error: false,
  });
  const [moreRequest, setMoreRequest] = useState<MoreRequest | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetchConversationPage(project, query, null, controller.signal)
      .then((result) => setSettled({ key: requestKey, page: result, error: false }))
      .catch((cause: unknown) => {
        if ((cause as { name?: string }).name !== "AbortError") {
          setSettled({ key: requestKey, page: EMPTY_PAGE, error: true });
        }
      });
    return () => controller.abort();
  }, [project, query, enabled, requestKey]);

  useEffect(() => {
    if (!moreRequest || moreRequest.key !== requestKey) return;
    const controller = new AbortController();
    void fetchConversationPage(project, query, moreRequest.cursor, controller.signal)
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
        if ((cause as { name?: string }).name !== "AbortError") {
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
  }, [moreRequest, project, query, requestKey]);

  const current = enabled && settled.key === requestKey ? settled : null;
  const page = current?.page ?? EMPTY_PAGE;
  const loading = enabled && (current === null || moreRequest?.key === requestKey);
  const error = current?.error ?? false;

  const loadMore = useCallback(() => {
    if (!loading && page.nextCursor) setMoreRequest({ key: requestKey, cursor: page.nextCursor });
  }, [loading, page.nextCursor, requestKey]);

  return { ...page, loading, error, loadMore };
}
