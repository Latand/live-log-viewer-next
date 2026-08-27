"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ArrowRight, FileText, ImageIcon, Loader2, Paperclip, RotateCw, Trash2, X } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getLocale, translate, useLocale } from "@/lib/i18n";
/* The refusal contract has ONE home, consumed by every composer (#1224): the
   tray screens an intake here and renders the whole gesture's refusals with the
   same words the task composer uses. */
import {
  attachmentDisplayName,
  refusalStatusText,
  screenAttachments,
  type AttachmentKind,
  type AttachmentRefusal,
} from "@/lib/attachmentIntake";
import { attachmentMegabytes } from "@/lib/filePolicy";
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

/** A settled, deliverable non-image attachment: the bytes and the operator's
    own filename, which the inbox preserves as the basename so the path the
    agent is handed still says what the file is. */
export interface PendingFile {
  id: string;
  name: string;
  mime: string;
  base64: string;
}

/** What survives a persisted draft for a non-image attachment: the operator's
    own filename and its type, never the bytes (issue #1224). Enough to name the
    file that has to be attached again, and small enough for the synchronous
    session storage a document's base64 could never fit. */
export interface RestoredFile {
  id?: string;
  name: string;
  mime?: string;
}

/** One intake slot in the composer tray: committed synchronously as a
    placeholder the instant a file is picked/pasted/dropped, then settled
    independently into `ready` (base64 decoded) or `error` (per-item message +
    retry). One failed read never discards its siblings. */
