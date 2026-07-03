"use client";

import { useEffect, useMemo, useRef } from "react";

import { useLogTail } from "@/hooks/useLogTail";
import type { FileEntry } from "@/lib/types";

import { TaskHeader } from "./TaskHeader";
import { buildFeed, FeedItem } from "./feed/renderers";

interface Props {
  file: FileEntry | null;
  files: FileEntry[];
  onSelect: (file: FileEntry) => void;
  showSvc: boolean;
  lineFilter: string;
  onStatus: (status: string) => void;
  paused: boolean;
  follow: boolean;
  setFollow: (follow: boolean) => void;
}

export function LogFeed({ file, files, onSelect, showSvc, lineFilter, onStatus, paused, follow, setFollow }: Props) {
  const tail = useLogTail(file, paused);
  const scroller = useRef<HTMLDivElement | null>(null);

  const feed = useMemo(
    () => (file ? buildFeed(file, tail.lines, showSvc, lineFilter.toLowerCase()) : { items: [], hiddenServiceCount: 0 }),
    [file, tail.lines, showSvc, lineFilter],
  );

  useEffect(() => {
    const time = tail.tickTime?.toLocaleTimeString("uk", { hour12: false }) ?? "";
    if (tail.error) onStatus(tail.error);
    else if (file) onStatus(`${(tail.size / 1024).toFixed(0)} kB${time ? " · " + time : ""}`);
    else onStatus("");
  }, [tail.error, tail.size, tail.tickTime, file, onStatus]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [feed.items.length, follow]);

  return (
    <div
      ref={scroller}
      className="flex-1 overflow-y-auto py-6"
      onScroll={(event) => {
        const el = event.currentTarget;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
        if (atBottom !== follow) setFollow(atBottom);
      }}
    >
      <div className="mx-auto max-w-[860px] px-6 pb-16">
        {!file ? (
          <div className="mt-[20vh] text-center text-dim">Вибери лог зліва — стрічка оновлюється сама</div>
        ) : (
          <>
            <TaskHeader file={file} files={files} onSelect={onSelect} />
            {feed.items.length ? (
              feed.items.slice(-2500).map((item, idx) => <FeedItem key={idx} item={item} />)
            ) : (
              <div className="mt-[20vh] text-center text-dim">
                {tail.loading
                  ? "Завантаження…"
                  : tail.size === 0
                    ? "Ще без виводу — файл поки порожній"
                    : feed.hiddenServiceCount
                      ? `Видимих повідомлень нема — лише службові записи (${feed.hiddenServiceCount}). Натисни «Службові»`
                      : "Порожньо (немає рядків для показу)"}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
