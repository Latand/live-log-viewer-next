"use client";

import { useEffect, useState } from "react";

import { Trash2 } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

/**
 * Deletes a conversation's transcript from disk (DELETE /api/log) behind an
 * inline confirmation, mirroring the kill-button pattern. Hidden while the
 * agent process runs — the API refuses that case anyway. `onDeleted` lets the
 * host view drop the node right away instead of waiting out the files poll.
 */
export function DeleteFileButton({ file, onDeleted }: { file: FileEntry; onDeleted?: () => void }) {
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
        setError(json.error ?? "не вдалося видалити");
        return;
      }
      setConfirming(false);
      onDeleted?.();
    } catch {
      setError("сервер недоступний");
    } finally {
      setDeleting(false);
    }
  };

  if (confirming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[10px] border border-err/30 bg-[#fff5f5] px-1.5 py-0.5 text-[11px]">
        <span className="px-0.5 font-semibold text-err">Видалити з диска?</span>
        <button
          type="button"
          className="rounded-lg bg-err px-2 py-0.5 font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/50"
          disabled={deleting}
          onClick={remove}
        >
          {deleting ? "…" : "Так"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-line bg-panel px-2 py-0.5 font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => setConfirming(false)}
        >
          Ні
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        className="inline-flex items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label="Видалити розмову з диска"
        title="Видалити розмову з диска"
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="h-3 w-3" aria-hidden />
      </button>
      {error ? (
        <span className="max-w-[160px] truncate text-[10.5px] font-semibold text-err" title={error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