export interface PendingAttachment {
  id: string;
  kind: AttachmentKind;
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

function pendingImageLimitError(images: readonly PendingImage[], capability: RuntimeImageCapability | null): string | null {
  if (!capability || images.length === 0) return null;
  if (!capability.supported) return capability.reason ?? translate(getLocale(), "composer.structuredImagesUnavailable");
  if (images.length > capability.maxImages) {
    return translate(getLocale(), "img.tooManyStructured", { max: capability.maxImages });
  }
  if (images.some((image) => rawBytesFromBase64(image.base64) > capability.maxRawBytesPerImage)) {
    return translate(getLocale(), "img.structuredTooLarge", { max: attachmentMegabytes(capability.maxRawBytesPerImage) });
  }
  const encodedBytes = images.reduce((total, image) => total + image.base64.length, 0);
  if (encodedBytes > capability.maxEncodedBytesPerRequest) {
    return translate(getLocale(), "img.structuredAggregateTooLarge", { max: attachmentMegabytes(capability.maxEncodedBytesPerRequest) });
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

/** The ready-only, ordered deliverable projection of a tray's images. */
function readyImages(attachments: readonly PendingAttachment[]): PendingImage[] {
  const images: PendingImage[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.status === "ready" && attachment.base64) {
      images.push({ id: attachment.id, base64: attachment.base64, mime: attachment.mime, preview: attachment.preview });
    }
  }
  return images;
}

/** The same projection for everything that is not an image (issue #1224). */
function readyFiles(attachments: readonly PendingAttachment[]): PendingFile[] {
  const files: PendingFile[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "file" && attachment.status === "ready" && attachment.base64) {
      files.push({ id: attachment.id, name: attachment.name, mime: attachment.mime, base64: attachment.base64 });
    }
  }
  return files;
}

/**
 * Pending attachments for a text field: paste from the clipboard, pick from the
 * file picker, or drop, previewed progressively and settled independently,
 * removed one at a time or cleared all at once, dropped after send. Shared by
 * the pane composer and the spawn dialog so both accept attachments the same
 * way.
 *
 * The tray owns a `PendingAttachment[]` intake list (`reading`/`ready`/`error`
 * slots); the send path, limit validation, and `canSend` read the derived,
 * ready-only `images`/`imagesRef` projection so those surfaces stay
 * source-compatible with the old `{ base64, mime, preview }[]` contract, plus
 * the `files`/`filesRef` projection for everything that is not an image.
 *
 * `acceptFiles` is what separates the two composers (issue #1224): the pane
 * composer delivers a general file by writing it to the inbox and naming its
 * path, so it takes anything; a surface with no such road says so out loud
 * instead of dropping the file on the floor.
 */
export function useImageAttachments(handlers: {
  onError: (message: string) => void;
  onAdded?: () => void;
  imageCapability?: RuntimeImageCapability | null;
  acceptFiles?: boolean;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const imagesRef = useRef<PendingImage[]>([]);
  const filesRef = useRef<PendingFile[]>([]);
  const unmountedRef = useRef(false);
  const capability = handlers.imageCapability ?? null;
  const acceptFiles = handlers.acceptFiles === true;

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
      filesRef.current = [];
    };
  }, []);

  const commit = (next: PendingAttachment[]) => {
    if (unmountedRef.current) return;
    attachmentsRef.current = next;
    imagesRef.current = readyImages(next);
    filesRef.current = readyFiles(next);
    setAttachments(next);
  };

  /* Read-modify-write against the ref, so concurrent per-file settlements and
     removals compose without clobbering one another. */
  const patch = (id: string, apply: (attachment: PendingAttachment) => PendingAttachment) => {
    const next = attachmentsRef.current.map((attachment) => (attachment.id === id ? apply(attachment) : attachment));
    commit(next);
  };

  const images = useMemo(() => readyImages(attachments), [attachments]);
  const files = useMemo(() => readyFiles(attachments), [attachments]);

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
        /* THE INVARIANT: no slot sits in `ready` while the deliverable
           projection excludes it. `readyImages`/`readyFiles` both require
           bytes, so a read that came back with none has to error here — a
           `ready` tile that cannot be delivered claims delivery and then
           leaves with the send, which is the silent discard #1224 removes. */
        if (!decoded.base64) {
          const name = current.name || attachmentDisplayName(current.file, current.kind);
          const message = refusalStatusText([{ name, reason: translate(getLocale(), "attach.empty") }]);
          handlers.onError(message);
          patch(id, (attachment) => ({ ...attachment, status: "error", base64: undefined, error: message }));
          return;
        }
        if (current.kind === "file") {
          /* A file carries no preview and consults no image capability: its
             bytes go to the inbox and the message names the path (#1224). */
          patch(id, (attachment) => ({ ...attachment, status: "ready", base64: decoded.base64 }));
          return;
        }
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
        const current = attachmentsRef.current.find((attachment) => attachment.id === id);
        if (!current) return;
        patch(id, (attachment) => ({
          ...attachment,
          status: "error",
          error: error instanceof Error
            ? error.message
            : translate(getLocale(), current.kind === "file" ? "attach.error" : "img.error"),
        }));
      },
    );
  };

  const addFiles = (input: File[]) => {
    if (!input.length) return;
    /* The screen — and every sentence it produces — is the shared one (#1224).
       Every refusal in ONE intake is accumulated and written to the status as a
       single message: `onError` owns a single slot, so a call per file left
       only the last refusal on screen and every other refused file disappeared
       unnamed, which is the silent discard this issue exists to remove in a new
       form. Non-error slots (reading or ready) count toward the caps since they
       all intend to send. */
    const liveFiles = attachmentsRef.current.filter((attachment) => attachment.kind === "file" && attachment.status !== "error");
    const screened = screenAttachments(input, {
      acceptFiles,
      imageCapability: capability,
      staged: {
        files: liveFiles.length,
        bytes: liveFiles.reduce((total, attachment) => total + attachment.file.size, 0),
      },
    });
    let accepted = screened.accepted;
    const refusals: AttachmentRefusal[] = [...screened.refusals];
    const reportRefusals = (): boolean => {
      if (!refusals.length) return false;
      handlers.onError(refusalStatusText(refusals));
      return true;
    };

    /* The one budget the shared screen cannot weigh: the host's negotiated
       image request budget, which is measured in ENCODED bytes against slots
       already staged in this tray. A breach refuses the IMAGES by name rather
       than the whole batch — a document in the same gesture is not over any
       budget of its own. */
    const acceptedImages = accepted.filter((entry) => entry.kind === "image");
    if (capability && acceptedImages.length) {
      const liveImages = attachmentsRef.current.filter((attachment) => attachment.kind === "image" && attachment.status !== "error");
      const encodedBytes = liveImages.reduce((total, attachment) => total + (attachment.base64?.length ?? encodedBytesForRawBytes(attachment.file.size)), 0)
        + acceptedImages.reduce((total, entry) => total + encodedBytesForRawBytes(entry.file.size), 0);
      const overBudget = liveImages.length + acceptedImages.length > capability.maxImages
        ? translate(getLocale(), "img.tooManyStructured", { max: capability.maxImages })
        : encodedBytes > capability.maxEncodedBytesPerRequest
          ? translate(getLocale(), "img.structuredAggregateTooLarge", { max: attachmentMegabytes(capability.maxEncodedBytesPerRequest) })
          : null;
      if (overBudget) {
        for (const entry of acceptedImages) {
          refusals.push({ name: attachmentDisplayName(entry.file, "image"), reason: overBudget });
        }
        accepted = accepted.filter((entry) => entry.kind !== "image");
      }
    }

    if (!accepted.length) {
      reportRefusals();
      return;
    }
    /* Commit every placeholder synchronously in selection order, then settle
       each read independently: a slow file never blocks its siblings from
       appearing and a failed read errors alone. */
    const placeholders = accepted.map(({ file, kind }): PendingAttachment => {
      /* A document has no thumbnail to show; its tile carries the filename. */
      const { preview, ownsPreview } = kind === "image" ? createPreview(file) : { preview: "", ownsPreview: false };
      return {
        id: mintAttachmentId(),
        kind,
        status: "reading",
        name: attachmentDisplayName(file, kind),
        mime: file.type || (kind === "image" ? "image/png" : "application/octet-stream"),
        preview,
        file,
        ownsPreview,
      };
    });
    commit([...attachmentsRef.current, ...placeholders]);
    /* onAdded clears the status line at both call sites; a mixed batch keeps
       the rejection message on screen instead of wiping it right away. */
    if (!reportRefusals()) handlers.onAdded?.();
    for (const placeholder of placeholders) settle(placeholder.id, placeholder.file);
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

  const settleDelivered = (delivered: readonly PendingImage[], deliveredFiles: readonly PendingFile[] = []) => {
    const remaining = [...attachmentsRef.current];
    let changed = false;
    for (const sent of delivered) {
      const index = sent.id
        ? remaining.findIndex((attachment) => attachment.id === sent.id)
        : remaining.findIndex((attachment) =>
          attachment.kind === "image"
          && attachment.status === "ready"
          && attachment.base64 === sent.base64
          && attachment.mime === sent.mime);
      if (index < 0) continue;
      const [settled] = remaining.splice(index, 1);
      if (settled) revokePreview(settled);
      changed = true;
    }
    /* File slots settle by their intake id only: two attachments of the same
       name are two files, and a late receipt must never consume the one staged
       for the NEXT message. */
    for (const sent of deliveredFiles) {
      const index = remaining.findIndex((attachment) => attachment.kind === "file" && attachment.id === sent.id);
      if (index < 0) continue;
      remaining.splice(index, 1);
      changed = true;
    }
    if (changed) commit(remaining);
  };

  const hasReading = attachments.some((attachment) => attachment.status === "reading");
  const hasError = attachments.some((attachment) => attachment.status === "error");
  const hasFiles = attachments.some((attachment) => attachment.kind === "file");

  return {
    /** The full intake list (reading/ready/error) rendered by the tray. */
    attachments,
    /** Ready-only, ordered deliverable projection — the send-path source. */
    images,
    /** The same, for non-image attachments delivered by inbox path (#1224). */
    files,
    /** True while any staged slot is a file, so the surrounding copy can stop
        saying "images" when it no longer means only images. */
    hasFiles,
    /** Whether this tray takes anything or images only — the picker widens its
        `accept` to match, so a phone offers the Files app. */
    acceptsFiles: acceptFiles,
    /** Latest committed ready projection, for async send closures whose
        render-scope `images` may be stale by the time a receipt settles. */
    imagesRef,
    filesRef,
    /** True while a placeholder is still decoding — Send blocks so no image is
        silently dropped mid-read. */
    hasReading,
    /** True while a slot failed — Send blocks until it is removed or retried. */
    hasError,
    addFiles,
    remove,
    retry,
    clearAll,
    /** Settle a delivered snapshot against the full intake list. Exact intake
        ids remove only the slots sent on that generation, keeping later
        reading/error slots and every survivor's owned preview alive. */
    settleDelivered,
    /** Drop everything after a send (no confirmation), revoking previews. */
    clear: clearAll,
    /* Restores a persisted draft tray. Images come back whole, because their
       bytes are small enough to persist; a general attachment comes back as a
       NAMED, un-restored slot and never as bytes (#1224). A document's base64
       does not fit synchronous browser storage, so the alternative to naming it
       is the file evaporating on a card switch or a phone tab restore with
       nothing said — the same treatment the outbox gives `needsReattach`. */
    replace: (next: PendingImage[], files: readonly RestoredFile[] = []) => {
      if (!reportPendingLimit(next)) return false;
      for (const attachment of attachmentsRef.current) revokePreview(attachment);
      const restoredImages = next.map((image): PendingAttachment => ({
        id: image.id ?? mintAttachmentId(),
        kind: "image",
        status: "ready",
        name: translate(getLocale(), "img.image"),
        mime: image.mime,
        preview: image.preview,
        base64: image.base64,
        file: new File([], translate(getLocale(), "img.image"), { type: image.mime }),
        ownsPreview: false,
      }));
      const restoredFiles = files.map((file): PendingAttachment => {
        const name = file.name || translate(getLocale(), "attach.file");
        return {
          id: file.id ?? mintAttachmentId(),
          kind: "file",
          /* `error` is what blocks Send and shows the reason: the slot must not
             read as deliverable when the bytes are gone. */
          status: "error",
          name,
          mime: file.mime || "application/octet-stream",
          preview: "",
          error: refusalStatusText([{ name, reason: translate(getLocale(), "attach.notRestored") }]),
          file: new File([], name, { type: file.mime || "application/octet-stream" }),
          ownsPreview: false,
        };
      });
      commit([...restoredImages, ...restoredFiles]);
      return true;
    },
    validate: () => reportPendingLimit(imagesRef.current),
  };
}

