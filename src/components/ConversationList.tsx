"use client";

import { useEffect, useRef, useState } from "react";

import { Loader2 } from "@/components/icons";
import { useConversationCatalog } from "@/hooks/useConversationCatalog";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { QuietFileRow } from "./ProjectTrash";

/** One page of the desktop agent list. Deep enough that a scroll reaches the
    next page without a visible pause, small enough that the first paint of a
    project with hundreds of conversations is not the whole corpus. */
export const CONVERSATION_LIST_PAGE_SIZE = 50;

export function ConversationList({
  project,
  enabled,
  onOpen,
}: {
  project: string;
  enabled: boolean;
  onOpen: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const searching = Boolean(query.trim());
  /* Full browsable agent list, the desktop counterpart of the phone's inline
     catalog: one screenful and a bit per page, and the next page arrives from
     a sentinel at the end of the rows instead of a button the operator has to
     find. `scopeKey` is what keeps the accumulated pages alive across an
     update — without it the hook drops this scope's snapshot on every effect
     teardown, so a poll or a tab change would throw away everything scrolled
     so far and snap the list back to page one. */
  const catalog = useConversationCatalog({
    project: searching ? undefined : project, query, enabled,
    pageSize: CONVERSATION_LIST_PAGE_SIZE, scopeKey: project,
  });
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (!enabled || catalog.loading || catalog.error || !catalog.nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) catalog.loadMore();
    }, { rootMargin: "0px 0px 240px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, catalog.loading, catalog.error, catalog.nextCursor, catalog.loadMore]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-baseline gap-2">
          <div className="text-[13.5px] font-semibold text-muted">{t(searching ? "switch.results" : "list.title")}</div>
          {catalog.total ? <span className="text-[11px] font-bold tabular-nums text-muted">{catalog.total}</span> : null}
        </div>
        <div className="mt-0.5 text-[12px] text-muted">{t(searching ? "list.searchHint" : "list.hint")}</div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("switch.search")}
          aria-label={t("switch.search")}
          className="mb-3 mt-2 h-11 w-full rounded-[8px] border border-border bg-card px-3 text-[13px] text-primary outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        <div className="space-y-1.5">
          {catalog.items.map((file) => <QuietFileRow key={file.path} file={file} activeSubtree={false} showProject={searching} onOpen={onOpen} />)}
        </div>
        {catalog.loading && !catalog.items.length ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-[13px] font-semibold text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loading")}
          </div>
        ) : null}
        {catalog.error ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-[13px] font-semibold text-danger">
            <span>{t("list.failed")}</span>
            <button
              type="button"
              className="min-h-11 rounded-[8px] border border-border bg-card px-4 font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={catalog.retry}
            >
              {t("list.retry")}
            </button>
          </div>
        ) : null}
        {!catalog.loading && !catalog.error && !catalog.items.length ? (
          <div className="min-h-32 pt-10 text-center text-[13px] font-semibold text-muted">{t("common.nothingFound")}</div>
        ) : null}
        {/* Infinite scroll, with the button kept as the reachable fallback for
            a browser without IntersectionObserver and for a page that failed
            mid-chain. */}
        {catalog.nextCursor && !catalog.error ? (
          <button
            type="button"
            data-conversation-list-more
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-[8px] border border-border bg-card px-4 text-[12.5px] font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            disabled={catalog.loading}
            onClick={catalog.loadMore}
          >
            {catalog.loading ? t("common.loading") : t("list.loadMore")}
          </button>
        ) : null}
        <div ref={sentinel} data-conversation-list-sentinel className="h-px" />
      </div>
    </div>
  );
}
