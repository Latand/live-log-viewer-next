"use client";

import { useState } from "react";

import { Loader2 } from "@/components/icons";
import { useConversationCatalog } from "@/hooks/useConversationCatalog";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { QuietFileRow } from "./ProjectTrash";

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
  const catalog = useConversationCatalog({ project: searching ? undefined : project, query, enabled });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-baseline gap-2">
          <div className="text-[13.5px] font-semibold text-dim">{t(searching ? "switch.results" : "list.title")}</div>
          {catalog.total ? <span className="text-[11px] font-bold tabular-nums text-dim">{catalog.total}</span> : null}
        </div>
        <div className="mt-0.5 text-[12px] text-dim">{t(searching ? "list.searchHint" : "list.hint")}</div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("switch.search")}
          aria-label={t("switch.search")}
          className="mb-3 mt-2 h-11 w-full rounded-[8px] border border-line bg-panel px-3 text-[13px] text-ink outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        <div className="space-y-1.5">
          {catalog.items.map((file) => <QuietFileRow key={file.path} file={file} activeSubtree={false} showProject={searching} onOpen={onOpen} />)}
        </div>
        {catalog.loading && !catalog.items.length ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-[13px] font-semibold text-dim">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loading")}
          </div>
        ) : null}
        {catalog.error ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-[13px] font-semibold text-err">
            <span>{t("list.failed")}</span>
            <button
              type="button"
              className="min-h-11 rounded-[8px] border border-line bg-panel px-4 font-bold text-ink hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={catalog.retry}
            >
              {t("list.retry")}
            </button>
          </div>
        ) : null}
        {!catalog.loading && !catalog.error && !catalog.items.length ? (
          <div className="min-h-32 pt-10 text-center text-[13px] font-semibold text-dim">{t("common.nothingFound")}</div>
        ) : null}
        {catalog.nextCursor && !catalog.error ? (
          <button
            type="button"
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-[8px] border border-line bg-panel px-4 text-[12.5px] font-bold text-ink hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            disabled={catalog.loading}
            onClick={catalog.loadMore}
          >
            {catalog.loading ? t("common.loading") : t("list.loadMore")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
