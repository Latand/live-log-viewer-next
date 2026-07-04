"use client";

import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { X } from "@/components/icons";

interface Props {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

/**
 * Fullscreen image viewer: wheel zooms around the cursor, drag pans, double
 * click toggles fit/200%, Esc or backdrop click closes.
 */
export function Lightbox({ src, alt, caption, onClose }: Props) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  const zoomBy = (factor: number, cx = 0, cy = 0) => {
    const next = clamp(scale * factor);
    const ratio = next / scale;
    /* Keep the point under the cursor stationary while zooming. */
    setScale(next);
    setTx(cx - (cx - tx) * ratio);
    setTy(cy - (cy - ty) * ratio);
  };

  const reset = () => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <div
        className="flex items-center gap-2 px-4 py-2.5"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-white/85">{caption ?? alt}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            className="inline-flex items-center rounded-lg border border-white/25 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label="Зменшити"
            onClick={() => zoomBy(1 / 1.4)}
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <button
            className="rounded-lg border border-white/25 bg-white/10 px-2 py-1 text-[11.5px] font-semibold text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label="Скинути масштаб"
            onClick={reset}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            className="inline-flex items-center rounded-lg border border-white/25 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label="Збільшити"
            onClick={() => zoomBy(1.4)}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          <button
            className="ml-1 inline-flex items-center rounded-lg border border-white/25 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label="Закрити"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </span>
      </div>
      <div
        className="min-h-0 flex-1 touch-none overflow-hidden"
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const cx = event.clientX - rect.left - rect.width / 2;
          const cy = event.clientY - rect.top - rect.height / 2;
          zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18, cx, cy);
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, tx, ty };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setTx(drag.current.tx + (event.clientX - drag.current.x));
          setTy(drag.current.ty + (event.clientY - drag.current.y));
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={() => (scale === 1 ? zoomBy(2) : reset())}
      >
        <div className="flex h-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            className={`max-h-full max-w-full select-none ${dragging ? "" : "transition-transform duration-75"} ${scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  );
}
