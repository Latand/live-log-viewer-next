"use client";

import { Download, ExternalLink, FileWarning, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { classifyArtifact, type ArtifactKind } from "@/lib/artifact/classify";
import { useLocale, type TFunction } from "@/lib/i18n";

import { useModalLayer } from "../modalLayer";
import {
  artifactBasename,
  artifactContentUrl,
  artifactMetaUrl,
  failureFromStatus,
  formatBytes,
  type ArtifactFailure,
  type ArtifactMeta,
} from "./artifactResource";
import { ImagePane } from "./ImagePane";
import { onArtifactPreview } from "./previewBus";
import { TextPane } from "./TextPane";

/* pdf.js is megabytes; its chunk must not exist on the network until the first
   PDF preview actually opens. */
const PdfPane = lazy(() => import("./PdfPane"));

const WIDTH_KEY = "llvPreviewWidth";
const MIN_WIDTH = 380;
/** Keep at least this much conversation visible beside the desktop sheet. */
const MIN_CONVERSATION = 320;

interface OpenRequest {
  path: string;
  /** Bumps on every open so re-opening the same path restarts its load. */
  nonce: number;
}

function kindLabel(t: TFunction, kind: ArtifactKind | null): string {
  if (kind === "pdf") return t("preview.kindPdf");
  if (kind === "image") return t("preview.kindImage");
  if (kind === "text") return t("preview.kindText");
  return t("preview.kindUnknown");
}

function failureCopy(t: TFunction, failure: ArtifactFailure): string {
  if (failure === "missing") return t("preview.missing");
  if (failure === "denied") return t("preview.denied");
  if (failure === "unsupported") return t("preview.unsupported");
  if (failure === "oversized") return t("preview.oversized");
  if (failure === "changed") return t("preview.changed");
  if (failure === "aborted") return t("preview.aborted");
  return t("preview.error");
}

function storedWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const value = Number(raw);
    if (Number.isFinite(value) && value >= MIN_WIDTH) return value;
  } catch {
    /* private mode */
  }
  return 560;
}

/**
 * The ONE in-app document preview surface (issue #875). Mounted once in the
 * Viewer shell; any rendered artifact link opens it through the preview bus.
 * Pure same-document React state: opening, switching and closing write nothing
 * to the URL, history, board or transcript, and trigger no snapshot or scan —
 * the only network the surface owns is /api/artifact.
 */
export function ArtifactPreviewHost({ mobile }: { mobile: boolean }) {
  const [open, setOpen] = useState<OpenRequest | null>(null);
  useEffect(
    () =>
      onArtifactPreview((request) => {
        setOpen((previous) => ({ path: request.path, nonce: (previous?.nonce ?? 0) + 1 }));
      }),
    [],
  );
  const close = useCallback(() => setOpen(null), []);
  if (!open) return null;
  return <PreviewSheet key="sheet" open={open} mobile={mobile} onClose={close} onReload={setOpen} />;
}

