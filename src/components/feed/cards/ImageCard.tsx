"use client";

import { useState } from "react";

import { GlyphIcon } from "../../icons";
import { Lightbox } from "../Lightbox";
import { tr } from "../parse";

type ImageView = "chip" | "thumb" | "full";

export function ImageCard({ media, data, w, h, bytes }: { media: string; data: string; w?: number; h?: number; bytes?: number }) {
  /* Screenshots carry the story of an agent run, so they open as thumbnails right away. */
  const [view, setView] = useState<ImageView>("thumb");
  const kb = Math.round((bytes ?? (data.length * 3) / 4) / 1024);
  const dims = w && h ? `${w}×${h}` : tr("render.image");
  if (view === "chip") {
    return (
      <button
        type="button"
        onClick={() => setView("thumb")}
        className="my-2 ml-9 flex items-center gap-2 rounded-[14px] border border-border bg-card px-3.5 py-2 text-[13px] shadow-1"
      >
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-sunken">
          <GlyphIcon name="image" className="h-4 w-4" />
        </span>
        <span className="font-semibold">{dims}</span>
        <span className="text-muted">· {kb} {tr("common.kb")}</span>
        <span className="ml-1 text-[12px] font-semibold text-accent">{tr("common.show")}</span>
      </button>
    );
  }
  const src = `data:${media};base64,${data}`;
  return (
    <div className="my-2 ml-9">
      {/* Lazy insert: the data URI only enters the DOM once expanded. next/image cannot serve a base64 data URI here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`${tr("render.image")} ${dims}`}
        onClick={() => setView("full")}
        className="max-h-[240px] cursor-zoom-in rounded-[14px] border border-border"
      />
      <button type="button" onClick={() => setView("chip")} className="mt-1 block text-[12px] text-muted">
        {tr("common.collapse")}
      </button>
      {view === "full" ? (
        <Lightbox src={src} alt={`${tr("render.image")} ${dims}`} caption={`${dims} · ${kb} ${tr("common.kb")}`} onClose={() => setView("thumb")} />
      ) : null}
    </div>
  );
}