export type UseImageAttachmentsReturn = ReturnType<typeof useImageAttachments>;

/** The composer's pending-attachment tray: a bounded, touch-scroll horizontal
    strip on the phone (persistent 44px removes, per-item spinner/error, retry,
    and a clear-all once two or more are staged) and a compact hover grid on
    desktop. Progressive: `reading` slots show a spinner, `error` slots a retry,
    `ready` slots the thumbnail — all in selection order, never blocking typing.
    A non-image slot shows its filename instead of a thumbnail, because the name
    is the only thing that identifies it (#1224). */
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
  /* The copy follows what is actually staged: "2 images" while they are images,
     "2 attachments" the moment one of them is not (#1224). */
  const hasFiles = attachments.some((attachment) => attachment.kind === "file");
  const countKey = hasFiles ? "composer.attachmentsCount" : "composer.imagesCount";
  const countLabel = t(countKey, { count: readyCount || attachments.length });

  const clearAll = attachments.length >= 2 ? (
    <button
      type="button"
      onClick={onClearAll}
      aria-label={t(hasFiles ? "attach.clearAllAria" : "img.clearAllAria")}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-canvas font-semibold text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "h-11 px-3 text-[11px]" : "h-6 px-2 text-[10.5px]"
      }`}
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden /> {t("img.clearAll")}
    </button>
  ) : null;

  const hint = (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold text-muted">
      {countLabel} <ArrowRight className="h-3 w-3" aria-hidden /> {t("img.deliveryHint")}
    </span>
  );

  if (isMobile) {
    /* One bounded, horizontally scrolling first row (issue #440). Compact
       thumbnails and in-row actions keep every slot reachable while the
       transcript retains the remaining height. */
    return (
      <div
        data-testid="attachment-tray"
        aria-label={countLabel}
        className="no-scrollbar flex max-h-16 min-w-0 max-w-full items-center gap-2 overflow-x-auto overscroll-x-contain px-2 pb-1 pt-2"
      >
        {attachments.map((attachment, idx) => (
          <MobileAttachmentTile key={attachment.id} attachment={attachment} index={idx} onRemove={onRemove} onRetry={onRetry} />
        ))}
        {clearAll}
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

/** Per-slot copy, so a file's controls never say "image" (#1224). The file
    variants name the file, which is the only thing that tells two apart. */
function slotLabels(attachment: PendingAttachment, t: ReturnType<typeof useLocale>["t"], index: number) {
  if (attachment.kind === "file") {
    return {
      reading: t("attach.readingAria", { name: attachment.name }),
      remove: t("attach.removeAria", { name: attachment.name }),
      retry: t("attach.retryAria", { name: attachment.name }),
    };
  }
  return {
    reading: t("img.readingAria", { n: index + 1 }),
    remove: t("img.removeAria", { n: index + 1 }),
    retry: t("img.retryAria", { n: index + 1 }),
  };
}

function statusBadge(attachment: PendingAttachment, t: ReturnType<typeof useLocale>["t"], index: number) {
  if (attachment.status === "reading") {
    return (
      <span className="absolute inset-0 flex items-center justify-center rounded bg-canvas/70" aria-label={slotLabels(attachment, t, index).reading}>
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
  if (attachment.kind === "file") {
    return (
      <span className="flex h-full w-full items-center justify-center rounded border border-border bg-sunken text-muted" aria-hidden>
        <FileText className="h-4 w-4" />
      </span>
    );
  }
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
  const labels = slotLabels(attachment, t, index);
  return (
    <div
      className={`relative flex h-12 shrink-0 flex-col ${attachment.kind === "file" ? "w-auto max-w-[10rem]" : "w-12"}`}
      data-testid="attachment-tile"
      data-status={attachment.status}
      data-kind={attachment.kind}
    >
      <span className={`relative flex h-12 items-center gap-1.5 ${attachment.kind === "file" ? "min-w-0 rounded border border-border bg-sunken pl-1.5 pr-7" : "w-12"}`}>
        <span className={`relative shrink-0 ${attachment.kind === "file" ? "h-8 w-8" : "h-12 w-12"}`}>
          <Thumb attachment={attachment} index={index} />
          {statusBadge(attachment, t, index)}
        </span>
        {attachment.kind === "file" ? (
          <span className="min-w-0 truncate text-[11px] font-semibold text-secondary" title={attachment.name}>{attachment.name}</span>
        ) : null}
      </span>
      {/* Persistent 44px remove target (touch has no hover): a 24px visual chip
          with an inset-inflated hit area. */}
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={labels.remove}
        className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted shadow-1 before:absolute before:-inset-2.5 before:content-[''] hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
      {attachment.status === "error" ? (
        <button
          type="button"
          onClick={() => onRetry(attachment.id)}
          aria-label={labels.retry}
          className="absolute inset-x-0 bottom-0 mx-auto flex h-5 items-center justify-center gap-0.5 rounded-full border border-border bg-card px-1.5 text-[9px] font-bold text-warning before:absolute before:-inset-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <RotateCw className="h-3 w-3" aria-hidden /> {t("img.retry")}
        </button>
      ) : null}
    </div>
  );
}

function DesktopAttachmentTile({ attachment, index, onRemove, onRetry }: { attachment: PendingAttachment; index: number; onRemove: (id: string) => void; onRetry: (id: string) => void }) {
  const { t } = useLocale();
  const labels = slotLabels(attachment, t, index);
  if (attachment.kind === "file") {
    return (
      <div
        className="group/img relative flex h-10 max-w-[12rem] items-center gap-1.5 rounded border border-border bg-sunken pl-1.5 pr-2"
        data-testid="attachment-tile"
        data-status={attachment.status}
        data-kind="file"
      >
        <span className="relative h-6 w-6 shrink-0">
          <Thumb attachment={attachment} index={index} />
          {statusBadge(attachment, t, index)}
        </span>
        <span className="min-w-0 truncate text-[10.5px] font-semibold text-secondary" title={attachment.name}>{attachment.name}</span>
        {attachment.status === "error" ? (
          <button
            type="button"
            onClick={() => onRetry(attachment.id)}
            aria-label={labels.retry}
            className="shrink-0 text-warning focus-visible:outline-none"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          aria-label={labels.remove}
          className="shrink-0 text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <div className="group/img relative h-10 w-10" data-testid="attachment-tile" data-status={attachment.status} data-kind="image">
      <Thumb attachment={attachment} index={index} />
      {statusBadge(attachment, t, index)}
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={labels.remove}
        className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-muted shadow-1 hover:text-danger group-hover/img:flex focus-visible:flex focus-visible:outline-none"
      >
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>
      {attachment.status === "error" ? (
        <button
          type="button"
          onClick={() => onRetry(attachment.id)}
          aria-label={labels.retry}
          className="absolute -bottom-1 left-1/2 flex h-4 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card px-1 text-[8px] font-bold text-warning focus-visible:outline-none"
        >
          <RotateCw className="h-2.5 w-2.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** Hidden file input plus its trigger button, wired to a picker ref it owns
    internally. Shared by the pane composer and the spawn dialog.

    `acceptFiles` drops the `accept="image/*"` filter (issue #1224). That
    attribute is exactly what makes a phone open the photo library and hide the
    Files app, so a composer that can deliver a document must not carry it. */
export function ImagePickerButton({
  onFiles,
  ariaLabel,
  className,
  disabled = false,
  disabledReason,
  acceptFiles = false,
}: {
  onFiles: (files: File[]) => void;
  ariaLabel: string;
  className: string;
  disabled?: boolean;
  disabledReason?: string;
  acceptFiles?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        {...(acceptFiles ? {} : { accept: "image/*" })}
        multiple
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button type="button" aria-label={ariaLabel} title={disabledReason} disabled={disabled} onClick={() => fileRef.current?.click()} className={className}>
        {acceptFiles ? <Paperclip className="h-4 w-4" aria-hidden /> : <ImageIcon className="h-4 w-4" aria-hidden />}
      </button>
    </>
  );
}