function PreviewSheet({
  open,
  mobile,
  onClose,
  onReload,
}: {
  open: OpenRequest;
  mobile: boolean;
  onClose: () => void;
  onReload: (next: OpenRequest) => void;
}) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [meta, setMeta] = useState<ArtifactMeta | null>(null);
  const [failure, setFailure] = useState<ArtifactFailure | null>(null);
  const [width, setWidth] = useState(storedWidth);
  useModalLayer({ containerRef, onClose });

  /* eslint-disable react-hooks/set-state-in-effect -- the meta round-trip is
     the load this surface exists for; reset + fetch keyed to the open nonce. */
  useEffect(() => {
    setMeta(null);
    setFailure(null);
    const controller = new AbortController();
    void fetch(artifactMetaUrl(open.path), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          setFailure(failureFromStatus(response.status));
          return;
        }
        setMeta((await response.json()) as ArtifactMeta);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailure("error");
      });
    return () => controller.abort();
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* Desktop resize: pointer-drag on the left edge, clamped so the conversation
     stays visible; persisted so the next preview opens at the same width. */
  const resizeFrom = useCallback(
    (down: PointerEvent | { clientX: number }) => {
      const move = (event: PointerEvent) => {
        const next = Math.min(
          Math.max(MIN_WIDTH, window.innerWidth - event.clientX),
          Math.max(MIN_WIDTH, window.innerWidth - MIN_CONVERSATION),
        );
        setWidth(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setWidth((value) => {
          try {
            window.localStorage.setItem(WIDTH_KEY, String(value));
          } catch {
            /* private mode */
          }
          return value;
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      void down;
    },
    [],
  );

  const name = meta?.name ?? artifactBasename(open.path);
  const kind = meta?.kind ?? classifyArtifact(open.path)?.kind ?? null;
  const state = failure ?? (meta ? "ready" : "loading");
  const reload = useCallback(
    () => onReload({ path: open.path, nonce: open.nonce + 1 }),
    [onReload, open],
  );
  const onPaneFailure = useCallback((code: ArtifactFailure) => setFailure(code), []);

  const body = failure ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <FileWarning className="h-8 w-8 text-warning" aria-hidden />
      <div className="max-w-[340px] text-[13px] font-semibold text-primary">{failureCopy(t, failure)}</div>
      {meta ? <div className="text-[12px] text-muted">{formatBytes(meta.size)}</div> : null}
      {failure === "changed" || failure === "error" || failure === "aborted" ? (
        <button
          type="button"
          className="rounded-[8px] border border-border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={reload}
        >
          {t("preview.reload")}
        </button>
      ) : null}
    </div>
  ) : !meta ? (
    <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted" role="status">
      {t("preview.loading")}
    </div>
  ) : meta.kind === "text" ? (
    <TextPane key={`${open.nonce}`} path={open.path} meta={meta} mobile={mobile} onFailure={onPaneFailure} />
  ) : meta.kind === "image" ? (
    <ImagePane key={`${open.nonce}`} path={open.path} meta={meta} mobile={mobile} onFailure={onPaneFailure} />
  ) : (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted" role="status">
          {t("preview.loading")}
        </div>
      }
    >
      <PdfPane key={`${open.nonce}`} path={open.path} etag={meta.etag} mobile={mobile} onFailure={onPaneFailure} />
    </Suspense>
  );

  /* Portal to <body>: feed rows live under transformed board panes, and the
     sheet must anchor to the viewport, not a pane. */
  return createPortal(
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t("preview.dialogTitle", { name })}
      data-artifact-preview
      data-artifact-state={state}
      data-artifact-kind={kind ?? ""}
      className={`fixed z-50 flex flex-col border-border bg-card shadow-1 focus-visible:outline-none ${
        mobile ? "inset-0" : "inset-y-0 right-0 border-l"
      }`}
      style={mobile ? undefined : { width: `min(${width}px, calc(100vw - ${MIN_CONVERSATION}px))` }}
    >
      {mobile ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("preview.resize")}
          title={t("preview.resize")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-accent/30"
          onPointerDown={(event) => {
            event.preventDefault();
            resizeFrom(event.nativeEvent);
          }}
        />
      )}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold text-primary" title={name}>
            {name}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <span>{kindLabel(t, kind)}</span>
            {meta ? <span aria-hidden>·</span> : null}
            {meta ? <span>{formatBytes(meta.size)}</span> : null}
          </div>
        </div>
        <a
          href={artifactContentUrl(open.path, { download: true })}
          download={name}
          aria-label={t("preview.download")}
          title={t("preview.download")}
          className={`flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11 w-11" : "h-7 w-7"}`}
        >
          <Download className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden />
        </a>
        <a
          href={artifactContentUrl(open.path)}
          target="_blank"
          rel="noreferrer"
          aria-label={t("preview.openExternal")}
          title={t("preview.openExternal")}
          className={`flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11 w-11" : "h-7 w-7"}`}
        >
          <ExternalLink className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden />
        </a>
        <button
          type="button"
          aria-label={t("preview.close")}
          title={t("preview.close")}
          onClick={onClose}
          className={`flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11 w-11" : "h-7 w-7"}`}
        >
          <X className={mobile ? "h-5 w-5" : "h-4 w-4"} aria-hidden />
        </button>
      </div>
      {body}
    </div>,
    document.body,
  );
}
