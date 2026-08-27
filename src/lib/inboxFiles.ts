import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  attachmentMegabytes,
  inboxAttachmentName,
  MAX_INBOX_FILE_BYTES,
  MAX_INBOX_FILES,
  MAX_INBOX_FILES_TOTAL_BYTES,
} from "@/lib/filePolicy";
import { inboxDir } from "@/lib/configDir";

/**
 * General (non-image) composer attachments on their way to an agent (issue
 * #1224). They take the road images already take — the bytes land in the viewer
 * inbox and the delivered message names them by path — minus the base64-into-
 * the-turn half, which needs an engine image capability an ordinary file
 * neither has nor wants. An agent opens a file with the tools it already has.
 *
 * Each send owns one batch directory, so the operator's own filename survives
 * as the basename: `…/inbox/files/<batch>/quarterly-notes.pdf` is a path the
 * agent can act on and the operator recognises. The directory is nested, so an
 * inbox name never matches `inboxImageRef` and none of this is servable over
 * /api/inbox.
 */
export function inboxFilesDir(): string {
  return path.join(inboxDir(), "files");
}

export interface InboxFileUpload {
  name: string;
  base64: string;
}

export interface InboxFileAdmissionFailure {
  error: string;
  status: 400 | 413;
}

export interface InboxFileAdmissionResult {
  files: InboxFileUpload[];
  error: InboxFileAdmissionFailure | null;
}

export interface InboxFilePayloadBundle {
  payload: string;
  filePaths: string[];
}

function failure(error: string, status: 400 | 413): InboxFileAdmissionResult {
  return { files: [], error: { error, status } };
}

/** Raw byte count a base64 string decodes to, without decoding it. */
function rawBytesFromBase64(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function canonicalBase64(value: string): Buffer | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const data = Buffer.from(value, "base64");
  return data.length > 0 && data.toString("base64") === value ? data : null;
}

/**
 * Validates a request's `files` field against the shared policy. Every refusal
 * is a message the caller hands back to the operator — an attachment that is
 * not admitted is never quietly dropped from the batch (the defect #1224
 * fixes), so one bad file refuses the whole send with its reason.
 *
 * Size is checked against the ENCODED length first, so an over-budget upload is
 * refused without ever being decoded into memory.
 */
export function admitInboxFilePayload(body: { files?: unknown }): InboxFileAdmissionResult {
  if (body.files === undefined || body.files === null) return { files: [], error: null };
  if (!Array.isArray(body.files)) return failure("files must be an array", 400);
  if (body.files.length > MAX_INBOX_FILES) {
    return failure(`too many files (${MAX_INBOX_FILES} limit)`, 413);
  }

  const files: InboxFileUpload[] = [];
  let totalBytes = 0;
  for (const value of body.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return failure("invalid file", 400);
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.base64 !== "string" || typeof candidate.name !== "string") {
      return failure("invalid file", 400);
    }
    const name = inboxAttachmentName(candidate.name);
    if (rawBytesFromBase64(candidate.base64) > MAX_INBOX_FILE_BYTES) {
      return failure(`${name} is too large (${attachmentMegabytes(MAX_INBOX_FILE_BYTES)} MB limit)`, 413);
    }
    const data = canonicalBase64(candidate.base64);
    if (!data) return failure(`${name} could not be read`, 400);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_INBOX_FILES_TOTAL_BYTES) {
      return failure(`attachments exceed the ${attachmentMegabytes(MAX_INBOX_FILES_TOTAL_BYTES)} MB request limit`, 413);
    }
    files.push({ name, base64: candidate.base64 });
  }
  return { files, error: null };
}

/**
 * The directory name one send's attachments share. Derived from the caller's
 * own message id, so a retried delivery rewrites the SAME paths rather than
 * orphaning a second copy beside the first — the same reasoning that makes the
 * legacy image path replay its recorded artifacts on retry.
 */
export function inboxFileBatchToken(clientMessageId: string | null | undefined): string {
  const seed = clientMessageId?.trim();
  if (!seed) return crypto.randomUUID().slice(0, 12);
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

function batchDir(token: string): string {
  const root = inboxFilesDir();
  const dir = path.resolve(root, inboxAttachmentName(token));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error("inbox batch directory escapes the inbox");
  }
  return dir;
}

/** Writes one admitted batch and returns the paths, in the order sent. A write
    that throws mid-batch deletes what it already wrote, so no caller can orphan
    a partial batch (`buildImagePayload`'s contract). */
export function saveInboxFiles(files: readonly InboxFileUpload[], token: string): string[] {
  if (!files.length) return [];
  const dir = batchDir(token);
  const written: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const used = new Set<string>();
    for (const file of files) {
      const name = inboxAttachmentName(file.name);
      /* Two attachments named the same in ONE send must stay two files, or the
         second silently replaces the first and the message names it twice. */
      let unique = name;
      for (let index = 2; used.has(unique); index += 1) {
        const dot = name.lastIndexOf(".");
        unique = dot > 0 ? `${name.slice(0, dot)}-${index}${name.slice(dot)}` : `${name}-${index}`;
      }
      used.add(unique);
      const filePath = path.resolve(dir, unique);
      if (!filePath.startsWith(dir + path.sep)) throw new Error("inbox attachment escapes the inbox");
      fs.writeFileSync(filePath, Buffer.from(file.base64, "base64"));
      written.push(filePath);
    }
  } catch (error) {
    deleteInboxFiles(written);
    throw error;
  }
  return written;
}

/**
 * Removes attachments written for a delivery that failed before reaching the
 * agent, and the batch directory once it holds nothing — best effort, exactly
 * like `deleteInboxImages`, since a delivery that already succeeded never calls
 * this (the agent still has to open the path it was given).
 */
export function deleteInboxFiles(paths: readonly string[]): void {
  const root = inboxFilesDir();
  const dirs = new Set<string>();
  for (const filePath of paths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone or unwritable: nothing more to clean up */
    }
    dirs.add(path.dirname(filePath));
  }
  for (const dir of dirs) {
    if (dir === root || !dir.startsWith(root + path.sep)) continue;
    try {
      fs.rmdirSync(dir);
    } catch {
      /* the batch still holds something, or is already gone */
    }
  }
}

/** Saves an admitted batch and folds the resulting paths into the delivered
    text, one per line after it — the same shape `buildImagePayload` gives an
    agent for a pasted image. */
export function buildFilePayload(
  text: string,
  files: readonly InboxFileUpload[],
  token: string,
): InboxFilePayloadBundle {
  const filePaths = saveInboxFiles(files, token);
  return { payload: [text, ...filePaths].filter(Boolean).join("\n"), filePaths };
}
