"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useConversationCatalog, type ConversationCatalogData } from "@/hooks/useConversationCatalog";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

export interface CatalogPosition {
  path: string | null;
  offset: number;
  scrollTop: number;
}
interface ProjectCatalogView {
  expanded: boolean;
  query: string;
  position: CatalogPosition;
}

/** Lives in the dashboard, including while Home is covered by a conversation. */
export function useMobileInlineCatalog(project: string, enabled: boolean) {
  const views = useRef(new Map<string, ProjectCatalogView>());
  const [, render] = useState(0);
  if (!views.current.has(project)) views.current.set(project, { expanded: false, query: "", position: { path: null, offset: 0, scrollTop: 0 } });
  const view = views.current.get(project)!;
  const change = (patch: Partial<ProjectCatalogView>) => {
    views.current.set(project, { ...view, ...patch });
    render((n) => n + 1);
  };
  const catalog = useConversationCatalog({
    project: view.query.trim() ? undefined : project,
    query: view.query, enabled: enabled && view.expanded, pageSize: 20, scopeKey: project,
  });
  return { view, catalog, toggle: () => change({ expanded: !view.expanded }),
    setQuery: (query: string) => change({ query, position: { path: null, offset: 0, scrollTop: 0 } }) };
}

export function captureCatalogPosition(root: HTMLElement, position: CatalogPosition) {
  const top = root.getBoundingClientRect().top;
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-catalog-path]"))
    .find((element) => element.getBoundingClientRect().bottom > top);
  position.path = row?.dataset.catalogPath ?? null;
  position.offset = row ? row.getBoundingClientRect().top - top : 0;
  position.scrollTop = root.scrollTop;
}
export function restoreCatalogPosition(root: HTMLElement, position: CatalogPosition) {
  root.scrollTop = position.scrollTop;
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-catalog-path]"))
    .find((element) => element.dataset.catalogPath === position.path);
  if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - position.offset;
}

export function MobileInlineCatalog({ catalog, query, onQuery, files, onOpen }: {
  catalog: ConversationCatalogData;
  query: string;
  onQuery: (query: string) => void;
  files: readonly FileEntry[];
  onOpen: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || catalog.loading || catalog.error || !catalog.nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) catalog.loadMore();
    }, { root: node.closest("[data-mobile2-board]"), rootMargin: "0px 0px 120px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [catalog.loading, catalog.error, catalog.nextCursor, catalog.loadMore]);
  const live = new Map(files.map((file) => [file.path, file]));
  return (
    <section data-mobile-inline-catalog className="flex min-w-0 flex-col gap-1.5">
      <p className="px-1 text-label text-muted">{t("mobile.catalog.hint")}</p>
      <input type="search" value={query} onChange={(event) => onQuery(event.target.value)}
        aria-label={t("switch.search")} placeholder={t("switch.search")}
        className="min-h-11 w-full min-w-0 rounded-[12px] border border-border bg-card px-3 text-body text-primary" />
      <button type="button" onClick={catalog.refresh} disabled={catalog.loading}
        className="min-h-11 rounded-[12px] bg-quiet px-3 text-label text-secondary disabled:opacity-60">{t("mobile.catalog.refresh")}</button>
      {catalog.items.map((entry) => {
        const file = live.get(entry.path) ?? entry;
        return <button type="button" key={entry.path} data-catalog-path={entry.path}
          onClick={() => onOpen(file)}
          className="flex min-h-14 w-full min-w-0 items-center gap-2.5 rounded-[12px] bg-card px-3 py-2 text-left shadow-1 active:bg-sunken">
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${file.activity === "live" ? "bg-success" : "bg-strong"}`} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="line-clamp-2 break-words text-body font-semibold text-primary [overflow-wrap:anywhere]">{file.title || file.name}</span>
            <span className="truncate text-label text-muted">{file.engine}{query.trim() ? ` · ${file.project}` : ""}</span>
          </span>
          <ChevronRight aria-hidden className="h-[18px] w-[18px] shrink-0 text-muted" />
        </button>;
      })}
      {catalog.loading ? <p role="status" className="p-3 text-label text-muted">{t("common.loading")}</p> : null}
      {catalog.error && !catalog.loading ? <div role="status" className="text-label text-danger">
        <p>{t(catalog.expired ? "mobile.catalog.expired" : "list.failed")}</p>
        <button type="button" onClick={catalog.retry} className="min-h-11 w-full rounded-[12px] bg-card px-3">
          {t(catalog.expired ? "mobile.catalog.refresh" : "list.retry")}
        </button>
      </div> : null}
      {!catalog.loading && !catalog.error && catalog.known && !catalog.nextCursor
        ? <p role="status" className="p-3 text-label text-muted">{t(catalog.items.length ? "mobile.catalog.end" : "common.nothingFound")}</p> : null}
      <div ref={sentinel} data-catalog-sentinel className="h-px" />
    </section>
  );
}
