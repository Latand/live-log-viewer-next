"use client";

import { useEffect, useState } from "react";

import { Trash2 } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

import { cleanTitle } from "@/lib/title";

import { DeleteFileButton } from "./DeleteFileButton";
import { OVERVIEW } from "./projectModel";
import { activityDot, engineBadge, fmtAge, ukPlural } from "./utils";

/* Module-level: the React Compiler flags direct global mutation inside a
   component body (same reason as gotoProject in ProjectDashboard). */
function gotoOverview() {
  location.hash = "#p=" + encodeURIComponent(OVERVIEW);
}

/**
 * Fallback listing for a project whose scheme has no nodes. Transcripts whose
 * parent lives in another project build no groups, no quiet trees and no
 * residual chips here — the scheme stays empty while the rail still shows the
 * project. Typical case: one-off agents spawned in a scratchpad cwd. Each row
 * opens as a node or deletes the file from disk.
 */
export function QuietFileList({ files, onOpen }: { files: FileEntry[]; onOpen: (file: FileEntry) => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="text-[13.5px] font-semibold text-dim">На схемі порожньо, але в проєкті є записи</div>
        <div className="mb-3 mt-0.5 text-[12px] text-dim">
          Клік по рядку відкриває розмову нодою; смітник видаляє її файл з диска назавжди.
        </div>
        <div className="space-y-1.5">
          {files.map((file) => (
            <QuietFileRow key={file.path} file={file} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </div>
  );
}

function QuietFileRow({ file, onOpen }: { file: FileEntry; onOpen: (file: FileEntry) => void }) {
  const [gone, setGone] = useState(false);
  const badge = engineBadge(file);
  if (gone) {
    return (
      <div className="flex items-center gap-2 rounded-[8px] border border-line bg-chip/60 px-3 py-1.5 text-[11.5px] font-semibold text-dim">
        <Trash2 className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{cleanTitle(file.title, 80)}</span>
        <span className="shrink-0">· видалено з диска</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[8px] border border-line bg-panel px-3 py-1.5 shadow-card">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[6px] text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={`Відкрити ${cleanTitle(file.title, 60)}`}
        onClick={() => onOpen(file)}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`} />
        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold" style={badge.style}>
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold" title={file.path}>
          {cleanTitle(file.title, 90)}
        </span>
        <span className="shrink-0 text-[10.5px] font-semibold text-dim">{fmtAge(file.mtime)}</span>
        <span className="shrink-0 text-[10.5px] text-dim">{(file.size / 1024).toFixed(0)} кБ</span>
      </button>
      <DeleteFileButton file={file} onDeleted={() => setGone(true)} />
    </div>
  );
}

/**
 * Deletes every transcript of a quiet project from disk in one confirmed
 * action. Shown only while nothing in the project runs; the API additionally
 * refuses any entry whose process is still alive.
 */
export function DeleteProjectButton({ files }: { files: FileEntry[] }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (!files.length || files.some((file) => file.proc === "running" || file.activity === "live")) return null;

  const removeAll = async () => {
    setBusy(true);
    setError("");
    let failed = 0;
    for (const file of files) {
      try {
        const res = await fetch(`/api/log?path=${encodeURIComponent(file.path)}`, { method: "DELETE" });
        const json = (await res.json()) as { ok?: boolean };
        if (!res.ok || !json.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setConfirming(false);
    if (failed) {
      setError(`не видалено ${failed} з ${files.length}`);
      return;
    }
    gotoOverview();
  };

  if (confirming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[10px] border border-err/30 bg-[#fff5f5] px-1.5 py-0.5 text-[11px]">
        <span className="px-0.5 font-semibold text-err">
          Видалити з диска {files.length} {ukPlural(files.length, "файл", "файли", "файлів")} проєкту?
        </span>
        <button
          type="button"
          className="rounded-lg bg-err px-2 py-0.5 font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/50"
          disabled={busy}
          onClick={removeAll}
        >
          {busy ? "видаляю…" : "Так, видалити"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-line bg-panel px-2 py-0.5 font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => setConfirming(false)}
        >
          Скасувати
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="h-3 w-3" aria-hidden /> Видалити проєкт з диска
      </button>
      {error ? <span className="max-w-[180px] truncate text-[10.5px] font-semibold text-err">{error}</span> : null}
    </span>
  );
}
