"use client";

import { useRef, useState } from "react";

import { ArrowRight, ImageIcon, X } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getLocale, translate, useLocale } from "@/lib/i18n";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

export interface PendingImage {
  base64: string;
  mime: string;
  preview: string;
}

function rawBytesFromBase64(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function encodedBytesForRawBytes(value: number): number {
  return Math.ceil(value / 3) * 4;
}

function megabytes(value: number): string {
  return String(Math.round(value / (1024 * 1024) * 10) / 10);
}

function pendingImageLimitError(images: readonly PendingImage[], capability: RuntimeImageCapability | null): string | null {
  if (!capability || images.length === 0) return null;
  if (!capability.supported) return capability.reason ?? translate(getLocale(), "composer.structuredImagesUnavailable");
  if (images.length > capability.maxImages) {
    return translate(getLocale(), "img.tooManyStructured", { max: capability.maxImages });
  }
  if (images.some((image) => rawBytesFromBase64(image.base64) > capability.maxRawBytesPerImage)) {
    return translate(getLocale(), "img.structuredTooLarge", { max: megabytes(capability.maxRawBytesPerImage) });
  }
  const encodedBytes = images.reduce((total, image) => total + image.base64.length, 0);
  if (encodedBytes > capability.maxEncodedBytesPerRequest) {
    return translate(getLocale(), "img.structuredAggregateTooLarge", { max: megabytes(capability.maxEncodedBytesPerRequest) });
  }
  return null;
}

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) {
        reject(new Error(translate(getLocale(), "img.readFailed")));
        return;
      }
      const base64 = dataUrl.slice(comma + 1);
      resolve({ base64, mime: file.type || "image/png", preview: dataUrl });
    };
    reader.onerror = () => reject(reader.error ?? new Error(translate(getLocale(), "img.readFailed")));
    reader.onabort = () => reject(new Error(translate(getLocale(), "img.readAborted")));
    reader.readAsDataURL(file);
  });
}

/**
 * Pending image attachments for a text field: paste from the clipboard or add
 * via a file picker, preview, remove, clear after send. Shared by the pane
 * composer and the spawn dialog so both accept images the same way.
 */
export function useImageAttachments(handlers: {
  onError: (message: string) => void;
  onAdded?: () => void;
  imageCapability?: RuntimeImageCapability | null;
}) {
  const [images, setImages] = useState<PendingImage[]>([]);
  const imagesRef = useRef<PendingImage[]>([]);
  const capability = handlers.imageCapability ?? null;

  const commit = (next: PendingImage[]) => {
    imagesRef.current = next;
    setImages(next);
  };

  const reportPendingLimit = (next: readonly PendingImage[]): boolean => {
    const error = pendingImageLimitError(next, capability);
    if (!error) return true;
    handlers.onError(error);
    return false;
  };

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    if (capability && !capability.supported) {
      handlers.onError(capability.reason ?? translate(getLocale(), "composer.structuredImagesUnavailable"));
      return;
    }
    /* Validated against the same whitelist and size limit the server enforces
       (src/lib/imagePolicy.ts), so a rejected file is reported here instead of
       round-tripping to the API first. */
    const accepted: File[] = [];
    for (const file of files) {
      if (inboxImageExt(file.type) === null) {
        handlers.onError(translate(getLocale(), "img.unsupported", { name: file.name || file.type || translate(getLocale(), "img.unknownFile") }));
        continue;
      }
      const rawLimit = capability?.maxRawBytesPerImage ?? MAX_INBOX_IMAGE_BYTES;
      if (file.size > rawLimit) {
        handlers.onError(capability
          ? translate(getLocale(), "img.structuredTooLarge", { max: megabytes(rawLimit) })
          : translate(getLocale(), "img.tooLarge", { name: file.name || translate(getLocale(), "img.image") }));
        continue;
      }
      accepted.push(file);
    }
    if (!accepted.length) return;
    if (capability) {
      if (imagesRef.current.length + accepted.length > capability.maxImages) {
        handlers.onError(translate(getLocale(), "img.tooManyStructured", { max: capability.maxImages }));
        return;
      }
      const encodedBytes = imagesRef.current.reduce((total, image) => total + image.base64.length, 0)
        + accepted.reduce((total, file) => total + encodedBytesForRawBytes(file.size), 0);
      if (encodedBytes > capability.maxEncodedBytesPerRequest) {
        handlers.onError(translate(getLocale(), "img.structuredAggregateTooLarge", { max: megabytes(capability.maxEncodedBytesPerRequest) }));
        return;
      }
    }
    /* onAdded clears the status line at both call sites; a mixed batch keeps
       the rejection message on screen instead of wiping it right away. */
    const rejectedSome = accepted.length < files.length;
    Promise.all(accepted.map(readImage))
      .then((pending) => {
        const next = [...imagesRef.current, ...pending];
        if (!reportPendingLimit(next)) return;
        commit(next);
        if (!rejectedSome) handlers.onAdded?.();
      })
      .catch((error: unknown) => {
        handlers.onError(error instanceof Error ? error.message : translate(getLocale(), "img.error"));
      });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const picks = Array.from(event.clipboardData.items)
      .filter((entry) => entry.type.startsWith("image/"))
      .map((entry) => entry.getAsFile())
      .filter((entry): entry is File => entry !== null);
    if (!picks.length) return;
    event.preventDefault();
    addFiles(picks);
  };

  return {
    images,
    addFiles,
    handlePaste,
    removeAt: (idx: number) => commit(imagesRef.current.filter((_, i) => i !== idx)),
    clear: () => commit([]),
    replace: (next: PendingImage[]) => {
      if (!reportPendingLimit(next)) return false;
      commit(next);
      return true;
    },
    validate: () => reportPendingLimit(imagesRef.current),
  };
}

