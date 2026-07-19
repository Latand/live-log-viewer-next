"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ArrowRight, ImageIcon, Loader2, RotateCw, Trash2, X } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getLocale, translate, useLocale } from "@/lib/i18n";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

/** A settled, deliverable attachment: the ready-only projection the send path,
    limit validation, and `useComposer.canSend` consume. `id` is minted at
    intake and travels to the wire so a late delivery receipt settles the exact
    attachment it carried; it is optional so payloads persisted by older
    sessions (id-less) still type-check and fall back to content matching. */
export interface PendingImage {
  id?: string;
  base64: string;
  mime: string;
  preview: string;
}

export type AttachmentStatus = "reading" | "ready" | "error";

/** One intake slot in the composer tray: committed synchronously as a
    placeholder the instant a file is picked/pasted/dropped, then settled
    independently into `ready` (base64 decoded) or `error` (per-item message +
    retry). One failed read never discards its siblings. */
export interface PendingAttachment {
  id: string;
  status: AttachmentStatus;
  name: string;
  mime: string;
  /** Instant thumbnail (an object URL where the platform supports it) or the
      decoded data URL once ready; "" while a placeholder has no preview yet. */
  preview: string;
  base64?: string;
  error?: string;
  /** Retained in memory so a failed read can be retried without re-picking. */
  file: File;
  /** Whether `preview` is a revocable object URL (vs. a data URL). */
  ownsPreview: boolean;
}

let attachmentSeq = 0;
function mintAttachmentId(): string {
  attachmentSeq += 1;
  return `att-${Date.now().toString(36)}-${attachmentSeq}`;
}

/** Best-effort instant thumbnail. `URL.createObjectURL` is a browser API and
    throws on non-Blob test doubles, so a failure just defers the preview to the
    decoded data URL the read produces. */
function createPreview(file: File): { preview: string; ownsPreview: boolean } {
  try {
    const create = (URL as unknown as { createObjectURL?: (blob: unknown) => string }).createObjectURL;
    if (typeof create === "function") return { preview: create(file), ownsPreview: true };
  } catch {
    /* fall through to a deferred data-URL preview */
  }
  return { preview: "", ownsPreview: false };
}

function revokePreview(attachment: PendingAttachment): void {
  if (!attachment.ownsPreview || !attachment.preview) return;
  try {
    (URL as unknown as { revokeObjectURL?: (url: string) => void }).revokeObjectURL?.(attachment.preview);
  } catch {
    /* best-effort */
  }
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

interface DecodedImage {
  base64: string;
  mime: string;
  dataUrl: string;
}

function readImage(file: File): Promise<DecodedImage> {
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
      resolve({ base64, mime: file.type || "image/png", dataUrl });
    };
    reader.onerror = () => reject(reader.error ?? new Error(translate(getLocale(), "img.readFailed")));
    reader.onabort = () => reject(new Error(translate(getLocale(), "img.readAborted")));
    reader.readAsDataURL(file);
  });
}

/** The ready-only, ordered deliverable projection of a tray. */
function readyImages(attachments: readonly PendingAttachment[]): PendingImage[] {
  const images: PendingImage[] = [];
  for (const attachment of attachments) {
    if (attachment.status === "ready" && attachment.base64) {
      images.push({ id: attachment.id, base64: attachment.base64, mime: attachment.mime, preview: attachment.preview });
    }
  }
  return images;
}

/**
 * Pending image attachments for a text field: paste from the clipboard, pick
 * from the file picker, or drop, previewed progressively and settled
 * independently, removed one at a time or cleared all at once, dropped after
 * send. Shared by the pane composer and the spawn dialog so both accept images
 * the same way.
 *
 * The tray owns a `PendingAttachment[]` intake list (`reading`/`ready`/`error`
 * slots); the send path, limit validation, and `canSend` read the derived,
 * ready-only `images`/`imagesRef` projection so those surfaces stay
 * source-compatible with the old `{ base64, mime, preview }[]` contract.
 */
