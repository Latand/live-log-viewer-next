"use client";

import { useCallback, useEffect, useState } from "react";

import type { TranscriptSearchRow } from "@/app/api/search/transcripts/route";
import type { TranscriptCorpusStats, TranscriptSpeaker } from "@/lib/search/transcriptSearch";

export type { TranscriptSearchRow };

/** Same debounce the conversation catalog search uses, so both surfaces feel
    identically responsive under a keystroke stream. */
export const TRANSCRIPT_SEARCH_DEBOUNCE_MS = 250;
export const TRANSCRIPT_SEARCH_PAGE_SIZE = 20;

export interface TranscriptSearchPage {
  items: TranscriptSearchRow[];
  nextCursor: string | null;
  total: number;
  /** Corpus totals the endpoint returns with every page — what makes a zero
      result trustworthy instead of ambiguous. Null before the first answer. */
  stats: TranscriptCorpusStats | null;
}

export interface TranscriptSearchData extends TranscriptSearchPage {
  loading: boolean;
  error: boolean;
  /** The rows on screen answer an EARLIER question than the one typed. They
      stay rendered — a list that blanks between keystrokes reads as broken —
      but the caller must not let one be activated. */
  stale: boolean;
  /** The speaker scope the rows on screen were actually answered under, which
      the live toggle can already have left behind. */
  answeredSpeaker: TranscriptSpeaker | undefined;
  loadMore: () => void;
  retry: () => void;
}

const EMPTY_PAGE: TranscriptSearchPage = { items: [], nextCursor: null, total: 0, stats: null };

interface SettledRequest {
  key: string;
  speaker: TranscriptSpeaker | undefined;
  page: TranscriptSearchPage;
  error: boolean;
}

interface MoreRequest {
  key: string;
  cursor: string;
}

export class TranscriptSearchRequestError extends Error {
  constructor(readonly status: number) {
    super(`transcript search request failed: ${status}`);
    this.name = "TranscriptSearchRequestError";
  }
}

/** The endpoint answers a cursor it will not honour with 400. On a Load more
    that means the pagination scope moved under the page, so the query restarts
    at page one rather than surfacing a failure the operator cannot act on. */
export function transcriptSearchCursorRejected(cause: unknown): boolean {
  return cause instanceof TranscriptSearchRequestError && cause.status === 400;
}

/** A new query waits out the debounce; a speaker flip over the same query is
    a deliberate act and requeries at once. */
export function transcriptSearchRequestDelay(currentQuery: string, nextQuery: string): number {
  return currentQuery === nextQuery ? 0 : TRANSCRIPT_SEARCH_DEBOUNCE_MS;
}

/** No `project` param, ever: the requirement is one search across every
    project, account and engine. */
export function transcriptSearchUrl(
  query: string,
  speaker: TranscriptSpeaker | undefined,
  cursor?: string | null,
): string {
  const params = new URLSearchParams({ q: query.trim(), limit: String(TRANSCRIPT_SEARCH_PAGE_SIZE) });
  if (speaker) params.set("speaker", speaker);
  if (cursor) params.set("cursor", cursor);
  return `/api/search/transcripts?${params}`;
}

/** Identity of one search: the speaker scope plus the trimmed query. Two
    requests with the same key ask the same question, and an answer is only
    ever shown as current for the key it was asked under. */
function searchKey(speaker: TranscriptSpeaker | undefined, trimmedQuery: string): string {
  return `${speaker ?? ""}\u0000${trimmedQuery}`;
}

/** Identity of one result row: a single message inside one transcript. Two
    matches in the same conversation are two rows, so the key carries the
    offset as well as the path. */
export function transcriptSearchRowKey(item: TranscriptSearchRow): string {
  return `${item.transcriptPath}\u0000${item.byteOffset}`;
}

/** Appends a page, dropping rows the previous pages already show — an index
    that grew between two requests must not duplicate a row. */
export function mergeTranscriptSearchPage(
  current: TranscriptSearchPage,
  next: TranscriptSearchPage,
): TranscriptSearchPage {
  const seen = new Set(current.items.map(transcriptSearchRowKey));
  return {
    items: [...current.items, ...next.items.filter((item) => !seen.has(transcriptSearchRowKey(item)))],
    nextCursor: next.nextCursor,
    total: next.total,
    stats: next.stats ?? current.stats,
  };
}

async function fetchTranscriptSearchPage(
  query: string,
  speaker: TranscriptSpeaker | undefined,
  cursor: string | null,
  signal: AbortSignal,
): Promise<TranscriptSearchPage> {
  const response = await fetch(transcriptSearchUrl(query, speaker, cursor), { signal });
  if (!response.ok) throw new TranscriptSearchRequestError(response.status);
  return response.json() as Promise<TranscriptSearchPage>;
}

