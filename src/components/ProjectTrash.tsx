"use client";

import { useEffect, useState } from "react";

import { Archive, GitBranch, Trash2 } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { cleanTitle } from "@/lib/title";

import { DeleteFileButton } from "./DeleteFileButton";
import { OVERVIEW } from "./projectModel";
import { activityDot, engineBadge, fmtAge } from "./utils";

/* Module-level: the React Compiler flags direct global mutation inside a
   component body (same reason as gotoProject in ProjectDashboard). */
function gotoOverview() {
  location.hash = "#p=" + encodeURIComponent(OVERVIEW);
}

type ProjectDeleteFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function loadProjectConversations(project: string, fetcher: ProjectDeleteFetcher = fetch): Promise<FileEntry[]> {
  const items: FileEntry[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ project, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetcher(`/api/conversations?${params}`);
    if (!response.ok) throw new Error(`conversation catalog request failed: ${response.status}`);
    const page = await response.json() as { items?: FileEntry[]; nextCursor?: string | null };
    if (!Array.isArray(page.items)) throw new Error("conversation catalog response is invalid");
    items.push(...page.items);
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    if (cursor && cursors.has(cursor)) throw new Error("conversation catalog cursor repeated");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

export async function deleteProjectFiles(project: string, files: readonly FileEntry[], fetcher: ProjectDeleteFetcher = fetch): Promise<number> {
  try {
    const response = await fetcher("/api/log/project-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, paths: files.map((file) => file.path) }),
    });
    const result = await response.json() as { ok?: boolean };
    return response.ok && result.ok ? 0 : files.length;
  } catch {
    return files.length;
  }
}

/**
 * Fallback listing for a project whose scheme has no nodes. Transcripts whose
 * parent lives in another project build no groups, no quiet trees and no
 * residual chips here — the scheme stays empty while the rail still shows the
 * project. Typical case: one-off agents spawned in a scratchpad cwd. Each row
 * opens as a node or deletes the file from disk.
 */
export function QuietFileList({
  files,
  activeRootPaths,
  onOpen,
}: {
  files: FileEntry[];
  activeRootPaths?: ReadonlySet<string>;
  onOpen: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="text-[13.5px] font-semibold text-dim">{t("trash.title")}</div>
        <div className="mb-3 mt-0.5 text-[12px] text-dim">
          {t("trash.hint")}
        </div>
        <div className="space-y-1.5">
          {files.map((file) => (
            <QuietFileRow
              key={file.path}
              file={file}
              activeSubtree={activeRootPaths?.has(file.path) ?? false}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function QuietFileRow({
  file,
  activeSubtree,
  showProject = false,
  onOpen,
}: {
  file: FileEntry;
  activeSubtree: boolean;
  showProject?: boolean;
  onOpen: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [gone, setGone] = useState(false);
  const badge = engineBadge(file);
  if (gone) {
    return (
      <div className="flex items-center gap-2 rounded-[8px] border border-line bg-chip/60 px-3 py-1.5 text-[11.5px] font-semibold text-dim">
        <Trash2 className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{cleanTitle(file.title, 80)}</span>
        <span className="shrink-0">{t("trash.deletedFromDisk")}</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[8px] border border-line bg-panel px-3 py-1.5 shadow-card">
      <button
        type="button"
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-[6px] text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${isMobile ? "min-h-11" : "h-full"}`}
        aria-label={t("trash.open", { title: cleanTitle(file.title, 60) })}
        onClick={() => onOpen(file)}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(file.activity)}`} />
        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold" style={badge.style}>
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold" title={file.path}>
          {cleanTitle(file.title, 90)}
        </span>
        {showProject ? (
          <span className="max-w-[28vw] shrink-0 truncate rounded-full border border-line bg-bg px-1.5 py-0.5 text-[10px] font-semibold text-dim">
            {file.project}
          </span>
        ) : null}
        {activeSubtree ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-accent"
            title={t("trash.activeSubtree")}
          >
            <GitBranch className="h-3 w-3" aria-hidden />
            {t("trash.activeSubtree")}
          </span>
        ) : null}
        {isMobile ? null : (
          <>
            <span className="shrink-0 text-[10.5px] font-semibold text-dim">{fmtAge(file.mtime)}</span>
            <span className="shrink-0 text-[10.5px] text-dim">{(file.size / 1024).toFixed(0)} {t("common.kb")}</span>
          </>
        )}
      </button>
      <DeleteFileButton file={file} onDeleted={() => setGone(true)} />
    </div>
  );
}

/**
 * Shelves a quiet project: hides it from the rail and the overview without
 * touching disk. The default way to clear out a finished project — deletion
 * stays available next to it for the rare case the transcripts must go.
 * Reversible (rail archive section / new activity), so no confirmation.
 */
export function ArchiveProjectButton({
  files,
  allowEmpty = false,
  onArchive,
  compact = false,
}: {
  files: FileEntry[];
  allowEmpty?: boolean;
  onArchive: () => void;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  if ((!files.length && !allowEmpty) || files.some((file) => file.proc === "running" || file.activity === "live")) return null;
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-bg font-semibold text-dim hover:border-accent/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "min-h-11 px-3 text-[13px]" : compact ? "p-1 text-[11px]" : "px-2 py-0.5 text-[11px]"
      }`}
      aria-label={t("trash.toArchive")}
      title={t("trash.toArchive")}
      onClick={() => {
        onArchive();
        gotoOverview();
      }}
    >
      <Archive className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden /> {compact && !isMobile ? null : t("trash.toArchive")}
    </button>
  );
}

/**
 * Deletes every transcript of a quiet project from disk in one confirmed
 * action. Shown only while nothing in the project runs; the API additionally
 * refuses any entry whose process is still alive.
 */
export function DeleteProjectButton({ project, files, available }: { project: string; files: FileEntry[]; available: boolean }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [targets, setTargets] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (!available || files.some((file) => file.proc === "running" || file.activity === "live")) return null;

  const prepare = async () => {
    setBusy(true);
    setError("");
    try {
      const complete = await loadProjectConversations(project);
      if (!complete.length) throw new Error("project catalog is empty");
      setTargets(complete);
      setConfirming(true);
    } catch {
      setError(t("trash.projectLoadFailed"));
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    if (!targets) return;
    setBusy(true);
    setError("");
    const failed = await deleteProjectFiles(project, targets);
    setBusy(false);
    setConfirming(false);
    if (failed) {
      setError(t("trash.notDeleted", { failed, total: targets.length }));
      return;
    }
    gotoOverview();
  };

  if (confirming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[10px] border border-err/30 bg-[#fff5f5] px-1.5 py-0.5 text-[11px]">
        <span className="px-0.5 font-semibold text-err">
          {t("trash.confirmDelete", { count: targets?.length ?? 0 })}
        </span>
        <button
          type="button"
          className={`inline-flex items-center rounded-lg bg-err font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/50 ${
            isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
          }`}
          disabled={busy}
          onClick={removeAll}
        >
          {busy ? t("trash.deleting") : t("trash.confirmYes")}
        </button>
        <button
          type="button"
          className={`inline-flex items-center rounded-lg border border-line bg-panel font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
          }`}
          onClick={() => { setConfirming(false); setTargets(null); }}
        >
          {t("common.cancel")}
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        className={`inline-flex items-center justify-center rounded-full border border-line bg-bg text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          isMobile ? "h-11 w-11" : "p-1"
        }`}
        aria-label={t("trash.deleteProject")}
        title={t("trash.deleteProject")}
        disabled={busy}
        onClick={() => void prepare()}
      >
        {busy ? <span className="text-[10px] font-bold">…</span> : <Trash2 className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />}
      </button>
      {error ? <span className="max-w-[180px] truncate text-[10.5px] font-semibold text-err">{error}</span> : null}
    </span>
  );
}
