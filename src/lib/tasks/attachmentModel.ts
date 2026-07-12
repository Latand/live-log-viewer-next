/**
 * Pure attachment-ref helpers with no `node:` imports, so they are safe to
 * bundle into client components (draft persistence, composer previews). The
 * filesystem-backed store lives in `attachments.ts` and reuses these.
 */
import { inboxImageExt } from "@/lib/imagePolicy";

import type { TaskAttachment } from "./types";

export const VALID_EXT = new Set<TaskAttachment["ext"]>(["png", "jpg", "gif", "webp"]);

/** Serving mime for a stored extension — the inverse of the upload whitelist. */
export const EXT_MIME: Record<TaskAttachment["ext"], string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function isTaskAttachment(value: unknown): value is TaskAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const att = value as Partial<TaskAttachment>;
  return (
    typeof att.id === "string" &&
    att.id.length > 0 &&
    typeof att.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(att.sha256) &&
    typeof att.ext === "string" &&
    VALID_EXT.has(att.ext as TaskAttachment["ext"]) &&
    typeof att.mime === "string" &&
    inboxImageExt(att.mime) !== null &&
    typeof att.bytes === "number" &&
    Number.isFinite(att.bytes) &&
    att.bytes > 0 &&
    typeof att.createdAt === "string"
  );
}