/**
 * Debounced, paginated full-text search over every indexed transcript body.
 *
 * Modelled on `useConversationCatalog` with one deliberate difference: while a
 * refinement is in flight the rows already on screen STAY. A palette that
 * blanks between keystrokes reads as broken on a corpus this size, so the
 * previous answer holds until the next one lands — the caller renders the
 * in-flight state beside the stale rows. Holding them is not trusting them:
 * `stale` says the rows no longer answer the typed question, so the caller can
 * keep them readable while refusing to open one. A cursor is only ever offered
 * for the request it was minted under, so a refinement can never page the wrong
 * scope.
 */
export function useTranscriptSearch({
  query,
  speaker,
  enabled = true,
}: {
  query: string;
  speaker?: TranscriptSpeaker;
  enabled?: boolean;
}): TranscriptSearchData {
  const [request, setRequest] = useState({ query, speaker });
  useEffect(() => {
    if (query === request.query && speaker === request.speaker) return;
    const delay = transcriptSearchRequestDelay(request.query, query);
    const timer = window.setTimeout(() => setRequest({ query, speaker }), delay);
    return () => window.clearTimeout(timer);
  }, [query, speaker, request.query, request.speaker]);

  const trimmed = request.query.trim();
  const requestKey = searchKey(request.speaker, trimmed);
  const active = enabled && Boolean(trimmed);
  /* What the operator is asking RIGHT NOW. The request in flight trails it by
     up to one debounce window, so every answer the caller renders is judged
     against this key rather than against the request that produced it. */
  const liveTrimmed = query.trim();
  const liveKey = searchKey(speaker, liveTrimmed);
  const live = enabled && Boolean(liveTrimmed);
  const [settled, setSettled] = useState<SettledRequest>({
    key: "",
    speaker: undefined,
    page: EMPTY_PAGE,
    error: false,
  });
  const [moreRequest, setMoreRequest] = useState<MoreRequest | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetchTranscriptSearchPage(request.query, request.speaker, null, controller.signal)
      .then((page) => setSettled({ key: requestKey, speaker: request.speaker, page, error: false }))
      .catch((cause: unknown) => {
        if ((cause as { name?: string }).name !== "AbortError") {
          setSettled({ key: requestKey, speaker: request.speaker, page: EMPTY_PAGE, error: true });
        }
      });
    return () => controller.abort();
  }, [active, request.query, request.speaker, requestKey, retryNonce]);

  useEffect(() => {
    if (!moreRequest || moreRequest.key !== requestKey) return;
    const controller = new AbortController();
    void fetchTranscriptSearchPage(request.query, request.speaker, moreRequest.cursor, controller.signal)
      .then((page) => {
        setSettled((current) =>
          current.key === moreRequest.key
            ? { ...current, page: mergeTranscriptSearchPage(current.page, page), error: false }
            : current,
        );
      })
      .catch((cause: unknown) => {
        if (transcriptSearchCursorRejected(cause)) {
          setRetryNonce((value) => value + 1);
        } else if ((cause as { name?: string }).name !== "AbortError") {
          setSettled((current) => (current.key === moreRequest.key ? { ...current, error: true } : current));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setMoreRequest((current) => (current === moreRequest ? null : current));
        }
      });
    return () => controller.abort();
  }, [moreRequest, request.query, request.speaker, requestKey]);

  /* The typed query is ahead of the debounced request: the answer on screen
     cannot describe it yet, so this counts as in flight. Without it the palette
     spent every debounce window claiming "nothing found" for a query it had not
     asked about. */
  const settling = live && (query !== request.query || speaker !== request.speaker);
  const matched = active && settled.key === requestKey;
  /* A settled answer for an EARLIER request keeps rendering while the next one
     is in flight (no blank list between keystrokes) — but its cursor belongs to
     that older scope, so Load more is withheld until the answer catches up. An
     emptied query drops the held rows at once: the empty-query state is a
     designed one and must not carry the last answer underneath it. */
  const settledPage = live && settled.key ? settled.page : EMPTY_PAGE;
  const page = matched ? settledPage : { ...settledPage, nextCursor: null };
  const loading = live && (settling || (active && (!matched || moreRequest?.key === requestKey)));
  const error = matched ? settled.error : false;
  /* Held rows answer a question the operator has already moved on from: a
     refinement is mid-flight, or the scope was just flipped. They keep their
     place on screen, but the caller must not let one be ACTIVATED — Enter or a
     click would open a conversation from outside the search in progress, and
     right after an Everything → My flip the held rows can be the agent's
     messages rather than the operator's own. */
  const stale = settledPage.items.length > 0 && settled.key !== liveKey;
  /* Which scope those rows were answered under, so the caller can label them
     truthfully while the toggle sits ahead of the answer. */
  const answeredSpeaker = settledPage.items.length ? settled.speaker : speaker;

  const loadMore = useCallback(() => {
    if (!matched || loading || !page.nextCursor) return;
    setMoreRequest({ key: requestKey, cursor: page.nextCursor });
  }, [matched, loading, page.nextCursor, requestKey]);

  const retry = useCallback(() => {
    setMoreRequest(null);
    setRetryNonce((value) => value + 1);
  }, []);

  return { ...page, loading, error, stale, answeredSpeaker, loadMore, retry };
}
