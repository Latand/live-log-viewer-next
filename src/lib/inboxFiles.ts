import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { attachmentsAreOrphaned, type AttachmentDeliveryOutcome } from "@/lib/attachmentRetention";
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
  /** Decoded once, at admission, and carried from there: the request already
      holds the base64, so decoding it a second time at write time (and
      re-encoding it to compare strings) tripled the peak footprint of a batch
      this process has no spare memory for. */
  data: Buffer;
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

/** Decodes an attachment payload, or null when it is not base64 this can write.
    The charset/length regex bounds the input before `Buffer.from` sees it, so
    what comes back is either real bytes or nothing. */
function decodeAttachment(value: string): Buffer | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const data = Buffer.from(value, "base64");
  return data.length > 0 ? data : null;
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
    const data = decodeAttachment(candidate.base64);
    if (!data) return failure(`${name} could not be read`, 400);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_INBOX_FILES_TOTAL_BYTES) {
      return failure(`attachments exceed the ${attachmentMegabytes(MAX_INBOX_FILES_TOTAL_BYTES)} MB request limit`, 413);
    }
    files.push({ name, data });
  }
  return { files, error: null };
}

/**
 * The directory name one send's attachments share. Derived from the caller's
 * own message id, so a retried delivery lands on the SAME paths rather than
 * orphaning a second copy beside the first — the same reasoning that makes the
 * legacy image path replay its recorded artifacts on retry.
 *
 * The key alone names the batch, while the journal scopes a key by
 * conversation, so one batch can be reached by requests of different
 * conversations and routes (#1652). Every writer therefore stages through
 * `stageInboxFiles`, which never changes a file that is already there.
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

/** The paths one admitted batch lands at, in the order sent, decided before
    anything is written so a caller can fold them into a command and validate it
    first. Every writer below writes exactly these. */
export function inboxFilePaths(files: readonly InboxFileUpload[], token: string): string[] {
  if (!files.length) return [];
  const dir = batchDir(token);
  const used = new Set<string>();
  return files.map((file) => {
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
    return filePath;
  });
}

/** Writes one admitted batch and returns the paths, in the order sent. A write
    that throws mid-batch deletes what it already wrote, so no caller can orphan
    a partial batch (`buildImagePayload`'s contract). A path that already holds
    the same bytes is reused and one that holds other bytes refuses the batch
    with `InboxFileConflictError`, as `stageInboxFiles` explains. */
export function saveInboxFiles(files: readonly InboxFileUpload[], token: string): string[] {
  return stageInboxFiles(files, token).filePaths;
}

/** A path of this batch already holds other bytes: the key it derives from
    belongs to a different request, whose attachment is not this one's to
    replace. */
export class InboxFileConflictError extends Error {}

/* Paths a request created and may still delete on a terminal refusal (#1652).
   A path enters when a staging call creates it. It leaves when its request
   deletes or keeps it, and the moment any other request stages it too: from
   then on a message that request had admitted may name it, so no request may
   delete it. Nothing else can make a path deletable, so a writer that reaches a
   file it did not create can never remove it, whichever route or conversation
   it came from.

   A route that keeps its files without saying so (the legacy
   `/api/conversation-host` send) leaves its entries behind, so the set is
   bounded and forgets its oldest entries first. A refused request whose entry
   was forgotten keeps its bytes, the same result as an uncertain delivery.
   Held on globalThis for the same reason the batch turns are. */
const MAX_DELETABLE_PATHS = 1024;
const deletable: Set<string> = ((globalThis as { __llvInboxDeletablePaths?: Set<string> })
  .__llvInboxDeletablePaths ??= new Set());

function markDeletable(filePath: string): void {
  deletable.delete(filePath);
  deletable.add(filePath);
  while (deletable.size > MAX_DELETABLE_PATHS) deletable.delete(deletable.values().next().value!);
}

export interface StagedInboxFiles {
  filePaths: string[];
  /** The paths THIS call wrote, and so the only ones its caller may release.
      A path that already held the same bytes was written by an earlier attempt
      under the same key, and that attempt may have been admitted. */
  created: string[];
}

/**
 * Writes one admitted batch, without ever changing a file that is already
 * there (#1652). Every writer of the inbox batches goes through here.
 *
 * The batch directory derives from the request's key, so a replay lands on the
 * paths its first attempt wrote, and so does any other request under the same
 * key, from another conversation or route. Rewriting those paths is harmless
 * for identical bytes and destroys an accepted attachment for different ones,
 * and deleting them on a refusal removes a file an admitted message names. Here
 * each file is published by linking a finished temporary copy into place, so a
 * path is either absent or whole; one that already holds the same bytes is
 * reused and reported as not created, and one that holds other bytes refuses
 * the batch. A failure releases only what this call created.
 */
