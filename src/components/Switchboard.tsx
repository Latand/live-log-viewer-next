"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Loader2, X } from "@/components/icons";
import { useArchivedPaths } from "@/hooks/useArchivedPaths";
import { useConversationCatalog } from "@/hooks/useConversationCatalog";
import { useTimeline } from "@/hooks/useTimeline";
import { useSwitchboardData, type SwitchboardItem } from "@/hooks/useSwitchboardData";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { conversationIdentity } from "@/lib/accounts/identity";

import { projectKey } from "./projectModel";
import { CornerStatus } from "./CornerStatus";
import { CodexAccountSwitch } from "./CodexAccountSwitch";
import { FlipRow } from "./FlipRow";
import { SwitchCard, type SwitchCardTone } from "./SwitchCard";

interface Props {
  files: FileEntry[];
  flows: Flow[];
  project: string;
  loaded: boolean;
  onOpenFile: (file: FileEntry) => void;
  onOpenCatalogFile: (file: FileEntry) => void;
}

function toneFor(item: SwitchboardItem): SwitchCardTone {
  if (item.kind === "working") return "working";
  if (item.kind === "waiting" && item.file.activity === "stalled") return "stalled";
  if (item.kind === "waiting") return "waiting";
  return "quiet";
}

function Section({
  title,
  items,
  size,
  currentProject,
  onOpenFile,
  onArchive,
}: {
  title: string;
  items: SwitchboardItem[];
  size: "large" | "small";
  currentProject: string;
  onOpenFile: (file: FileEntry) => void;
  onArchive: (file: FileEntry) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="shrink-0">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[13px] font-bold">{title}</h2>
        <span className="text-[11px] font-semibold text-dim">{items.length}</span>
      </div>
      <FlipRow className="flex flex-wrap gap-2.5" enter="fade">
        {items.map((item) => {
          /* Key by stable conversation identity, never the transcript path: a
             migrated successor keeps its card (and its FlipRow position/animation)
             instead of unmounting as the predecessor and remounting anew. */
          const id = conversationIdentity(item.file);
          return (
          <div key={id} data-flip-key={id}>
            <SwitchCard
              file={item.file}
              title={item.title}
              project={item.project}
              currentProject={currentProject}
              descendants={item.descendants}
              statusLine={item.statusLine}
              size={size}
              tone={toneFor(item)}
              onOpen={onOpenFile}
              onArchive={onArchive}
            />
          </div>
          );
        })}
      </FlipRow>
    </section>
  );
}

