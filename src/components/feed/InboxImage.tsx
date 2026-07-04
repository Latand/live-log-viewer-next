"use client";

import { useEffect, useState } from "react";

import { GlyphIcon, Trash2 } from "../icons";
import { Lightbox } from "./Lightbox";

type View = "chip" | "thumb" | "full";
type Gone = "deleted" | "missing";

/**
 * Attachment card for an image the composer stored under ~/.claude/viewer-inbox
 * and delivered to the agent as a file path. The transcript only carries the
 * path, so the bytes stream through /api/inbox; the card also offers a
 * confirmed delete that removes the file from disk — inbox files otherwise
 * pile up forever, since nothing else ever cleans them.
 */
export function InboxImageCard({ name, path }: { name: string; path: string }) {
  const [view, setView] = useState<View>("thumb");
  const [gone, setGone] = useState<Gone | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const src = `/api/inbox?name=${encodeURIComponent(name)}`;

  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      const res = await fetch(src, { method: "DELETE" });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "не вдалося видалити");
        return;
      }
      setGone("deleted");
    } catch {
      setError("сервер недоступний");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (gone) {
    return (
      <div className="my-2 flex justify-end">
        <span
          className="inline-flex max-w-[75%] items-center gap-1.5 rounded-full border border-line bg-chip px-2.5 py-1 text-[11.5px] font-semibold text-dim"
          title={path}
        >
          <GlyphIcon name="image" className="h-3.5 w-3.5" />
          <span className="truncate">{name}</span>
          <span className="shrink-0">· {gone === "deleted" ? "видалено з диска" : "файла вже немає на диску"}</span>
        </span>
      </div>
    );
  }

  if (view === "chip") {
    return (
      <div className="my-2 flex justify-end">
        <button
          type="button"
          onClick={() => setView("thumb")}
          className="inline-flex max-w-[75%] items-center gap-2 rounded-[14px] border border-line bg-panel px-3.5 py-2 text-[13px] shadow-card"
          title={path}
        >
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip">
            <GlyphIcon name="image" className="h-4 w-4" />
          </span>
          <span className="truncate font-mono text-[12px]">{name}</span>
          <span className="shrink-0 text-[12px] font-semibold text-accent">показати</span>
        </button>
      </div>
    );
  }

  return (
    <div className="my-2 flex justify-end">
      <div className="max-w-[75%]">
        {/* The file lives outside the app; next/image cannot serve it. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`вкладена картинка ${name}`}
          onClick={() => setView("full")}
          onError={() => setGone("missing")}
          className="ml-auto block max-h-[240px] cursor-zoom-in rounded-[14px] border border-line"
        />
        <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5 text-[11px]">
          <span className="min-w-0 truncate font-mono text-dim" title={path}>
            {name}
          </span>
          <button type="button" onClick={() => setView("chip")} className="shrink-0 text-dim hover:text-ink">
            згорнути
          </button>
          {confirming ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-[10px] border border-err/30 bg-[#fff5f5] px-1.5 py-0.5">
              <span className="px-1 font-semibold text-err">Видалити файл з диска?</span>
              <button
                type="button"
                className="rounded-lg bg-err px-2 py-0.5 font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/50"
                disabled={deleting}
                onClick={remove}
              >
                {deleting ? "видаляю…" : "Так, видалити"}
              </button>
              <button
                type="button"
                className="rounded-lg border border-line bg-panel px-2 py-0.5 font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => setConfirming(false)}
              >
                Скасувати
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Видалити ${name} з диска`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-panel px-2 py-0.5 font-semibold text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Trash2 className="h-3 w-3" aria-hidden /> видалити з диска
            </button>
          )}
          {error ? <span className="shrink-0 font-semibold text-err">{error}</span> : null}
        </div>
      </div>
      {view === "full" ? <Lightbox src={src} alt={`вкладена картинка ${name}`} caption={path} onClose={() => setView("thumb")} /> : null}
    </div>
  );
}