export function useImageAttachments(handlers: {
  onError: (message: string) => void;
  onAdded?: () => void;
  imageCapability?: RuntimeImageCapability | null;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const imagesRef = useRef<PendingImage[]>([]);
  const unmountedRef = useRef(false);
  const capability = handlers.imageCapability ?? null;

  /* Owned object URLs live exactly as long as the tray: remove/clear revoke
     theirs on the spot, and unmount revokes whatever is left — exactly once,
     since the list is emptied in the same pass. After unmount the tray is
     inert: a FileReader that settles late must neither commit state nor
     resurrect a slot (PR #431). */
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      for (const attachment of attachmentsRef.current) revokePreview(attachment);
      attachmentsRef.current = [];
      imagesRef.current = [];
    };
  }, []);

  const commit = (next: PendingAttachment[]) => {
    if (unmountedRef.current) return;
    attachmentsRef.current = next;
    imagesRef.current = readyImages(next);
    setAttachments(next);
  };

  /* Read-modify-write against the ref, so concurrent per-file settlements and
     removals compose without clobbering one another. */
  const patch = (id: string, apply: (attachment: PendingAttachment) => PendingAttachment) => {
    const next = attachmentsRef.current.map((attachment) => (attachment.id === id ? apply(attachment) : attachment));
    commit(next);
  };

  const images = useMemo(() => readyImages(attachments), [attachments]);

  const reportPendingLimit = (next: readonly PendingImage[]): boolean => {
    const error = pendingImageLimitError(next, capability);
    if (!error) return true;
    handlers.onError(error);
    return false;
  };

  const settle = (id: string, file: File) => {
    readImage(file).then(
      (decoded) => {
        const current = attachmentsRef.current.find((attachment) => attachment.id === id);
        if (!current) return; /* removed while reading — never resurrect */
        const projected = [
          ...readyImages(attachmentsRef.current.filter((attachment) => attachment.id !== id)),
          { id, base64: decoded.base64, mime: decoded.mime, preview: current.preview || decoded.dataUrl },
        ];
        if (pendingImageLimitError(projected, capability)) {
          /* The ready set would breach the host limit — surface it and error the
             slot instead of silently exceeding the budget. */
          handlers.onError(pendingImageLimitError(projected, capability)!);
          patch(id, (attachment) => ({ ...attachment, status: "error", error: translate(getLocale(), "img.error") }));
          return;
        }
        patch(id, (attachment) => ({
          ...attachment,
          status: "ready",
          base64: decoded.base64,
          mime: decoded.mime,
          preview: attachment.preview || decoded.dataUrl,
        }));
      },
      (error: unknown) => {
        if (!attachmentsRef.current.some((attachment) => attachment.id === id)) return;
        patch(id, (attachment) => ({
          ...attachment,
          status: "error",
          error: error instanceof Error ? error.message : translate(getLocale(), "img.error"),
        }));
      },
    );
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
    /* Count and aggregate ceilings are enforced pre-read against file sizes, so
       an over-budget batch is rejected whole before any placeholder mounts —
       the tray never shows a slot that could never deliver. Non-error slots
       (reading or ready) count toward the cap since they all intend to send. */
    const liveCount = attachmentsRef.current.filter((attachment) => attachment.status !== "error").length;
    if (capability) {
      if (liveCount + accepted.length > capability.maxImages) {
        handlers.onError(translate(getLocale(), "img.tooManyStructured", { max: capability.maxImages }));
        return;
      }
      const encodedBytes = attachmentsRef.current.reduce((total, attachment) => total + (attachment.base64?.length ?? encodedBytesForRawBytes(attachment.file.size)), 0)
        + accepted.reduce((total, file) => total + encodedBytesForRawBytes(file.size), 0);
      if (encodedBytes > capability.maxEncodedBytesPerRequest) {
        handlers.onError(translate(getLocale(), "img.structuredAggregateTooLarge", { max: megabytes(capability.maxEncodedBytesPerRequest) }));
        return;
      }
    }
    /* Commit every placeholder synchronously in selection order, then settle
       each read independently: a slow file never blocks its siblings from
       appearing and a failed read errors alone. */
    const placeholders = accepted.map((file): PendingAttachment => {
      const { preview, ownsPreview } = createPreview(file);
      return {
        id: mintAttachmentId(),
        status: "reading",
        name: file.name || translate(getLocale(), "img.image"),
        mime: file.type || "image/png",
        preview,
        file,
        ownsPreview,
      };
    });
    commit([...attachmentsRef.current, ...placeholders]);
    /* onAdded clears the status line at both call sites; a mixed batch keeps
       the rejection message on screen instead of wiping it right away. */
    if (accepted.length === files.length) handlers.onAdded?.();
    for (const placeholder of placeholders) settle(placeholder.id, placeholder.file);
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

  const remove = (id: string) => {
    const target = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (target) revokePreview(target);
    commit(attachmentsRef.current.filter((attachment) => attachment.id !== id));
  };

  const retry = (id: string) => {
    const target = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (!target || target.status !== "error") return;
    patch(id, (attachment) => ({ ...attachment, status: "reading", error: undefined }));
    settle(id, target.file);
  };

  const clearAll = () => {
    for (const attachment of attachmentsRef.current) revokePreview(attachment);
    commit([]);
  };

  const hasReading = attachments.some((attachment) => attachment.status === "reading");
  const hasError = attachments.some((attachment) => attachment.status === "error");

  return {
    /** The full intake list (reading/ready/error) rendered by the tray. */
    attachments,
    /** Ready-only, ordered deliverable projection — the send-path source. */
    images,
    /** Latest committed ready projection, for async send closures whose
        render-scope `images` may be stale by the time a receipt settles. */
    imagesRef,
    /** True while a placeholder is still decoding — Send blocks so no image is
        silently dropped mid-read. */
    hasReading,
    /** True while a slot failed — Send blocks until it is removed or retried. */
    hasError,
    addFiles,
    handlePaste,
    remove,
    retry,
    clearAll,
    /** Drop everything after a send (no confirmation), revoking previews. */
    clear: clearAll,
    replace: (next: PendingImage[]) => {
      if (!reportPendingLimit(next)) return false;
      for (const attachment of attachmentsRef.current) revokePreview(attachment);
      commit(next.map((image): PendingAttachment => ({
        id: image.id ?? mintAttachmentId(),
        status: "ready",
        name: translate(getLocale(), "img.image"),
        mime: image.mime,
        preview: image.preview,
        base64: image.base64,
        file: new File([], translate(getLocale(), "img.image"), { type: image.mime }),
        ownsPreview: false,
      })));
      return true;
    },
    validate: () => reportPendingLimit(imagesRef.current),
  };
}

