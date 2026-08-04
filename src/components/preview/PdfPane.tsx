"use client";

import { ChevronLeft, ChevronRight, Minus, MoveHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { useLocale } from "@/lib/i18n";

import { artifactContentUrl, failureFromStatus, type ArtifactFailure } from "./artifactResource";

/** pdf.js range chunk: small enough that byte-range loading engages for any
    real document instead of one full-body fetch. */
const RANGE_CHUNK = 64 * 1024;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

type Pdfjs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<Pdfjs> | null = null;

function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist").then((pdfjs) => {
    /* Official webpack recipe: the worker ships as its own emitted asset. */
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  });
  return pdfjsPromise;
}

/**
 * PDF preview on pdf.js: byte-range loading against /api/artifact, page
 * navigation, zoom and fit-width. Destroying the loading task on unmount
 * aborts any in-flight range requests, which the route answers by closing its
 * descriptor.
 */
export default function PdfPane({
  path,
  etag,
  mobile,
  onFailure,
}: {
  path: string;
  /** Meta validator: every pdf.js range request carries it as If-Match, so a
      file replaced mid-load answers 412 → the explicit "changed" state instead
      of splicing bytes from two inodes into a corrupted parse. */
  etag: string;
  mobile: boolean;
  onFailure: (failure: ArtifactFailure) => void;
}) {
  const { t } = useLocale();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    let task: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | null = null;
    let cancelled = false;
    void loadPdfjs()
      .then((pdfjs) => {
        task = pdfjs.getDocument({
          url: artifactContentUrl(path),
          httpHeaders: { "if-match": etag },
          rangeChunkSize: RANGE_CHUNK,
          disableAutoFetch: true,
        });
        return task.promise;
      })
      .then((loaded) => {
        if (!cancelled) setDoc(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = (error as { status?: number }).status;
        onFailure(typeof status === "number" ? failureFromStatus(status) : "error");
      });
    return () => {
      cancelled = true;
      void task?.destroy().catch(() => {});
    };
  }, [path, etag, onFailure]);

  const paint = useCallback(async () => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!doc || !canvas || !frame) return;
    const pdfPage = await doc.getPage(page);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = (fitWidth ? Math.max((frame.clientWidth - 24) / base.width, 0.1) : 1) * zoom;
    const viewport = pdfPage.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderTaskRef.current?.cancel();
    const renderTask = pdfPage.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    renderTaskRef.current = renderTask;
    await renderTask.promise.catch(() => {
      /* superseded by a newer paint */
    });
  }, [doc, page, zoom, fitWidth]);

  useEffect(() => {
    void paint();
  }, [paint]);

  /* Fit-width follows the sheet being resized. */
  useEffect(() => {
    if (!fitWidth || typeof ResizeObserver === "undefined") return;
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => void paint());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [fitWidth, paint]);

  /* Same touch-target contract as the host header: 44 px controls on mobile. */
  const control = mobile ? "h-11 w-11" : "h-7 w-7";
  const icon = mobile ? "h-5 w-5" : "h-3.5 w-3.5";

  const pages = doc?.numPages ?? 0;
  const go = useCallback(
    (delta: number) => setPage((previous) => Math.min(Math.max(previous + delta, 1), Math.max(pages, 1))),
    [pages],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-pdf-pane data-pdf-pages={pages || undefined}>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11.5px] text-muted">
        <button
          type="button"
          aria-label={t("preview.prevPage")}
          title={t("preview.prevPage")}
          disabled={page <= 1}
          onClick={() => go(-1)}
          className={`flex ${control} items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40`}
        >
          <ChevronLeft className={icon} aria-hidden />
        </button>
        <span data-pdf-page-label className="tabular-nums">
          {pages ? t("preview.pageOf", { page: String(page), pages: String(pages) }) : t("preview.loading")}
        </span>
        <button
          type="button"
          aria-label={t("preview.nextPage")}
          title={t("preview.nextPage")}
          disabled={pages === 0 || page >= pages}
          onClick={() => go(1)}
          className={`flex ${control} items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40`}
        >
          <ChevronRight className={icon} aria-hidden />
        </button>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-label={t("lightbox.zoomOut")}
            title={t("lightbox.zoomOut")}
            onClick={() => setZoom((value) => Math.max(value / 1.25, MIN_ZOOM))}
            className={`flex ${control} items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          >
            <Minus className={icon} aria-hidden />
          </button>
          <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label={t("lightbox.zoomIn")}
            title={t("lightbox.zoomIn")}
            onClick={() => setZoom((value) => Math.min(value * 1.25, MAX_ZOOM))}
            className={`flex ${control} items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          >
            <Plus className={icon} aria-hidden />
          </button>
          <button
            type="button"
            aria-pressed={fitWidth}
            aria-label={t("preview.fitWidth")}
            title={t("preview.fitWidth")}
            onClick={() => setFitWidth((value) => !value)}
            className={`flex ${control} items-center justify-center rounded-[8px] border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              fitWidth ? "bg-accent/15 text-accent" : "bg-canvas text-muted hover:text-primary"
            }`}
          >
            <MoveHorizontal className={icon} aria-hidden />
          </button>
        </span>
      </div>
      <div ref={frameRef} className="min-h-0 flex-1 overflow-auto bg-sunken p-3">
        <canvas ref={canvasRef} className="mx-auto block rounded-[6px] bg-white shadow-1" />
      </div>
    </div>
  );
}
