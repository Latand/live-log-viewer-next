"use client";

import { useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";

import { GlyphIcon } from "../../icons";
import { Lightbox } from "../Lightbox";
import { tr } from "../parse";

type ImageView = "chip" | "thumb" | "full";

/**
 * A raster in the feed: a pasted or attached picture, or one an agent read
 * (#1498). `initialView` picks how it opens — a message's picture starts as a
 * thumbnail, a tool result's as the collapsed chip, so a capture run's dozens
 * of frames decode nothing until the operator opens one. `inset` drops the
 * feed-gutter indent for a card that already sits inside a tool body.
 */
export function ImageCard({
  media,
  data,
  w,
  h,
  bytes,
  initialView = "thumb",
  inset = false,
}: {
  media: string;
  data: string;
  w?: number;
  h?: number;
  bytes?: number;
  initialView?: "chip" | "thumb";
  inset?: boolean;
}) {
  /* Screenshots carry the story of an agent run, so a message's picture opens as a thumbnail right away. */
  const [view, setView] = useState<ImageView>(initialView);
  const isMobile = useIsMobile();
  const kb = Math.round((bytes ?? (data.length * 3) / 4) / 1024);
  const dims = w && h ? `${w}×${h}` : tr("render.image");
  const gutter = inset ? "" : "ml-9 ";
  if (view === "chip") {
    return (
      <button
        type="button"
        onClick={() => setView("thumb")}
        className={`my-2 ${gutter}flex max-w-full items-center gap-2 rounded-[14px] border border-border bg-card px-3.5 py-2 text-[13px] shadow-1 [@media(pointer:coarse)]:min-h-11 ${isMobile ? "min-h-11" : ""}`}
      >
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-sunken">
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
    <div className={`my-2 ${gutter}min-w-0`}>
      {/* Lazy insert: the data URI only enters the DOM once expanded. next/image cannot serve a base64 data URI here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`${tr("render.image")} ${dims}`}
        onClick={() => setView("full")}
        className="max-h-[240px] max-w-full cursor-zoom-in rounded-[14px] border border-border object-contain"
      />
      <button type="button" onClick={() => setView("chip")} className="mt-1 block text-[12px] text-muted [@media(pointer:coarse)]:min-h-11">
        {tr("common.collapse")}
      </button>
      {view === "full" ? (
        <Lightbox src={src} alt={`${tr("render.image")} ${dims}`} caption={`${dims} · ${kb} ${tr("common.kb")}`} onClose={() => setView("thumb")} />
      ) : null}
    </div>
  );
}