export function ImagePreviewStrip({ images, onRemove }: { images: PendingImage[]; onRemove: (idx: number) => void }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  if (!images.length) return null;
  /* Touch has no hover, so on the phone (finding 3) each pending image is a row
     with a persistent 44px remove target; desktop keeps the compact hover grid. */
  if (isMobile) {
    return (
      <div className="flex flex-col gap-1.5">
        {images.map((image, idx) => (
          <div key={idx} className="flex items-center gap-2 rounded-[8px] border border-border bg-card p-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.preview} alt={t("img.previewAlt", { n: idx + 1 })} className="h-11 w-11 shrink-0 rounded border border-border object-cover" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted">{t("img.previewAlt", { n: idx + 1 })}</span>
            <button
              type="button"
              onClick={() => onRemove(idx)}
              aria-label={t("img.removeAria", { n: idx + 1 })}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
        <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-muted">
          {t("composer.imagesCount", { count: images.length })} <ArrowRight className="h-3 w-3" aria-hidden /> {t("img.deliveryHint")}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {images.map((image, idx) => (
        <div key={idx} className="group/img relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.preview} alt={t("img.previewAlt", { n: idx + 1 })} className="h-10 w-10 rounded border border-border object-cover" />
          <button
            type="button"
            onClick={() => onRemove(idx)}
            aria-label={t("img.removeAria", { n: idx + 1 })}
            className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-muted shadow-1 hover:text-danger group-hover/img:flex focus-visible:flex focus-visible:outline-none"
          >
            <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        </div>
      ))}
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-muted">
        {t("composer.imagesCount", { count: images.length })} <ArrowRight className="h-3 w-3" aria-hidden /> {t("img.deliveryHint")}
      </span>
    </div>
  );
}

/** Hidden file input plus its trigger button, wired to a picker ref it owns
    internally. Shared by the pane composer and the spawn dialog. */
export function ImagePickerButton({
  onFiles,
  ariaLabel,
  className,
  disabled = false,
  disabledReason,
}: {
  onFiles: (files: File[]) => void;
  ariaLabel: string;
  className: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button type="button" aria-label={ariaLabel} title={disabledReason} disabled={disabled} onClick={() => fileRef.current?.click()} className={className}>
        <ImageIcon className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}
