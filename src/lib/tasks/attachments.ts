import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";

import { EXT_MIME, VALID_EXT } from "./attachmentModel";
import type { BoardTask, TaskAttachment } from "./types";

export { EXT_MIME, isTaskAttachment } from "./attachmentModel";

/** Content-addressed image store shared by every task and draft. A file is
    named by the sha256 of its bytes, so identical uploads collapse to one file
    and an upload is replay-safe: writing bytes that already exist is a no-op. */
export function attachmentsDir(): string {
  return statePath("attachments", "tasks");
}

/** Absolute path of an attachment's bytes on disk (may not exist yet). */
export function attachmentPath(att: Pick<TaskAttachment, "sha256" | "ext">): string {
  return path.join(attachmentsDir(), `${att.sha256}.${att.ext}`);
}

/** Reads a stored attachment by its content address, confined to the store dir.
    Returns null for an unknown ext or a missing file — a corrupt/absent ref is
    a visible failure at the call site, never a silent empty body. */
export function readAttachment(sha256: string, ext: string): { data: Buffer; mime: string } | null {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !VALID_EXT.has(ext as TaskAttachment["ext"])) return null;
  const filePath = attachmentPath({ sha256, ext: ext as TaskAttachment["ext"] });
  try {
    const data = fs.readFileSync(filePath);
    return { data, mime: EXT_MIME[ext as TaskAttachment["ext"]] };
  } catch {
    return null;
  }
}

export type StoreAttachmentResult =
  | { ok: true; attachment: TaskAttachment }
  | { ok: false; error: string; status: number };

/**
 * Validates raw image bytes against the shared image policy and writes them to
 * the content-addressed store. Identical bytes replay to the identical file
 * (the write is skipped when the target already exists), so a retried upload
 * never duplicates data or corrupts an in-use file.
 */
export function storeAttachment(data: Buffer, mime: string, now: string, id = crypto.randomUUID()): StoreAttachmentResult {
  const ext = inboxImageExt(mime);
  if (ext === null || !VALID_EXT.has(ext as TaskAttachment["ext"])) {
    return { ok: false, error: "unsupported image type", status: 400 };
  }
  if (data.length === 0) return { ok: false, error: "empty image", status: 400 };
  if (data.length > MAX_INBOX_IMAGE_BYTES) return { ok: false, error: "image is too large", status: 413 };

  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const attachment: TaskAttachment = {
    id,
    sha256,
    ext: ext as TaskAttachment["ext"],
    mime,
    bytes: data.length,
    createdAt: now,
  };
  const filePath = attachmentPath(attachment);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    /* Write to a unique temp then rename: a concurrent upload of the same
       bytes can never expose a half-written file under the final name. */
    const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  }
  return { ok: true, attachment };
}

/** Every sha256 any task currently references — the keep-set for the sweep. */
export function referencedShas(tasks: BoardTask[]): Set<string> {
  const shas = new Set<string>();
  for (const task of tasks) {
    for (const att of task.attachments ?? []) shas.add(att.sha256);
  }
  return shas;
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Opportunistic, best-effort cleanup: deletes only store files that no task
 * references AND that are older than the TTL. Referenced files and young files
 * (a just-staged draft attachment not yet committed to a task) are never
 * touched, so a create racing the sweep can't be left with a dangling ref.
 * Never throws — a failed sweep must not break the mutation that triggered it.
 */
export function sweepAttachments(tasks: BoardTask[], nowMs: number, dir = attachmentsDir()): void {
  try {
    const keep = referencedShas(tasks);
    for (const name of fs.readdirSync(dir)) {
      const sha = name.replace(/\.[^.]+$/, "");
      if (keep.has(sha)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (nowMs - stat.mtimeMs < TTL_MS) continue;
        fs.unlinkSync(full);
      } catch {
        /* raced by another sweep or a fresh write — leave it be */
      }
    }
  } catch {
    /* dir absent (nothing stored yet) or unreadable: nothing to sweep */
  }
}