export type UseImageAttachmentsReturn = ReturnType<typeof useImageAttachments>;

/** The composer's pending-image tray: a bounded, touch-scroll horizontal strip
    on the phone (persistent 44px removes, per-item spinner/error, retry, and a
    clear-all once two or more are staged) and a compact hover grid on desktop.
    Progressive: `reading` slots show a spinner, `error` slots a retry, `ready`
    slots the thumbnail — all in selection order, never blocking typing. */
export function ImagePreviewStrip({
  attachments,
  onRemove,
  onRetry,
  onClearAll,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onClearAll: () => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  if (!attachments.length) return null;
  const readyCount = attachments.filter((attachment) => attachment.status === "ready").length;

  const clearAll = attachments.length >= 2 ? (
    <button
      type="button"
      onClick={onClearAll}
      aria-label={t("img.clearAllAria")}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-canvas font-semibold text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "h-11 px-3 text-[11px]" : "h-6 px-2 text-[10.5px]"
      }`}
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden /> {t("img.clearAll")}
    </button>
  ) : null;

  const hint = (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold text-muted">
      {t("composer.imagesCount", { count: readyCount || attachments.length })} <ArrowRight className="h-3 w-3" aria-hidden /> {t("img.deliveryHint")}
    </span>
  );

  if (isMobile) {
    /* One bounded, horizontally scrolling row (issue #419): `min-w-0 max-w-full`
       and `overflow-x-auto overscroll-x-contain` keep it from ever widening the
       document, and the fixed height keeps the transcript above dominant. */
    return (
      <div className="flex min-w-0 max-w-full flex-col gap-1.5">
        <div
          data-testid="attachment-tray"
          className="no-scrollbar flex min-w-0 max-w-full items-stretch gap-2 overflow-x-auto overscroll-x-contain pb-0.5"
        >
          {attachments.map((attachment, idx) => (
            <MobileAttachmentTile key={attachment.id} attachment={attachment} index={idx} onRemove={onRemove} onRetry={onRetry} />
          ))}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          {hint}
          {clearAll}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5" data-testid="attachment-tray">
      {attachments.map((attachment, idx) => (
        <DesktopAttachmentTile key={attachment.id} attachment={attachment} index={idx} onRemove={onRemove} onRetry={onRetry} />
      ))}
      {hint}
      {clearAll}
    </div>
  );
}

function statusBadge(attachment: PendingAttachment, t: ReturnType<typeof useLocale>["t"], index: number) {
  if (attachment.status === "reading") {
    return (
      <span className="absolute inset-0 flex items-center justify-center rounded bg-canvas/70" aria-label={t("img.readingAria", { n: index + 1 })}>
        <Loader2 className="h-4 w-4 animate-spin text-muted" aria-hidden />
      </span>
    );
  }
  if (attachment.status === "error") {
    return (
      <span className="absolute inset-0 flex items-center justify-center rounded bg-danger/10" aria-hidden>
        <span className="text-[10px] font-bold uppercase text-danger">!</span>
      </span>
    );
  }
  return null;
}

function Thumb({ attachment, index }: { attachment: PendingAttachment; index: number }) {
  const { t } = useLocale();
  if (attachment.status === "ready" && attachment.preview) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src={attachment.preview} alt={t("img.previewAlt", { n: index + 1 })} className="h-full w-full rounded border border-border object-cover" />;
  }
  if (attachment.preview) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src={attachment.preview} alt={t("img.previewAlt", { n: index + 1 })} className="h-full w-full rounded border border-border object-cover opacity-60" />;
  }
  return <span className="flex h-full w-full items-center justify-center rounded border border-border bg-sunken text-muted" aria-hidden><ImageIcon className="h-4 w-4" /></span>;
}

function MobileAttachmentTile({ attachment, index, onRemove, onRetry }: { attachment: PendingAttachment; index: number; onRemove: (id: string) => void; onRetry: (id: string) => void }) {
  const { t } = useLocale();
  return (
    <div className="relative flex h-16 w-16 shrink-0 flex-col" data-testid="attachment-tile" data-status={attachment.status}>
      <span className="relative h-16 w-16">
        <Thumb attachment={attachment} index={index} />
        {statusBadge(attachment, t, index)}
      </span>
      {/* Persistent 44px remove target (touch has no hover): a 24px visual chip
          with an inset-inflated hit area. */}
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={t("img.removeAria", { n: index + 1 })}
        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted shadow-1 before:absolute before:-inset-2.5 before:content-[''] hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
      {attachment.status === "error" ? (
        <button
          type="button"
          onClick={() => onRetry(attachment.id)}
          aria-label={t("img.retryAria", { n: index + 1 })}
          className="absolute inset-x-0 -bottom-1 mx-auto flex h-5 items-center justify-center gap-0.5 rounded-full border border-border bg-card px-1.5 text-[9px] font-bold text-warning before:absolute before:-inset-2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <RotateCw className="h-3 w-3" aria-hidden /> {t("img.retry")}
        </button>
      ) : null}
    </div>
  );
}

function DesktopAttachmentTile({ attachment, index, onRemove, onRetry }: { attachment: PendingAttachment; index: number; onRemove: (id: string) => void; onRetry: (id: string) => void }) {
  const { t } = useLocale();
  return (
    <div className="group/img relative h-10 w-10" data-testid="attachment-tile" data-status={attachment.status}>
      <Thumb attachment={attachment} index={index} />
      {statusBadge(attachment, t, index)}
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={t("img.removeAria", { n: index + 1 })}
        className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-muted shadow-1 hover:text-danger group-hover/img:flex focus-visible:flex focus-visible:outline-none"
      >
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>
      {attachment.status === "error" ? (
        <button
          type="button"
          onClick={() => onRetry(attachment.id)}
          aria-label={t("img.retryAria", { n: index + 1 })}
          className="absolute -bottom-1 left-1/2 flex h-4 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card px-1 text-[8px] font-bold text-warning focus-visible:outline-none"
        >
          <RotateCw className="h-2.5 w-2.5" aria-hidden />
        </button>
      ) : null}
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