export function Switchboard({ files, flows, project, loaded, onOpenFile, onOpenCatalogFile }: Props) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [olderOpen, setOlderOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [now, setNow] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timeline = useTimeline(project, open);
  const { archivedPaths, archive, unarchive } = useArchivedPaths(files);
  const data = useSwitchboardData(files, timeline.events, query, now, archivedPaths, flows);
  const catalogSearch = useConversationCatalog({ query, enabled: loaded && open && Boolean(query.trim()) });
  const cornerData = useSwitchboardData(files, [], "", now, archivedPaths, flows);
  const archivedItems = useMemo(
    () =>
      files
        .filter((file) => archivedPaths.has(file.path))
        .map((file) => ({ file, title: cleanTitle(file.title), project: projectKey(file) }))
        .sort((a, b) => b.file.mtime - a.file.mtime),
    [files, archivedPaths],
  );

  useEffect(() => {
    const refresh = () => setNow(Date.now() / 1000);
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openFile = (file: FileEntry) => {
    onOpenFile(file);
    setOpen(false);
  };
  const archiveFile = (file: FileEntry) => archive(file.path);

  return (
    <>
      <CornerStatus data={cornerData} onOpen={() => setOpen(true)} />
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/28 p-[2.5vh]" onMouseDown={() => setOpen(false)}>
          <div
            className="flex h-[95vh] w-[95vw] flex-col overflow-hidden rounded-[8px] border border-line bg-bg shadow-[0_18px_70px_rgb(20_20_30/0.28)]"
            role="dialog"
            aria-modal="true"
            aria-label={t("switch.aria")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
              <div className="text-[15px] font-bold">{t("switch.title")}</div>
              <CodexAccountSwitch />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("switch.search")}
                className="h-9 min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              {timeline.loading ? <span className="text-[11px] font-semibold text-dim">{t("switch.updating")}</span> : null}
              <button
                className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={t("switch.close")}
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </header>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
              {query.trim() ? (
                <section className="mx-auto w-full max-w-[900px]">
                  <div className="mb-2 flex items-baseline gap-2">
                    <h2 className="text-[13px] font-bold">{t("switch.results")}</h2>
                    <span className="text-[11px] font-semibold text-dim">{catalogSearch.total}</span>
                  </div>
                  <div className="space-y-1.5">
                    {catalogSearch.items.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[8px] border border-line bg-panel px-3 text-left shadow-card hover:border-accent/40 hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        onClick={() => {
                          onOpenCatalogFile(file);
                          setOpen(false);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{cleanTitle(file.title, 100)}</span>
                        <span className="max-w-[240px] shrink-0 truncate rounded-full border border-line bg-bg px-2 py-0.5 text-[10.5px] font-semibold text-dim">{file.project}</span>
                      </button>
                    ))}
                  </div>
                  {catalogSearch.loading && !catalogSearch.items.length ? (
                    <div className="flex items-center justify-center gap-2 pt-[18vh] text-[13px] font-semibold text-dim">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loading")}
                    </div>
                  ) : null}
                  {catalogSearch.error ? (
                    <div className="flex min-h-11 items-center justify-center gap-3 pt-4 text-[13px] font-semibold text-err">
                      <span>{t("list.failed")}</span>
                      <button
                        type="button"
                        className="min-h-11 rounded-[8px] border border-line bg-panel px-4 font-bold text-ink hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        onClick={catalogSearch.retry}
                      >
                        {t("list.retry")}
                      </button>
                    </div>
                  ) : null}
                  {!catalogSearch.loading && !catalogSearch.error && !catalogSearch.items.length ? (
                    <div className="pt-[18vh] text-center text-[13px] font-semibold text-dim">{t("common.nothingFound")}</div>
                  ) : null}
                  {catalogSearch.nextCursor && !catalogSearch.error ? (
                    <button
                      type="button"
                      className="mt-3 flex min-h-11 w-full items-center justify-center rounded-[8px] border border-line bg-panel px-4 text-[12.5px] font-bold text-ink hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                      disabled={catalogSearch.loading}
                      onClick={catalogSearch.loadMore}
                    >
                      {catalogSearch.loading ? t("common.loading") : t("list.loadMore")}
                    </button>
                  ) : null}
                </section>
              ) : (
                <>
              <Section title={t("switch.waiting")} items={data.waiting} size="large" currentProject={project} onOpenFile={openFile} onArchive={archiveFile} />
              <Section title={t("switch.working")} items={data.working} size="large" currentProject={project} onOpenFile={openFile} onArchive={archiveFile} />
              <Section title={t("switch.recent")} items={data.recent} size="small" currentProject={project} onOpenFile={openFile} onArchive={archiveFile} />
              <section className="shrink-0">
                <button
                  className="flex h-10 w-full items-center justify-between rounded-[8px] border border-line bg-panel px-3 text-left text-[12.5px] font-bold hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  aria-expanded={olderOpen}
                  onClick={() => setOlderOpen((value) => !value)}
                >
                  <span>{t("switch.older")}</span>
                  <span className="text-dim">{data.older.length}</span>
                </button>
                {olderOpen ? (
                  <div className="mt-2">
                    <Section title="" items={data.older} size="small" currentProject={project} onOpenFile={openFile} onArchive={archiveFile} />
                  </div>
                ) : null}
              </section>
              {!data.waiting.length && !data.working.length && !data.recent.length && !data.older.length ? (
                loaded ? (
                  <div className="pt-[18vh] text-center text-[13px] font-semibold text-dim">{t("common.nothingFound")}</div>
                ) : (
                  <div className="flex items-center justify-center gap-2 pt-[18vh] text-[13px] font-semibold text-dim">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    {t("common.loading")}
                  </div>
                )
              ) : null}
              {archivedItems.length ? (
                <section className="shrink-0">
                  <button
                    className="flex h-9 w-full items-center justify-between rounded-[8px] border border-line bg-panel px-3 text-left text-[12px] font-bold text-dim hover:border-accent/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    aria-expanded={archivedOpen}
                    onClick={() => setArchivedOpen((value) => !value)}
                  >
                    <span>{t("switch.hidden", { count: archivedItems.length })}</span>
                    <span>{archivedOpen ? t("switch.hide") : t("common.show")}</span>
                  </button>
                  {archivedOpen ? (
                    <div className="mt-2 space-y-1">
                      {archivedItems.map((item) => (
                        <div
                          key={conversationIdentity(item.file)}
                          className="flex min-w-0 items-center gap-2 rounded-[8px] border border-line bg-panel/60 px-3 py-1.5 text-[11.5px] text-dim"
                        >
                          <span className="min-w-0 flex-1 truncate">{item.title}</span>
                          <span className="shrink-0 truncate text-[10.5px]">{item.project}</span>
                          <button
                            className="shrink-0 rounded-full border border-line bg-bg px-2 py-0.5 text-[10.5px] font-semibold text-ink hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                            onClick={() => unarchive(item.file.path)}
                          >
                            {t("switch.restore")}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