export function stageInboxFiles(files: readonly InboxFileUpload[], token: string): StagedInboxFiles {
  const filePaths = inboxFilePaths(files, token);
  const created: string[] = [];
  if (!filePaths.length) return { filePaths, created };
  const dir = path.dirname(filePaths[0]!);
  try {
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((file, index) => {
      const target = filePaths[index]!;
      const temporary = path.join(dir, `.${crypto.randomUUID()}.partial`);
      fs.writeFileSync(temporary, file.data);
      try {
        fs.linkSync(temporary, target);
        created.push(target);
        markDeletable(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = fs.statSync(target);
        if (existing.size !== file.data.byteLength || !fs.readFileSync(target).equals(file.data)) {
          throw new InboxFileConflictError(`${path.basename(target)} is already attached under this request with different contents`);
        }
        /* Taken up by this request as well, so whoever created it can no
           longer delete it. */
        deletable.delete(target);
      } finally {
        try { fs.unlinkSync(temporary); } catch { /* already gone */ }
      }
    });
  } catch (error) {
    deleteInboxFiles(created);
    throw error;
  }
  return { filePaths, created };
}

/* Held on globalThis so every bundle that loads this module shares one set of
   turns. */
const batchTurns: Map<string, Promise<void>> = ((globalThis as { __llvInboxBatchTurns?: Map<string, Promise<void>> })
  .__llvInboxBatchTurns ??= new Map());

/**
 * Runs one request's stage → admission → release of a replayable batch while no
 * other request under the same batch is doing any of the three (#1652).
 *
 * `created` says which files a request wrote, and it goes stale the moment the
 * request awaits the journal: a second request under the same key finds those
 * bytes, reuses them, and can be admitted first. The first one's refusal then
 * deleted a file an admitted message names. Taking turns per batch means that,
 * while a request may still release what it created, nobody else can be holding
 * those paths. The turn is per process, and the Viewer serves this route from
 * one process. The journal call it waits on is bounded by the runtime client's
 * own timeout, which also bounds how long a waiting request is delayed.
 */
export async function withInboxBatch<T>(token: string, work: () => Promise<T>): Promise<T> {
  const leave = await enterInboxBatch(token);
  try {
    return await work();
  } finally {
    leave();
  }
}

/** `withInboxBatch` for a request whose stage, admission and release do not
    fit one callback: resolves once the batch is this request's turn, with the
    function that ends it. The caller must call it exactly once, after its
    release. */
export async function enterInboxBatch(token: string): Promise<() => void> {
  const previous = batchTurns.get(token);
  let finish!: () => void;
  const turn = new Promise<void>((resolve) => { finish = resolve; });
  const tail = previous ? previous.then(() => turn) : turn;
  batchTurns.set(token, tail);
  if (previous) await previous;
  return () => {
    finish();
    if (batchTurns.get(token) === tail) batchTurns.delete(token);
  };
}

/** Ends one request's claim on the files it staged. A TERMINAL refusal deletes
    the ones it created that no other request has staged since (#1224); any
    other outcome keeps them, and they are nobody's to delete from then on. */
export function settleInboxFiles(staged: StagedInboxFiles, outcome: AttachmentDeliveryOutcome): void {
  if (attachmentsAreOrphaned(outcome)) {
    deleteInboxFiles(staged.created);
    return;
  }
  for (const filePath of staged.created) deletable.delete(filePath);
}

/**
 * Removes attachments written for a delivery that failed before reaching the
 * agent, and the batch directory once it holds nothing — best effort, exactly
 * like `deleteInboxImages`, since a delivery that already succeeded never calls
 * this (the agent still has to open the path it was given).
 *
 * Only a path its request created and nobody else has staged since is removed
 * (#1652): a caller may hand over every path its message names, and one it
 * found already there belongs to a request that may have been admitted.
 */
export function deleteInboxFiles(paths: readonly string[]): void {
  const root = inboxFilesDir();
  const dirs = new Set<string>();
  for (const filePath of paths) {
    if (!deletable.delete(filePath)) continue;
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
    agent for a pasted image. A caller that is refused may hand every path back
    to `deleteInboxFiles`, which removes only the ones this call created. */
export function buildFilePayload(
  text: string,
  files: readonly InboxFileUpload[],
  token: string,
): InboxFilePayloadBundle {
  const filePaths = saveInboxFiles(files, token);
  return { payload: inboxFileText(text, filePaths), filePaths };
}

/** The delivered text for a batch at these paths: the words, then one path per
    line. */
export function inboxFileText(text: string, filePaths: readonly string[]): string {
  return [text, ...filePaths].filter(Boolean).join("\n");
}
