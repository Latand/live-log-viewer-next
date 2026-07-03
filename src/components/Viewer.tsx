"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from "react";

import { useFiles } from "@/hooks/useFiles";
import type { FileEntry } from "@/lib/types";

import { LogFeed } from "./LogFeed";
import { Sidebar } from "./Sidebar";
import { engineBadge, syntheticFile } from "./utils";

export function Viewer() {
  const files = useFiles();
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const match = location.hash.match(/^#f=(.+)$/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
    return localStorage.getItem("llvLastFile");
  });
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [showSvc, setShowSvc] = useState(false);
  const [lineFilter, setLineFilter] = useState("");
  const [status, setStatus] = useState("");

  const selectFile = useCallback((file: FileEntry) => {
    setSelected(file);
    setFollow(true);
    localStorage.setItem("llvLastFile", file.path);
    history.replaceState(null, "", "#f=" + encodeURIComponent(file.path));
  }, []);

  const openPath = useCallback(
    (pathname: string) => {
      const hit = files.find((file) => file.path === pathname);
      if (hit) selectFile(hit);
      else selectFile(syntheticFile(pathname));
    },
    [files, selectFile],
  );

  const readHash = useCallback(() => {
      const match = location.hash.match(/^#f=(.+)$/);
      if (!match) return null;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      if (next) setPendingPath(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [readHash]);

  useEffect(() => {
    if (!pendingPath || files.length === 0) return;
    openPath(pendingPath);
    setPendingPath(null);
  }, [pendingPath, files, openPath]);

  useEffect(() => {
    if (!selected && files.length) {
      const last = localStorage.getItem("llvLastFile");
      if (last) {
        const hit = files.find((file) => file.path === last);
        if (hit) setSelected(hit);
      }
    }
  }, [files, selected]);

  const badge = selected ? engineBadge(selected) : null;
  return (
    <div className="flex h-full">
      <Sidebar files={files} selected={selected} onSelect={selectFile} />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-panel px-5 py-2.5">
          <div className="max-w-[40vw] truncate text-sm font-bold" title={selected?.path}>
            {selected && badge ? (
              <>
                <span className={`mr-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${badge.cls}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {badge.label}
                </span>
                {selected.model ? <span className="mr-2 rounded-full bg-chip px-2 py-0.5 font-mono text-[10px] font-semibold text-[#555]">{selected.model}</span> : null}
                <span className="mr-2 text-[10.5px] font-normal text-dim">{selected.kind}</span>
                {selected.title}
              </>
            ) : (
              "Вибери лог"
            )}
          </div>
          <button
            className={`rounded-[10px] border border-line px-3.5 py-1.5 text-[13px] ${follow ? "bg-[#ecebfb] font-semibold text-accent" : "bg-panel"}`}
            onClick={() => setFollow((value) => !value)}
          >
            Follow
          </button>
          <button
            className={`rounded-[10px] border border-line px-3.5 py-1.5 text-[13px] ${paused ? "bg-[#ecebfb] font-semibold text-accent" : "bg-panel"}`}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? "Продовжити" : "Пауза"}
          </button>
          <button
            className={`rounded-[10px] border border-line px-3.5 py-1.5 text-[13px] ${showSvc ? "bg-[#ecebfb] font-semibold text-accent" : "bg-panel"}`}
            onClick={() => setShowSvc((value) => !value)}
          >
            Службові
          </button>
          <input
            className="w-[170px] rounded-[10px] border border-line bg-bg px-3 py-1.5 text-[13px] outline-none"
            placeholder="Фільтр рядків…"
            value={lineFilter}
            onChange={(event) => setLineFilter(event.target.value)}
          />
          <span className="ml-auto text-xs text-dim">{status}</span>
        </div>
        <LogFeed
          file={selected}
          files={files}
          onSelect={selectFile}
          showSvc={showSvc}
          lineFilter={lineFilter}
          onStatus={setStatus}
          paused={paused}
          follow={follow}
          setFollow={setFollow}
        />
      </main>
    </div>
  );
}
