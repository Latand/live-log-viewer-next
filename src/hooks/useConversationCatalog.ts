"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FileEntry } from "@/lib/types";

interface ConversationPage {
  items: FileEntry[];
  nextCursor: string | null;
  total: number;
}

export interface ConversationCatalogData extends ConversationPage {
  loading: boolean;
  known: boolean;
  expired: boolean;
  refresh: () => void;
  error: boolean;
  loadMore: () => void;
  retry: () => void;
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

function conversationCatalogUrl(project: string | undefined, query: string, cursor: string | null, pageSize: number): string {
  const params = new URLSearchParams({ limit: String(pageSize) });
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
  pageSize: number,
): Promise<ConversationPage> {
  const response = await fetch(conversationCatalogUrl(project, query, cursor, pageSize), { signal });
  if (!response.ok) throw new ConversationCatalogRequestError(response.status);
  return response.json() as Promise<ConversationPage>;
}

interface CatalogSnapshot extends ConversationPage {
  failedCursor?: string | null;
  known: boolean;
  error: boolean;
  expired: boolean;
}

/** Each scope keeps one coherent cursor chain for this mounted consumer. */
export function useConversationCatalog({
  project, query = "", enabled = true, pageSize = 40, scopeKey,
}: {
  project?: string;
  query?: string;
  enabled?: boolean;
  pageSize?: number;
  /** The owning Home project, including when its query searches globally. */
  scopeKey?: string;
}): ConversationCatalogData {
  const key = JSON.stringify([scopeKey ?? null, project ?? null, query.trim(), pageSize]);
  const cache = useRef(new Map<string, CatalogSnapshot>());
  const flight = useRef<{ key: string; controller: AbortController } | null>(null);
  const [, render] = useState(0);
  const update = useCallback(() => render((n) => n + 1), []);
  const active = useRef({ key, enabled });
  active.current = { key, enabled };
  const previousQuery = useRef(query);

  const request = useCallback((cursor: string | null) => {
    if (!active.current.enabled || active.current.key !== key || flight.current) return;
    const controller = new AbortController();
    const token = { key, controller };
    flight.current = token;
    update();
    void fetchConversationPage(project, query, cursor, controller.signal, pageSize)
      .then((page) => {
        if (controller.signal.aborted || flight.current !== token || active.current.key !== key) return;
        const current = cache.current.get(key);
        const seen = new Set<string>();
        const items = [...(cursor ? current?.items ?? [] : []), ...page.items]
          .filter((item) => { if (seen.has(item.path)) return false; seen.add(item.path); return true; });
        cache.current.set(key, { ...page, items, known: true, error: false, expired: false });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || flight.current !== token || active.current.key !== key) return;
        cache.current.set(key, {
          ...(cache.current.get(key) ?? { ...EMPTY_PAGE, known: false, expired: false }),
          error: true, failedCursor: conversationCatalogCursorExpired(cause) ? null : cursor,
          expired: conversationCatalogCursorExpired(cause) || (cache.current.get(key)?.expired ?? false),
        });
      })
      .finally(() => {
        if (flight.current !== token) return;
        flight.current = null;
        update();
      });
  }, [key, project, query, pageSize, update]);

  useEffect(() => {
    const delay = conversationCatalogRequestDelay(previousQuery.current, query);
    previousQuery.current = query;
    const timer = window.setTimeout(() => {
      if (enabled && !cache.current.has(key)) request(null);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      // Home retains its project snapshots; legacy consumers re-read on reopen.
      if (scopeKey === undefined) cache.current.delete(key);
      if (flight.current?.key === key) {
        flight.current.controller.abort();
        flight.current = null;
      }
    };
  }, [key, query, enabled, request, scopeKey]);

  const page = enabled || scopeKey !== undefined ? cache.current.get(key) : undefined;
  const loading = enabled && (!page || flight.current?.key === key);
  const loadMore = useCallback(() => {
    const current = cache.current.get(key);
    if (current?.nextCursor && !current.error && !current.expired) request(current.nextCursor);
  }, [key, request]);
  const refresh = useCallback(() => request(null), [request]);
  const retry = useCallback(() => {
    const current = cache.current.get(key);
    request(current?.expired ? null : current?.error ? current.failedCursor ?? null : current?.nextCursor ?? null);
  }, [key, request]);
  return {
    ...(page ?? EMPTY_PAGE), known: page?.known ?? false,
    loading, error: page?.error ?? false, expired: page?.expired ?? false,
    loadMore, retry, refresh,
  };
}
