"use client";

import { Maximize2, Minus, Plus } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

import { artifactContentUrl, type ArtifactFailure, type ArtifactMeta } from "./artifactResource";

const MIN_SCALE = 0.1;
const MAX_SCALE = 16;

/**
 * Image preview: fit-to-pane by default; zooming switches to a free transform
 * with wheel zoom around the cursor and pointer-drag panning — the Lightbox
 * interaction model, docked into the preview sheet. Intrinsic dimensions come
 * from the decoded image itself.
 */
export function ImagePane({
  path,
  meta,
  onFailure,
}: {
  path: string;
  meta: ArtifactMeta;
  onFailure: (failure: ArtifactFailure) => void;
}) {
  const { t } = useLocale();
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(true);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  const zoomBy = useCallback(
    (factor: number, cx = 0, cy = 0) => {
      setFit(false);
      setScale((previous) => {
        const next = clamp(previous * factor);
        const ratio = next / previous;
        setTx((x) => cx - (cx - x) * ratio);
        setTy((y) => cy - (cy - y) * ratio);
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setFit(true);
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11.5px] text-muted">
        {dims ? (
          <span data-image-dimensions className="tabular-nums">
            {dims.w} × {dims.h}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-label={t("lightbox.zoomOut")}
            title={t("lightbox.zoomOut")}
            onClick={() => zoomBy(1 / 1.4)}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Minus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <span className="w-10 text-center tabular-nums">{fit ? t("preview.fit") : `${Math.round(scale * 100)}%`}</span>
          <button
            type="button"
            aria-label={t("lightbox.zoomIn")}
            title={t("lightbox.zoomIn")}
            onClick={() => zoomBy(1.4)}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t("preview.fitImage")}
            title={t("preview.fitImage")}
            onClick={reset}
            className={`flex h-7 w-7 items-center justify-center rounded-[8px] border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              fit ? "bg-accent/15 text-accent" : "bg-canvas text-muted hover:text-primary"
            }`}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      </div>
      <div
        ref={frameRef}
        className={`relative min-h-0 flex-1 overflow-hidden bg-canvas ${fit ? "" : dragging ? "cursor-grabbing" : "cursor-grab"}`}
        onWheel={(event) => {
          const frame = frameRef.current?.getBoundingClientRect();
          if (!frame) return;
          zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX - frame.left - frame.width / 2, event.clientY - frame.top - frame.height / 2);
        }}
        onPointerDown={(event) => {
          if (fit) return;
          event.preventDefault();
          (event.target as Element).setPointerCapture?.(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, tx, ty };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setTx(drag.current.tx + event.clientX - drag.current.x);
          setTy(drag.current.ty + event.clientY - drag.current.y);
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={(event) => {
          if (fit) {
            const frame = frameRef.current?.getBoundingClientRect();
            if (!frame) return;
            setFit(false);
            setScale(2);
            setTx(0);
            setTy(0);
            void event;
          } else {
            reset();
          }
        }}
      >
        <div className={fit ? "flex h-full w-full items-center justify-center p-3" : "flex h-full w-full items-center justify-center"}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local artifact bytes stream from /api/artifact, next/image cannot serve them */}
          <img
            src={artifactContentUrl(path)}
            alt={meta.name}
            draggable={false}
            onLoad={(event) => {
              const image = event.target as HTMLImageElement;
              setDims({ w: image.naturalWidth, h: image.naturalHeight });
            }}
            onError={() => onFailure("error")}
            className={fit ? "max-h-full max-w-full object-contain" : "max-w-none select-none"}
            style={fit ? undefined : { transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  );
}
