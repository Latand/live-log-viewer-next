"use client";

import { useEffect, useState } from "react";

import { Trash2 } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/**
 * Deletes a conversation's transcript from disk (DELETE /api/log) behind an
 * inline confirmation, mirroring the kill-button pattern. Hidden while the
 * agent process runs — the API refuses that case anyway. `onDeleted` lets the
 * host view drop the node right away instead of waiting out the files poll.
 */
export function DeleteFileButton({ file, onDeleted }: { file: FileEntry; onDeleted?: () => void }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (file.proc === "running") return null;

  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      const res = await fetch(`/api/log?path=${encodeURIComponent(file.path)}`, { method: "DELETE" });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? t("common.failedDelete"));
        return;
      }
      setConfirming(false);
      onDeleted?.();
    } catch {
      setError(t("common.serverUnavailable"));
    } finally {
      setDeleting(false);
    }
  };

  if (confirming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[10px] border border-err/30 bg-[#fff5f5] px-1.5 py-0.5 text-[11px]">
        <span className="px-0.5 font-semibold text-err">{t("delFile.confirm")}</span>
        <button
          type="button"
          className={`inline-flex items-center rounded-lg bg-err font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/50 ${
            isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
          }`}
          disabled={deleting}
          onClick={remove}
        >
          {deleting ? "…" : t("common.yes")}
        </button>
        <button
          type="button"
          className={`inline-flex items-center rounded-lg border border-line bg-panel font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
          }`}
          onClick={() => setConfirming(false)}
        >
          {t("common.no")}
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        className={`inline-flex items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          isMobile ? "h-11 w-11" : "px-1.5 py-0.5"
        }`}
        aria-label={t("delFile.aria")}
        title={t("delFile.aria")}
        onClick={() => setConfirming(true)}
      >
        <Trash2 className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
      </button>
      {error ? (
        <span className="max-w-[160px] truncate text-[10.5px] font-semibold text-err" title={error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
